import { Peer, CommandRegistry, EMPTY_SCHEMA } from "../dist/index.js";

const listeners = [new Set(), new Set()];
const transport = (index) => ({
  send: (message) =>
    queueMicrotask(() => listeners[1 - index].forEach((receive) => receive(message))),
  listen: (receive) => {
    listeners[index].add(receive);
    return () => listeners[index].delete(receive);
  },
});
const registry = new CommandRegistry();
let bpm = 120;
registry.register({
  id: "transport.get",
  title: "Read transport",
  description: "Read BPM",
  inputSchema: EMPTY_SCHEMA,
  execute: () => ({ bpm }),
});
registry.registerProperty({
  id: "transport.tempo",
  title: "Tempo",
  description: "Beats per minute",
  unit: "BPM",
  schema: { type: "number", minimum: 10, maximum: 303 },
  get: () => bpm,
  set: (value) => {
    bpm = value;
  },
});
registry.registerBundle({
  id: "org.audiobus.demo",
  version: 1,
  commands: ["transport.get"],
  properties: ["transport.tempo"],
});
const source = new Peer(transport(0), {
  identity: { name: "Source", version: "1" },
  ump: true,
  onEvent: (topic, data) => console.log(topic, data),
});
const destination = new Peer(transport(1), {
  identity: { name: "Destination", version: "1" },
  ump: true,
  registry,
  onUmp: (words) =>
    console.log(
      "UMP words:",
      words.map((word) => word.toString(16).padStart(8, "0")),
    ),
});
try {
  await source.connect();
  console.log("Negotiated UMP:", source.supports("ump"));
  console.log("Bundles:", await source.listBundles());
  console.log("Properties:", await source.listProperties());
  await source.subscribe("properties.changed");
  console.log("Tempo:", await source.setProperty("transport.tempo", 128));
  // Group 3, channel 2, note 60, exact 16-bit velocity and attribute data.
  source.sendUmp([0x43913c00, 0xabcd1234]);
  // Per-note assignable controller, retaining the full unsigned 32-bit value.
  source.sendUmp([0x43113c01, 0xdeadbeef]);
  source.sendUmp([0x43813c00, 0]);
  await new Promise((resolve) => setTimeout(resolve, 0));
} finally {
  source.close();
  destination.close();
}
