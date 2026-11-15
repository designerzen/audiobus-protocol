import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandRegistry,
  Peer,
  EMPTY_SCHEMA,
  decodeMidi,
  windowTransport,
  parseCommandDescriptors,
} from "../dist/index.js";

function pair(options = {}) {
  const listeners = [new Set(), new Set()];
  const transports = [0, 1].map((i) => ({
    send: (message) => {
      queueMicrotask(() => listeners[1 - i].forEach((fn) => fn(message)));
    },
    listen: (fn) => {
      listeners[i].add(fn);
      return () => listeners[i].delete(fn);
    },
  }));
  const a = new Peer(transports[0], {
    identity: { name: "Harmoneasy", version: "test" },
    ...options,
  });
  const b = new Peer(transports[1], { identity: { name: "OpenDAW example", version: "test" } });
  return {
    a,
    b,
    transports,
    close: () => {
      a.close();
      b.close();
    },
  };
}
test("discovery, validated tempo calls, subscriptions and symmetric control", async () => {
  const events = [],
    p = pair({ onEvent: (topic, data) => events.push([topic, data]) });
  let bpm = 120;
  p.b.registry.register({
    id: "transport.setTempo",
    title: "Set tempo",
    description: "Set BPM",
    inputSchema: {
      type: "object",
      properties: { bpm: { type: "number", minimum: 10, maximum: 303 } },
      required: ["bpm"],
      additionalProperties: false,
    },
    execute: (args) => {
      bpm = args.bpm;
      p.b.registry.publish("transport.changed", { bpm });
      return { bpm };
    },
  });
  p.a.registry.register({
    id: "app.name",
    title: "Name",
    description: "Application name",
    inputSchema: EMPTY_SCHEMA,
    execute: () => "Harmoneasy",
  });
  try {
    assert.equal((await p.a.connect()).protocolVersion, 1);
    assert.equal((await p.a.list())[0].id, "transport.setTempo");
    await p.a.subscribe("transport.changed");
    assert.deepEqual(await p.a.call("transport.setTempo", { bpm: 128 }), { bpm: 128 });
    assert.deepEqual(events, [["transport.changed", { bpm: 128 }]]);
    assert.equal(await p.b.call("app.name"), "Harmoneasy");
    for (const args of [{}, { bpm: 0 }, { bpm: "128" }, { bpm: 128, extra: true }]) {
      await assert.rejects(p.a.call("transport.setTempo", args), { code: "invalid_params" });
    }
    assert.equal(bpm, 128);
    await p.a.unsubscribe("transport.changed");
    await p.a.call("transport.setTempo", { bpm: 130 });
    assert.equal(events.length, 1);
    await assert.rejects(p.a.call("missing"), { code: "unknown_command" });
  } finally {
    p.close();
  }
});
test("unavailable commands and errors do not leak application exceptions", async () => {
  const p = pair();
  p.b.registry.register({
    id: "private",
    title: "Private",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    available: () => false,
    execute: () => null,
  });
  p.b.registry.register({
    id: "broken",
    title: "Broken",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => {
      throw Error("secret");
    },
  });
  try {
    await p.a.connect();
    assert.equal((await p.a.list())[0].available, false);
    await assert.rejects(p.a.call("private"), { code: "unavailable" });
    await assert.rejects(p.a.call("broken"), { code: "internal_error", message: "Command failed" });
  } finally {
    p.close();
  }
});
test("version negotiation rejects incompatible peers", async () => {
  const p = pair();
  try {
    await assert.rejects(
      p.a.request("initialize", { protocolVersion: 2, name: "x", version: "1" }),
      { code: "unsupported_version" },
    );
  } finally {
    p.close();
  }
});
test("timeouts, malformed messages and close cleanup", async () => {
  const p = pair({ timeoutMs: 15 });
  await assert.rejects(p.a.call("x"), { code: "not_initialized" });
  p.b.close();
  const pending = p.a.connect();
  p.transports[1].send("control,response,%bad");
  p.transports[1].send("control,response,%7B%22id%22%3A%221%22%7D");
  await assert.rejects(pending, { code: "timeout" });
  const closing = p.a.connect();
  p.a.close();
  await assert.rejects(closing, { code: "closed" });
  await assert.rejects(p.a.connect(), { code: "closed" });
  p.close();
});
test("WebMidiLink MIDI and patch compatibility", async () => {
  const received = [],
    p = pair({
      onMidi: (bytes) => received.push([...bytes]),
      getPatch: () => "abc",
      setPatch: (x) => received.push(x),
    });
  try {
    p.b.sendMidi([0x90, 60, 100]);
    p.transports[1].send("midi,90,ff,64");
    p.transports[1].send("link,setpatch,xyz");
    await new Promise((resolve) => queueMicrotask(resolve));
    assert.deepEqual(received, [[0x90, 60, 100], "xyz"]);
    for (const message of ["midi,90,3c", "midi,3c,64", "midi,90,3c,64,80,3c,00", "midi,f0,90,f7"])
      assert.equal(decodeMidi(message), undefined);
    assert.deepEqual([...decodeMidi("midi,f0,01,02,f7")], [240, 1, 2, 247]);
    assert.throws(() => p.b.sendMidi([0x90, 300, 1]), { code: "invalid_midi" });
  } finally {
    p.close();
  }
});
test("window transport filters source and origin and removes listener", () => {
  let listener,
    removed = false;
  const sent = [],
    received = [],
    target = { postMessage: (...args) => sent.push(args) };
  const host = {
    addEventListener: (_, fn) => (listener = fn),
    removeEventListener: (_, fn) => {
      removed = fn === listener;
    },
  };
  const transport = windowTransport(target, "https://peer.example", host);
  const off = transport.listen((value) => received.push(value));
  listener({ source: {}, origin: "https://peer.example", data: "wrong window" });
  listener({ source: target, origin: "https://evil.example", data: "wrong origin" });
  listener({ source: target, origin: "https://peer.example", data: "ok" });
  transport.send("hello");
  off();
  assert.deepEqual(received, ["ok"]);
  assert.deepEqual(sent, [["hello", "https://peer.example"]]);
  assert.equal(removed, true);
  assert.throws(() => windowTransport(target, "*", host));
});

test("rejects oversized calls and invalid application results without hanging", async () => {
  const p = pair();
  p.b.registry.register({
    id: "invalid",
    title: "Invalid",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => undefined,
  });
  p.b.registry.register({
    id: "oversized",
    title: "Oversized",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => "x".repeat(300000),
  });
  try {
    await p.a.connect();
    await assert.rejects(p.a.call("invalid"), { code: "invalid_result" });
    await assert.rejects(p.a.call("oversized"), { code: "message_too_large" });
    await assert.rejects(p.a.call("missing", { payload: "x".repeat(300000) }), {
      code: "message_too_large",
    });
    assert.throws(() => p.a.registry.publish("bad", NaN), { code: "invalid_result" });
    assert.deepEqual(await p.a.list(), await p.b.registry.list());
  } finally {
    p.close();
  }
});

test("bounds subscriptions and permits idempotent resubscription", async () => {
  const p = pair();
  try {
    await p.a.connect();
    for (let i = 0; i < 128; i++) await p.a.subscribe(`topic.${i}`);
    await p.a.subscribe("topic.0");
    await assert.rejects(p.a.subscribe("topic.128"), { code: "limit_exceeded" });
    await p.a.unsubscribe("topic.0");
    await p.a.subscribe("topic.128");
    await assert.rejects(p.a.subscribe(""), { code: "invalid_params" });
  } finally {
    p.close();
  }
});

test("responds to legacy Level 1 patch requests", async () => {
  const p = pair({ getPatch: () => "encoded-patch" }),
    messages = [];
  const off = p.transports[1].listen((message) => messages.push(message));
  try {
    p.transports[1].send("link,reqpatch");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(messages, ["link,patch,encoded-patch"]);
  } finally {
    off();
    p.close();
  }
});

test("typed discovery validates metadata used to build remote controls", async () => {
  const p = pair();
  p.b.registry.register({
    id: "valid",
    title: "Valid",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => null,
  });
  try {
    await p.a.connect();
    assert.equal((await p.a.discover())[0].id, "valid");
    const valid = p.b.registry.list()[0];
    for (const value of [
      null,
      {},
      [{ ...valid, available: "yes" }],
      [valid, valid],
      [{ ...valid, inputSchema: { ...EMPTY_SCHEMA, properties: { x: { type: "function" } } } }],
      [{ ...valid, inputSchema: { ...EMPTY_SCHEMA, required: ["missing"] } }],
    ]) {
      assert.throws(() => parseCommandDescriptors(value), { code: "invalid_result" });
    }
  } finally {
    p.close();
  }
});

test("initialization tolerates a listener installed after the first request", async () => {
  const listeners = [new Set(), new Set()],
    frames = [];
  const transport = (index) => ({
    send: (message) => {
      if (!index) frames.push(message);
      queueMicrotask(() => listeners[1 - index].forEach((fn) => fn(message)));
    },
    listen: (fn) => {
      listeners[index].add(fn);
      return () => listeners[index].delete(fn);
    },
  });
  const a = new Peer(transport(0), { identity: { name: "First", version: "1" }, timeoutMs: 1200 });
  let b;
  try {
    const connecting = a.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    b = new Peer(transport(1), { identity: { name: "Late", version: "1" } });
    assert.equal((await connecting).name, "Late");
    assert.ok(frames.length >= 2);
    assert.equal(new Set(frames).size, 1);
  } finally {
    a.close();
    b?.close();
  }
});

test("Level 1 sender helpers validate patches and signal readiness", async () => {
  const received = [],
    p = pair({ onReady: () => received.push("ready"), setPatch: (patch) => received.push(patch) });
  try {
    p.b.announceReady();
    p.b.setPatch("valid-patch");
    assert.throws(() => p.b.setPatch("bad,patch"), { code: "invalid_params" });
    p.transports[1].send("link,setpatch,bad,patch");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, ["ready", "valid-patch"]);
    p.b.close();
    assert.throws(() => p.b.requestPatch(), { code: "closed" });
  } finally {
    p.close();
  }
});
