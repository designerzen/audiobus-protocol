import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandRegistry,
  Peer,
  midiTransport,
  portTransport,
  secureTransport,
  normalizeSecret,
} from "../dist/index.js";

const SECRET = "ABCD-EFGH-JKLM";

/** A loopback MIDI port that also records every frame, as any other software on it could. */
function loopbackPort() {
  const inputs = new Set();
  const frames = [];
  const broadcast = (bytes) =>
    queueMicrotask(() => inputs.forEach((each) => each.forEach((fn) => fn({ data: bytes }))));
  const port = () => {
    const listeners = new Set();
    inputs.add(listeners);
    return {
      input: {
        addEventListener: (_type, fn) => listeners.add(fn),
        removeEventListener: (_type, fn) => listeners.delete(fn),
      },
      output: {
        send: (data) => {
          const bytes = Uint8Array.from(data);
          frames.push(bytes);
          broadcast(bytes);
        },
      },
    };
  };
  return { port, frames, replay: (bytes) => broadcast(bytes) };
}
const counter = () => {
  const registry = new CommandRegistry();
  const state = { calls: 0 };
  registry.register({
    id: "count",
    title: "Count",
    description: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => ++state.calls,
  });
  return { registry, state };
};
const securePeer = (port, secret, options = {}, transportOptions = {}) =>
  new Peer(midiTransport(port.input, port.output, { secret, ...transportOptions }), {
    identity: { name: options.name ?? "peer", version: "1" },
    timeoutMs: 5000,
    ...options,
  });
const text = (frames) => frames.map((frame) => String.fromCharCode(...frame)).join("");
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("peers sharing a secret connect over a MIDI port, and listeners see no plaintext", async () => {
  const bus = loopbackPort();
  const { registry, state } = counter();
  const notes = [];
  const host = securePeer(bus.port(), SECRET, { registry, onMidi: (bytes) => notes.push([...bytes]) });
  // The secret is compared like a pairing code: case and separators do not matter.
  const remote = securePeer(bus.port(), "abcd efgh jklm");
  try {
    assert.equal((await remote.connect()).name, "peer");
    assert.equal(await remote.call("count"), 1);
    remote.sendMidi([0x90, 60, 100]);
    await settle();
    assert.deepEqual(notes, [[0x90, 60, 100]]);
    assert.equal(state.calls, 1);
    // Packing hides ASCII too, so check the unpacked text of every frame.
    const { unpackSysex } = await import("../dist/index.js");
    const seen = bus.frames.map((frame) => new TextDecoder().decode(unpackSysex(frame.subarray(16, -1)) ?? new Uint8Array())).join("");
    assert.match(seen, /secure,hello/);
    assert.doesNotMatch(seen, /initialize|count|midi,|control,/);
    assert.doesNotMatch(text(bus.frames), /initialize|count/);
  } finally {
    host.close();
    remote.close();
  }
});

test("a wrong secret cannot connect, inject, replay or take over", async () => {
  const bus = loopbackPort();
  const { registry, state } = counter();
  const host = securePeer(bus.port(), SECRET, { registry });
  const remote = securePeer(bus.port(), SECRET);
  const intruder = securePeer(bus.port(), "WRONG-SECRET", { timeoutMs: 1000 });
  try {
    await remote.connect();
    const before = bus.frames.length;
    assert.equal(await remote.call("count"), 1);
    // Replaying the recorded call, from the remote's own sender ID, runs nothing.
    for (const frame of bus.frames.slice(before)) bus.replay(frame);
    await settle();
    assert.equal(state.calls, 1);
    await assert.rejects(intruder.connect(), /timed out|timeout/i);
    assert.equal(state.calls, 1);
    // The paired remote is still the one the host follows.
    assert.equal(await remote.call("count"), 2);
  } finally {
    host.close();
    remote.close();
    intruder.close();
  }
});

test("a reloaded application that knows the secret takes over with a new initialize", async () => {
  const bus = loopbackPort();
  const { registry } = counter();
  const host = securePeer(bus.port(), SECRET, { registry });
  const remote = securePeer(bus.port(), SECRET);
  let reloaded;
  try {
    await remote.connect();
    assert.equal(await remote.call("count"), 1);
    remote.close({ notify: false });
    reloaded = securePeer(bus.port(), SECRET);
    await reloaded.connect();
    assert.equal(await reloaded.call("count"), 2);
    // The host can also start a connection to the application listening.
    const host2 = securePeer(bus.port(), SECRET, { registry: new CommandRegistry() }, { room: 4 });
    const listener = securePeer(bus.port(), SECRET, { registry }, { room: 4 });
    assert.equal((await host2.connect()).name, "peer");
    assert.equal(await host2.call("count"), 3);
    host2.close();
    listener.close();
  } finally {
    host.close();
    remote.close();
    reloaded?.close();
  }
});

test("secureTransport protects a point-to-point channel and drops unencrypted messages", async () => {
  const { port1, port2 } = new MessageChannel();
  const { registry, state } = counter();
  const host = new Peer(secureTransport(portTransport(port1), { secret: SECRET }), {
    identity: { name: "host", version: "1" },
    registry,
    timeoutMs: 5000,
  });
  const remote = new Peer(secureTransport(portTransport(port2), { secret: SECRET }), {
    identity: { name: "remote", version: "1" },
    timeoutMs: 5000,
  });
  try {
    assert.equal((await remote.connect()).name, "host");
    assert.equal(await remote.call("count"), 1);
    // Something else posting to the host's port in the clear is ignored.
    port2.postMessage(`control,request,${encodeURIComponent(JSON.stringify({ id: "x", method: "commands.call", params: { command: "count", arguments: {} } }))}`);
    await settle();
    assert.equal(state.calls, 1);
  } finally {
    host.close();
    remote.close();
    port1.close();
    port2.close();
  }
});

test("secrets are normalized like pairing codes and must not be empty", () => {
  assert.equal(normalizeSecret(" abcd-efgh_jk.lm "), "ABCDEFGHJKLM");
  const port = loopbackPort().port();
  assert.throws(() => midiTransport(port.input, port.output, { secret: " - " }), /secret/);
  assert.throws(() => secureTransport(portTransport(new MessageChannel().port1), { secret: "" }), /secret/);
});

test("a recorded session replayed under a new sender ID runs nothing and gets no reply", async () => {
  const bus = loopbackPort();
  const { registry, state } = counter();
  const hostPort = bus.port();
  const host = securePeer(hostPort, SECRET, { registry });
  const remote = securePeer(bus.port(), SECRET);
  try {
    await remote.connect();
    assert.equal(await remote.call("count"), 1);
    await settle();
    const sender = (frame) => frame.subarray(6, 10).join(".");
    const hostId = sender(bus.frames[0]);
    const recorded = bus.frames.filter((frame) => sender(frame) !== hostId);
    const before = bus.frames.length;
    remote.close({ notify: false });
    for (const frame of recorded) {
      const copy = Uint8Array.from(frame);
      copy.set([1, 2, 3, 4], 6);
      bus.replay(copy);
      await settle();
    }
    await settle();
    assert.equal(state.calls, 1);
    // The host started a fresh handshake, but sent no data: the replayed proof did not match.
    const { unpackSysex } = await import("../dist/index.js");
    const sent = bus.frames.slice(before).filter((frame) => sender(frame) === hostId);
    const texts = sent.map((frame) => new TextDecoder().decode(unpackSysex(frame.subarray(16, -1))));
    assert.ok(texts.some((text) => text.startsWith("secure,nonce,")));
    assert.ok(!texts.some((text) => text.startsWith("secure,data,")));
  } finally {
    host.close();
    remote.close();
  }
});

test("a forged proof does not cancel a handshake", async () => {
  const { packSysex, unpackSysex } = await import("../dist/index.js");
  const bus = loopbackPort();
  const { registry } = counter();
  const host = securePeer(bus.port(), SECRET, { registry });
  const remotePort = bus.port();
  // Just before the remote's real proof, a forged one arrives from the remote's own sender ID.
  const send = remotePort.output.send;
  remotePort.output.send = (data) => {
    const text = new TextDecoder().decode(unpackSysex(data.subarray(16, -1)));
    if (text.startsWith("secure,confirm,")) {
      const forged = text.slice(0, text.lastIndexOf(",") + 1) + "A".repeat(43);
      const header = Array.from(data.subarray(0, 16));
      header.splice(10, 2, 0x7f, 0x7f); // a sequence number of its own
      send([...header, ...packSysex(new TextEncoder().encode(forged)), 0xf7]);
    }
    send(data);
  };
  const remote = securePeer(remotePort, SECRET);
  try {
    await remote.connect();
    assert.equal(await remote.call("count"), 1);
  } finally {
    host.close();
    remote.close();
  }
});
