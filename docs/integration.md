# Application integration

## Shared command registry

Keep handlers in application services. A command palette reads descriptors and calls `registry.call(id, args)`; remote peers invoke the same registry. Do not expose arbitrary DOM selectors or JavaScript evaluation. Use explicit setters such as `transport.setTempo` rather than toggles when remote callers need predictable results. Stable IDs are independent of translated labels, and command schemas document units and ranges.

Suggested application conventions (not mandatory protocol methods): `transport.get`, `transport.start`, `transport.stop`, `transport.setTempo`, `app.panic`, `graph.list`, `graph.addDevice`, `graph.removeDevice`, `graph.connect`, `device.getParameters`, `device.setParameter`, `preset.list`, and `preset.load`. Discover commands before using them: applications may expose different subsets. Publish `transport.changed` for tempo or playback changes, and `commands.changed` if availability changes.

## audioBus

The Harmoneasy/audioBus integration adds `InputProtocol`, input ID `protocol`, and `setProtocolRegistry(registry)`. The Input uses the registered application commands by default, receives WebMidiLink MIDI through audioBus's standard converter, and releases held notes and sustain on disconnect. Multiple inputs can have separate peers while sharing the application registry.

```ts
import InputProtocol from 'audiobus/io/inputs/input-protocol'
import { setProtocolRegistry } from 'audiobus/io/protocol-registry'

setProtocolRegistry(applicationCommands)
const input = new InputProtocol()
input.attach(remoteWindow, 'https://trusted-peer.example')
await input.connect()
// Input commands flow through the ordinary graph routing.
// On teardown: input.destroy()
```

Pairing is explicit. Configure the remote window and its origin with `attach`; reconnect after the remote listener is ready. Creating an Input alone never accepts all message senders. Call `disconnect()` or `destroy()` when closing the connection to release notes and remove listeners. The framework does not bypass browser audio permissions.

## audioBus Output

`OutputProtocol`, output ID `protocol`, sends a chain's transformed MIDI and can discover and invoke destination commands. It shares the application's command registry by default, enabling control in both directions. Its non-React panel supports explicit destination pairing, protocol mode, command discovery, and schema-generated argument forms.

```ts
import OutputProtocol from 'audiobus/io/outputs/output-protocol'

const output = new OutputProtocol()
output.attach(destinationWindow, 'https://trusted-peer.example')
await output.connect()
console.log(await output.discover())
await output.call('transport.setTempo', { bpm: 128 })
output.noteOn(60, 100, 1)
output.noteOff(60, 1)
output.destroy()
```

Use `{mode:'webmidilink'}` for a legacy synth; it skips control initialization and exposes no application commands. Patch helpers `requestPatch()` and `setPatch(data)` work in either mode; replies arrive through audioBus's `EVENT_PROTOCOL_PATCH`. `EVENT_PROTOCOL_EVENT` carries subscribed `{topic,data}` notifications. SysEx is opt-in with `allowSysex:true`. Disconnect sends sustain-off and tracked note-offs before removing listeners.

For desktop IPC or another isolated transport, use `output.attachTransport(transport)`. Custom transports must authorize their peer. See [receiver.html](../examples/receiver.html) for a destination that supports both modes, optional sound, MIDI logs, commands, and patches. Browser audio still requires a local user gesture.

## OpenDAW and other applications

Install the package and implement a registry using that application's own services. Pass it into a `Peer`, then attach a window transport pointing to Harmoneasy's window. No audioBus dependency is necessary. The example named OpenDAW is a simulated integration peer; this repository does not modify OpenDAW or claim that OpenDAW already supports the protocol.

Use a stable window reference from an iframe or popup and an exact configured origin. An embedding host can use `iframe.contentWindow`; an embedded app can use `window.parent`. Install both listeners and coordinate readiness before calling `connect()`. For WebSocket or desktop IPC, supply an authenticated transport implementation instead of relaxing window origin checks.
