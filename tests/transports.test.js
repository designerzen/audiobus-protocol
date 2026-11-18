import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandRegistry,
  Peer,
  midiTransport,
  portTransport,
  socketTransport,
  packSysex,
  unpackSysex,
  findMidiPort,
  isolationReport,
  windowReachable,
  MAX_QUEUED_MESSAGES,
  SYSEX_MANUFACTURER,
} from "../dist/index.js";

const tempo = (registry, state = { bpm: 120 }) =>
  registry.register({
    id: "transport.setTempo",
    title: "Set tempo",
    description: "",
    inputSchema: {
      type: "object",
      properties: { bpm: { type: "number", minimum: 10, maximum: 303 } },
      required: ["bpm"],
      additionalProperties: false,
    },
    execute: ({ bpm }) => ((state.bpm = bpm), { bpm }),
  });

/** A loopback MIDI port: everything sent reaches every input, the sender's own included. */
function loopbackPort() {
  const inputs = new Set();
  const frames = [];
  const port = () => {
    const listeners = new Set();
    const input = {
      addEventListener: (_type, fn) => listeners.add(fn),
      removeEventListener: (_type, fn) => listeners.delete(fn),
    };
    inputs.add(listeners);
    const output = {
      send: (data) => {
        frames.push(data);
        const bytes = Uint8Array.from(data);
        queueMicrotask(() =>
          inputs.forEach((each) => each.forEach((fn) => fn({ data: bytes }))),
        );
      },
    };
    return { input, output };
  };
  const plain = (bytes) =>
    queueMicrotask(() =>
      inputs.forEach((each) => each.forEach((fn) => fn({ data: Uint8Array.from(bytes) }))),
    );
  return { port, frames, plain };
}
const peerOn = (port, options = {}, transportOptions = {}) =>
  new Peer(midiTransport(port.input, port.output, transportOptions), {
    identity: { name: options.name ?? "peer", version: "1" },
    timeoutMs: 200,
    ...options,
  });

test("7-bit packing round-trips every byte value", () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 37) & 255);
  const packed = packSysex(bytes);
  assert.ok(packed.every((byte) => byte <= 0x7f));
  assert.deepEqual(unpackSysex(packed), bytes);
  assert.equal(unpackSysex([0x80, 1]), undefined);
});

test("two peers on one loopback MIDI port connect, call, ignore echoes and exchange MIDI", async () => {
  const bus = loopbackPort();
  const registry = new CommandRegistry();
  const state = { bpm: 120 };
  tempo(registry, state);
  const notes = [];
  const echoes = [];
  const host = peerOn(bus.port(), {
    name: "isolated app",
    registry,
    onMidi: (bytes) => echoes.push([...bytes]),
  });
  const remote = peerOn(bus.port(), { name: "controller", onMidi: (bytes) => notes.push([...bytes]) });
  try {
    const identity = await remote.connect();
    assert.equal(identity.name, "isolated app");
    assert.deepEqual(await remote.call("transport.setTempo", { bpm: 128 }), { bpm: 128 });
    assert.equal(state.bpm, 128);
    host.sendMidi([0x90, 60, 100]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(notes, [[0x90, 60, 100]]);
    // The host heard its own frame on the loopback input and dropped it.
    assert.deepEqual(echoes, []);
    // Everything travels as non-commercial SysEx, never as plain MIDI.
    assert.ok(bus.frames.every((frame) => frame[0] === 0xf0 && frame[1] === SYSEX_MANUFACTURER));
  } finally {
    host.close();
    remote.close();
  }
});

test("large and non-ASCII messages are split into frames and reassembled", async () => {
  const bus = loopbackPort();
  const registry = new CommandRegistry();
  const big = "♪ é ".repeat(4000);
  registry.register({
    id: "big",
    title: "Big",
    description: "",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => big,
  });
  const host = peerOn(bus.port(), { registry });
  const remote = peerOn(bus.port(), {}, { chunkSize: 64 });
  try {
    await remote.connect();
    assert.equal(await remote.call("big"), big);
    assert.ok(bus.frames.length > 100);
    assert.ok(bus.frames.every((frame) => frame.every((byte, index) => index === 0 || index === frame.length - 1 || byte <= 0x7f)));
  } finally {
    host.close();
    remote.close();
  }
});

test("rooms separate pairs, and a reloaded peer takes over with a new initialize", async () => {
  const bus = loopbackPort();
  const make = (bpm) => {
    const registry = new CommandRegistry();
    registry.register({
      id: "bpm",
      title: "BPM",
      description: "",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => bpm,
    });
    return registry;
  };
  const first = peerOn(bus.port(), { registry: make(100) }, { room: 1 });
  const second = peerOn(bus.port(), { registry: make(140) }, { room: 2 });
  const remote = peerOn(bus.port(), {}, { room: 2 });
  try {
    await remote.connect();
    assert.equal(await remote.call("bpm"), 140);
    // The controller reloads: its replacement has a new sender ID and initializes again.
    remote.close({ notify: false });
    const reloaded = peerOn(bus.port(), {}, { room: 2 });
    await reloaded.connect();
    assert.equal(await reloaded.call("bpm"), 140);
    reloaded.close();
  } finally {
    first.close();
    second.close();
    remote.close();
  }
  assert.throws(() => midiTransport(bus.port().input, bus.port().output, { room: 128 }), /room/);
});

test("plain MIDI from other devices is delivered only when accepted", async () => {
  const bus = loopbackPort();
  const heard = [];
  const ignoring = peerOn(bus.port(), { onMidi: (bytes) => heard.push(["ignoring", ...bytes]) });
  const accepting = peerOn(
    bus.port(),
    { onMidi: (bytes) => heard.push(["accepting", ...bytes]) },
    { acceptPlainMidi: true },
  );
  bus.plain([0x90, 64, 90]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(heard, [["accepting", 0x90, 64, 90]]);
  ignoring.close();
  accepting.close();
});

test("a port transport connects peers over a MessageChannel", async () => {
  const channel = new MessageChannel();
  const registry = new CommandRegistry();
  tempo(registry);
  const host = new Peer(portTransport(channel.port1), { identity: { name: "host", version: "1" }, registry });
  const remote = new Peer(portTransport(channel.port2), { identity: { name: "remote", version: "1" } });
  try {
    await remote.connect();
    assert.deepEqual(await remote.call("transport.setTempo", { bpm: 90 }), { bpm: 90 });
  } finally {
    host.close();
    remote.close();
    channel.port1.close();
  }
});

test("a socket transport queues until the socket opens and refuses a closed one", () => {
  const listeners = new Map();
  const sent = [];
  const socket = {
    readyState: 0,
    send: (message) => sent.push(message),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
  };
  const transport = socketTransport(socket);
  transport.send("a");
  transport.send("b");
  assert.deepEqual(sent, []);
  socket.readyState = 1;
  listeners.get("open")({ data: null });
  assert.deepEqual(sent, ["a", "b"]);
  transport.send("c");
  assert.deepEqual(sent, ["a", "b", "c"]);
  socket.readyState = "closed";
  assert.throws(() => transport.send("d"), /closed/);
  socket.readyState = 0;
  const full = socketTransport(socket);
  for (let index = 0; index < MAX_QUEUED_MESSAGES; index++) full.send(String(index));
  assert.throws(() => full.send("overflow"), /connecting/);
});

test("finds a loopback port by name and reports isolation", () => {
  const port = { name: "loopMIDI Port" };
  const access = {
    inputs: new Map([["1", { ...port, addEventListener() {}, removeEventListener() {} }]]),
    outputs: new Map([["2", { ...port, send() {} }]]),
  };
  assert.ok(findMidiPort(access, "loopMIDI Port"));
  assert.equal(findMidiPort(access, "Missing"), undefined);
  const report = isolationReport({ crossOriginIsolated: true, SharedArrayBuffer, opener: null, window: 1, parent: 1 });
  assert.deepEqual(report, { crossOriginIsolated: true, sharedArrayBuffer: true, opener: false, embedded: false });
  assert.equal(windowReachable({ closed: true }), false);
  assert.equal(windowReachable({ closed: false }), true);
  assert.equal(windowReachable(null), false);
});

/** A raw SysEx frame in the audioBus framing, for injecting traffic from other senders. */
function rawFrame({ sender = [1, 2, 3, 4], sequence = 0, index = 0, last = true, room = 0, payload }) {
  return [0xf0, 0x7d, 0x61, 0x42, 1, room, ...sender, (sequence >> 7) & 127, sequence & 127, (index >> 14) & 127, (index >> 7) & 127, index & 127, last ? 1 : 0, ...payload, 0xf7];
}
const packed = (text) => packSysex(new TextEncoder().encode(text));
const control = (kind, body) => `control,${kind},${encodeURIComponent(JSON.stringify(body))}`;

test("a second sender cannot take over a paired MIDI session with a wrong code", async () => {
  const bus = loopbackPort();
  const registry = new CommandRegistry();
  const state = { bpm: 120 };
  tempo(registry, state);
  const host = peerOn(bus.port(), { registry, requirePairingCode: "ABCD2345" });
  const remote = peerOn(bus.port(), { pairingCode: "ABCD2345" });
  try {
    await remote.connect();
    const attacker = bus.port();
    for (const [sequence, body] of [
      [0, { id: "x-1", method: "initialize", params: { protocolVersion: 1, name: "x", version: "1", pairingCode: "WRONG" } }],
      [1, { id: "x-2", method: "commands.call", params: { command: "transport.setTempo", arguments: { bpm: 10 } } }],
    ]) {
      attacker.output.send(rawFrame({ sender: [9, 9, 9, 9], sequence, payload: packed(control("request", body)) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(state.bpm, 120);
    // The paired controller is still followed.
    assert.deepEqual(await remote.call("transport.setTempo", { bpm: 99 }), { bpm: 99 });
  } finally {
    host.close();
    remote.close();
  }
});

test("unrelated traffic first does not block a handshake, and fake senders stay bounded", async () => {
  const bus = loopbackPort();
  const registry = new CommandRegistry();
  tempo(registry);
  const noise = bus.port();
  const host = peerOn(bus.port(), { registry });
  const remote = peerOn(bus.port());
  try {
    noise.output.send(rawFrame({ sender: [5, 5, 5, 5], payload: packed("irrelevant") }));
    // Many senders each start a message and never finish it.
    for (let index = 0; index < 2000; index++) {
      noise.output.send(rawFrame({ sender: [index >> 7, index & 127, 1, 1], last: false, payload: packed("x".repeat(100)) }));
    }
    // An oversized frame from another implementation is dropped, not thrown.
    noise.output.send(rawFrame({ sender: [6, 6, 6, 6], payload: new Array(900000).fill(1) }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await remote.connect();
    assert.deepEqual(await remote.call("transport.setTempo", { bpm: 77 }), { bpm: 77 });
    // A host that initiates also connects.
    const host2 = peerOn(bus.port(), { registry: new CommandRegistry() }, { room: 3 });
    const remote2 = peerOn(bus.port(), { registry }, { room: 3 });
    assert.equal((await host2.connect()).name, "peer");
    host2.close();
    remote2.close();
  } finally {
    host.close();
    remote.close();
  }
});

test("plain clock and transport MIDI is accepted with acceptPlainMidi", async () => {
  const bus = loopbackPort();
  const heard = [];
  const peer = peerOn(bus.port(), { onMidi: (bytes) => heard.push([...bytes]) }, { acceptPlainMidi: true });
  for (const message of [[0xf8], [0xfa], [0xf2, 0, 8], [0xfc], [0x90, 60]]) bus.plain(message);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(heard, [[0xf8], [0xfa], [0xf2, 0, 8], [0xfc]]);
  peer.close();
});

test("SysEx unpacking rejects data packing cannot produce, and options are validated", () => {
  assert.equal(unpackSysex([127, 0]), undefined);
  assert.equal(unpackSysex([0, -1]), undefined);
  assert.equal(unpackSysex([0, 1.5]), undefined);
  assert.equal(unpackSysex([0]), undefined);
  const { input, output } = loopbackPort().port();
  for (const chunkSize of [NaN, Infinity, 4, 1e6, 10.5]) {
    assert.throws(() => midiTransport(input, output, { chunkSize }), /chunkSize/);
  }
  assert.throws(() => socketTransport({ send() {}, addEventListener() {}, removeEventListener() {} }, { maxMessageSize: NaN }), /maxMessageSize/);
});

/** A fake socket whose open event runs listeners in registration order. */
function fakeSocket(readyState = 0) {
  const listeners = { open: [], message: [] };
  const sent = [];
  const socket = {
    readyState,
    send: (message) => sent.push(message),
    addEventListener: (type, fn) => listeners[type].push(fn),
    removeEventListener: (type, fn) => (listeners[type] = listeners[type].filter((each) => each !== fn)),
    open() {
      socket.readyState = 1;
      [...listeners.open].forEach((fn) => fn({ data: null }));
    },
    deliver: (data) => [...listeners.message].forEach((fn) => fn({ data })),
  };
  return { socket, sent, listeners };
}

test("a socket keeps order when an earlier open listener sends, and survives one failed send", () => {
  const { socket, sent } = fakeSocket();
  let transport;
  socket.addEventListener("open", () => transport.send("new"));
  transport = socketTransport(socket);
  transport.listen(() => {});
  transport.send("old-1");
  transport.send("old-2");
  socket.open();
  assert.deepEqual(sent, ["old-1", "old-2", "new"]);
  const failing = fakeSocket();
  const original = failing.socket.send;
  failing.socket.send = (message) => {
    if (message === "bad") throw new Error("too big");
    original(message);
  };
  const second = socketTransport(failing.socket);
  for (const message of ["good", "bad", "after"]) second.send(message);
  failing.socket.open();
  assert.deepEqual(failing.sent, ["good", "after"]);
});

test("closing the peer discards a socket's queue", () => {
  const { socket, sent, listeners } = fakeSocket();
  const peer = new Peer(socketTransport(socket), { identity: { name: "p", version: "1" }, timeoutMs: 20 });
  const connecting = peer.connect().catch((error) => error.code);
  peer.close();
  socket.open();
  assert.deepEqual(sent, []);
  assert.equal(listeners.open.length, 0);
  return connecting.then((code) => assert.equal(code, "closed"));
});

test("a socket splits messages above its size limit and reassembles them", async () => {
  const a = fakeSocket(1), b = fakeSocket(1);
  a.socket.send = (message) => { a.sent.push(message); queueMicrotask(() => b.socket.deliver(message)); };
  b.socket.send = (message) => { b.sent.push(message); queueMicrotask(() => a.socket.deliver(message)); };
  const registry = new CommandRegistry();
  const big = "🎹 notes ".repeat(5000);
  registry.register({ id: "big", title: "Big", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: () => big });
  const host = new Peer(socketTransport(a.socket, { maxMessageSize: 1024 }), { identity: { name: "host", version: "1" }, registry });
  const remote = new Peer(socketTransport(b.socket, { maxMessageSize: 1024 }), { identity: { name: "remote", version: "1" } });
  await remote.connect();
  assert.equal(await remote.call("big"), big);
  assert.ok(a.sent.every((message) => new TextEncoder().encode(message).length <= 1024));
  assert.ok(a.sent.some((message) => message.startsWith("frag,")));
  host.close();
  remote.close();
});
