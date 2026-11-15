import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Peer,
  CommandRegistry,
  EMPTY_SCHEMA,
  encodeUmp,
  decodeUmp,
  isUmpPacket,
} from "../dist/index.js";

function pair(left = {}, right = {}) {
  const listeners = [new Set(), new Set()];
  const transport = (index) => ({
    send: (message) => queueMicrotask(() => listeners[1 - index].forEach((fn) => fn(message))),
    listen: (fn) => {
      listeners[index].add(fn);
      return () => listeners[index].delete(fn);
    },
  });
  const a = new Peer(transport(0), { identity: { name: "A", version: "1" }, ...left });
  const b = new Peer(transport(1), { identity: { name: "B", version: "1" }, ...right });
  return {
    a,
    b,
    sendToB: transport(0).send,
    close: () => {
      a.close();
      b.close();
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("UMP framing preserves unsigned words and requires exactly one complete packet", () => {
  for (const words of [
    [0x20903c64],
    [0x43913c00, 0xabcd0000],
    [0xb0000000, 1, 2],
    [0xf0000000, 1, 2, 0xffffffff],
  ]) {
    assert.equal(isUmpPacket(words), true);
    assert.deepEqual(decodeUmp(encodeUmp(words)), words);
  }
  for (const words of [[], [0x40903c00], [0x20903c64, 0], [-1], [0x100000000], [1.5]])
    assert.equal(isUmpPacket(words), false);
  for (const message of ["ump,40903c00", "ump,40903c00,xyz", "ump,20903c64,00000000", "ump,903c64"])
    assert.equal(decodeUmp(message), undefined);
});
test("UMP is negotiated in both directions and never silently sent to a legacy peer", async () => {
  const received = [],
    p = pair(
      { ump: true, onUmp: (words) => received.push(words) },
      { ump: true, onUmp: (words) => received.push(words) },
    );
  try {
    assert.throws(() => p.a.sendUmp([0x40903c00, 0xffff0000]), { code: "unsupported_capability" });
    await p.a.connect();
    assert.equal(p.a.supports("ump"), true);
    assert.equal(p.b.supports("ump"), true);
    p.a.sendUmp([0x43913c00, 0xabcd0000]);
    p.b.sendUmp([0x43a13c00, 0x12345678]);
    p.sendToB("ump,40903c00");
    await flush();
    assert.deepEqual(received, [
      [0x43913c00, 0xabcd0000],
      [0x43a13c00, 0x12345678],
    ]);
    assert.throws(() => p.a.sendUmp([0x40903c00]), { code: "invalid_ump" });
  } finally {
    p.close();
  }
});
test("old initialization without capabilities keeps the original byte-MIDI path", async () => {
  const midi = [],
    p = pair({ ump: true, onMidi: (bytes) => midi.push([...bytes]) });
  try {
    await p.b.request("initialize", { protocolVersion: 1, name: "Legacy", version: "1" });
    assert.equal(p.a.supports("ump"), false);
    await assert.rejects(p.a.listProperties(), { code: "unsupported_capability" });
    p.b.sendMidi([0x90, 60, 100]);
    await flush();
    assert.deepEqual(midi, [[0x90, 60, 100]]);
  } finally {
    p.close();
  }
});
test("properties discover units and ranges, validate writes, and emit actual values", async () => {
  const registry = new CommandRegistry(),
    events = [];
  let bpm = 120,
    writable = true;
  const remove = registry.registerProperty({
    id: "transport.tempo",
    title: "Tempo",
    description: "BPM",
    unit: "BPM",
    schema: { type: "number", minimum: 10, maximum: 303 },
    get: () => bpm,
    set: (value) => {
      bpm = Math.round(value);
    },
    writable: () => writable,
  });
  const p = pair({ onEvent: (topic, value) => events.push([topic, value]) }, { registry });
  try {
    await p.a.connect();
    assert.equal((await p.a.listProperties())[0].unit, "BPM");
    assert.equal(await p.a.getProperty("transport.tempo"), 120);
    await p.a.subscribe("properties.changed");
    assert.equal(await p.a.setProperty("transport.tempo", 128.4), 128);
    assert.deepEqual(events, [["properties.changed", { id: "transport.tempo", value: 128 }]]);
    for (const value of [0, "128", { bpm: 128 }, null])
      await assert.rejects(p.a.setProperty("transport.tempo", value), { code: "invalid_params" });
    writable = false;
    assert.equal((await p.a.listProperties())[0].readOnly, true);
    await assert.rejects(p.a.setProperty("transport.tempo", 130), { code: "read_only" });
    bpm = 140;
    await registry.notifyProperty("transport.tempo");
    await flush();
    assert.deepEqual(events.at(-1), ["properties.changed", { id: "transport.tempo", value: 140 }]);
    remove();
    await assert.rejects(p.a.getProperty("transport.tempo"), { code: "unknown_property" });
  } finally {
    p.close();
  }
});
test("application capability bundles name a versioned contract and disappear when incomplete", async () => {
  const registry = new CommandRegistry();
  const remove = registry.register({
    id: "transport.start",
    title: "Start",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => null,
  });
  registry.registerProperty({
    id: "transport.running",
    title: "Running",
    description: "",
    schema: { type: "boolean" },
    get: () => false,
  });
  const bundle = {
    id: "org.audiobus.transport",
    version: 1,
    commands: ["transport.start"],
    properties: ["transport.running"],
  };
  registry.registerBundle(bundle);
  bundle.commands.push("mutation");
  const p = pair({}, { registry });
  try {
    await p.a.connect();
    assert.deepEqual((await p.a.listBundles())[0].commands, ["transport.start"]);
    await assert.rejects(p.a.setProperty("transport.running", true), { code: "read_only" });
    remove();
    assert.deepEqual(await p.a.listBundles(), []);
    assert.throws(
      () =>
        registry.registerBundle({ ...bundle, id: "org.audiobus.missing", commands: ["missing"] }),
      /Register/,
    );
  } finally {
    p.close();
  }
});
