import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandRegistry,
  Peer,
  EMPTY_SCHEMA,
  decodeMidi,
  windowTransport,
  parseCommandDescriptors,
  generatePairingCode,
  formatPairingCode,
  normalizePairingCode,
  MAX_PAIRING_ATTEMPTS,
} from "../dist/index.js";

function pair(options = {}, remote = {}) {
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
  const b = new Peer(transports[1], {
    identity: { name: "OpenDAW example", version: "test" },
    ...remote,
  });
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

test("pairing codes are random, unambiguous and compared without case or separators", () => {
  const code = generatePairingCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.notEqual(generatePairingCode(), code);
  assert.equal(formatPairingCode("abcd2345"), "ABCD-2345");
  assert.equal(normalizePairingCode(" ab-cd 23 45 "), "ABCD2345");
  assert.throws(
    () => new Peer({ send() {}, listen: () => () => {} }, { identity: { name: "x", version: "1" }, requirePairingCode: "--" }),
    /letters or digits/,
  );
});
test("a peer requiring a pairing code ignores everything but a matching initialize", async () => {
  const received = [],
    authorized = [];
  const p = pair(
    {},
    {
      requirePairingCode: "ABCD-2345",
      onMidi: (bytes) => received.push([...bytes]),
      getPatch: () => "secret",
      onAuthorized: () => authorized.push(true),
    },
  );
  p.b.registry.register({
    id: "app.name",
    title: "Name",
    description: "",
    inputSchema: EMPTY_SCHEMA,
    execute: () => "B",
  });
  const patches = [];
  try {
    await assert.rejects(p.a.connect(), { code: "unauthorized" });
    p.transports[0].send("midi,90,3c,64");
    p.transports[0].send("link,reqpatch");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(received, []);
    assert.equal(p.b.isAuthorized, false);
    // A requiring peer may initialize the other side first; inbound requests stay blocked.
    await p.b.connect();
    await assert.rejects(p.a.call("app.name"), { code: "unauthorized" });
    p.a.close();
    const a = new Peer(p.transports[0], {
      identity: { name: "Harmoneasy", version: "test" },
      pairingCode: "abcd 2345",
      onPatch: (patch) => patches.push(patch),
    });
    try {
      await a.connect();
      assert.equal(p.b.isAuthorized, true);
      assert.deepEqual(authorized, [true]);
      assert.equal(await a.call("app.name"), "B");
      a.sendMidi([0x90, 60, 100]);
      a.requestPatch();
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.deepEqual(received, [[0x90, 60, 100]]);
      assert.deepEqual(patches, ["secret"]);
      await a.connect();
      assert.deepEqual(authorized, [true]);
    } finally {
      a.close();
    }
  } finally {
    p.close();
  }
});
test("repeated incorrect pairing codes lock the peer until it is replaced", async () => {
  const p = pair({}, { requirePairingCode: "ABCD2345" });
  const peers = [];
  const attempt = (pairingCode) => {
    const peer = new Peer(p.transports[0], {
      identity: { name: "Guess", version: "1" },
      pairingCode,
    });
    peers.push(peer);
    return peer.connect().finally(() => peer.close());
  };
  try {
    p.a.close();
    for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i++) {
      await assert.rejects(attempt(`WRONG${i}`), { message: "Incorrect or missing pairing code" });
    }
    await assert.rejects(attempt("ABCD2345"), { message: /Too many incorrect pairing codes/ });
    assert.equal(p.b.isAuthorized, false);
  } finally {
    peers.forEach((peer) => peer.close());
    p.close();
  }
});
test("subscriptions return retained state captured with the subscription", async () => {
  const events = [],
    p = pair({ onEvent: (topic, data) => events.push([topic, data]) });
  let bpm = 120;
  const release = p.b.registry.retain("transport.changed", () => ({ bpm }));
  assert.throws(() => p.b.registry.retain("transport.changed", () => null), /Duplicate/);
  p.b.registry.retain("broken.state", () => {
    throw Error("secret");
  });
  p.b.registry.retain("async.state", async () => 1);
  try {
    await p.a.connect();
    assert.equal(p.a.supports("retained"), true);
    assert.deepEqual(await p.a.subscribeState("transport.changed"), {
      retained: true,
      state: { bpm: 120 },
    });
    assert.deepEqual(await p.a.subscribe("transport.changed"), {
      topic: "transport.changed",
      subscribed: true,
      state: { bpm: 120 },
    });
    bpm = 128;
    p.b.registry.publish("transport.changed", { bpm });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, [["transport.changed", { bpm: 128 }]]);
    assert.deepEqual(await p.a.subscribeState("other.topic"), { retained: false });
    await assert.rejects(p.a.subscribe("broken.state"), { code: "internal_error" });
    await assert.rejects(p.a.subscribe("async.state"), { code: "invalid_result" });
    p.b.registry.publish("broken.state", 1);
    p.b.registry.publish("async.state", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(events.length, 1);
    release();
    assert.deepEqual(await p.a.subscribeState("transport.changed"), { retained: false });
  } finally {
    p.close();
  }
});

test("retained state is replied before any event published while it is captured", async () => {
  const frames = [],
    p = pair();
  p.transports[0].listen((message) => frames.push(message));
  let bpm = 1;
  p.b.registry.retain("transport.changed", () => {
    // A change scheduled during capture must reach the client after the state reply.
    queueMicrotask(() => {
      bpm = 2;
      p.b.registry.publish("transport.changed", { bpm });
    });
    return { bpm };
  });
  try {
    await p.a.connect();
    assert.deepEqual(await p.a.subscribeState("transport.changed"), {
      retained: true,
      state: { bpm: 1 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reply = frames.findIndex((frame) => frame.includes("%22state%22"));
    const event = frames.findIndex((frame) => frame.startsWith("control,event,"));
    assert.ok(reply >= 0 && event > reply, "state reply precedes the later event");
  } finally {
    p.close();
  }
});
test("oversized retained state rejects the subscription without recording it", async () => {
  const events = [],
    p = pair({ onEvent: (topic, data) => events.push([topic, data]) });
  p.b.registry.retain("large", () => "x".repeat(300000));
  try {
    await p.a.connect();
    await assert.rejects(p.a.subscribe("large"), { code: "message_too_large" });
    p.b.registry.publish("large", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, []);
  } finally {
    p.close();
  }
});
test("an unauthorized peer receives no events and gets unauthorized before initialization", async () => {
  const events = [],
    replies = [];
  const p = pair(
    {},
    {
      requirePairingCode: "ABCD2345",
      onEvent: (topic, data) => events.push([topic, data]),
      onAuthorized: () => {
        throw Error("application bug");
      },
    },
  );
  p.transports[0].listen((message) => replies.push(message));
  try {
    p.transports[0].send(
      `control,request,${encodeURIComponent(JSON.stringify({ id: "x", method: "commands.list", params: {} }))}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(replies.some((frame) => decodeURIComponent(frame).includes('"code":"unauthorized"')));
    // b initializes a and subscribes there; a's events must not reach b before pairing.
    await p.b.connect();
    await p.b.subscribe("transport.changed");
    p.a.registry.publish("transport.changed", { bpm: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(events, []);
    p.a.close();
    const a = new Peer(p.transports[0], {
      identity: { name: "Harmoneasy", version: "test" },
      pairingCode: "ABCD2345",
    });
    try {
      // A throwing onAuthorized callback must not fail the accepted handshake.
      await a.connect();
      assert.equal(p.b.isAuthorized, true);
    } finally {
      a.close();
    }
  } finally {
    p.close();
  }
});
