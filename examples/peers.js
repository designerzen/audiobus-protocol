// Runnable two-application exchange, using an in-memory transport instead of windows.
import { CommandRegistry, EMPTY_SCHEMA, Peer } from "../dist/index.js";
const listeners = [new Set(), new Set()];
const transport = (i) => ({
  send: (message) => queueMicrotask(() => listeners[1 - i].forEach((receive) => receive(message))),
  listen: (receive) => {
    listeners[i].add(receive);
    return () => listeners[i].delete(receive);
  },
});
const registry = new CommandRegistry();
let bpm = 120;
registry.register({
  id: "transport.get",
  title: "Read transport",
  description: "Read current BPM",
  inputSchema: EMPTY_SCHEMA,
  execute: () => ({ bpm }),
});
registry.register({
  id: "transport.setTempo",
  title: "Set tempo",
  description: "Set beats per minute",
  inputSchema: {
    type: "object",
    properties: { bpm: { type: "number", minimum: 10, maximum: 303 } },
    required: ["bpm"],
    additionalProperties: false,
  },
  execute: (args) => {
    bpm = args.bpm;
    registry.publish("transport.changed", { bpm });
    return { bpm };
  },
});
const harmoneasy = new Peer(transport(0), {
  identity: { name: "Harmoneasy example", version: "1" },
  registry,
});
// This represents an OpenDAW-side integration; it does not import or modify OpenDAW.
const opendaw = new Peer(transport(1), {
  identity: { name: "OpenDAW example", version: "1" },
  onEvent: (topic, state) => console.log(topic, state),
});
try {
  console.log("Connected:", await opendaw.connect());
  console.log("Commands:", await opendaw.list());
  console.log("Before:", await opendaw.call("transport.get"));
  await opendaw.subscribe("transport.changed");
  console.log("After:", await opendaw.call("transport.setTempo", { bpm: 128 }));
} finally {
  harmoneasy.close();
  opendaw.close();
}
