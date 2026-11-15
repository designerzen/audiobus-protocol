# audioBus Protocol

Discover and control music applications over a small, symmetric protocol inspired by [WebMidiLink](https://www.g200kg.com/en/docs/webmidilink/spec.html). Each application can expose commands and call the other application's commands. MIDI retains the original WebMidiLink wire format. This is a new protocol, not an MCP server.

**[Documentation and live demos](https://designerzen.github.io/audiobus-protocol/)**

The package has no runtime dependencies. Application state and command handlers belong to the host; the protocol does not depend on audioBus, Harmoneasy, OpenDAW, React, or a DOM.

## Develop and run

Requires Node.js 22+ and npm. From this repository:

```sh
npm install
npm test
npm run example
npm run example:midi2
npm run build:site   # GitHub Pages site in _site/
```

`npm run build` produces JavaScript and TypeScript declarations in `dist/`. Install directly from GitHub with `npm install git+https://github.com/designerzen/audiobus-protocol.git` (pin a commit for reproducible builds), install a local checkout with `npm install ../audiobus-protocol`, or use a workspace dependency. The `prepare` script builds Git installs automatically. This repository is not yet a published npm release.

## Expose a command

```js
import { CommandRegistry, Peer, windowTransport } from 'audiobus-protocol'

const commands = new CommandRegistry()
let bpm = 120
commands.register({
  id: 'transport.setTempo',
  title: 'Set tempo',
  description: 'Set the application tempo in beats per minute',
  inputSchema: {
    type: 'object',
    properties: { bpm: { type: 'number', minimum: 10, maximum: 303 } },
    required: ['bpm'],
    additionalProperties: false
  },
  execute({ bpm: next }) {
    bpm = next
    commands.publish('transport.changed', { bpm })
    return { bpm }
  }
})

// remoteWindow is a specific iframe.contentWindow or popup returned by window.open.
// Choose its exact origin from trusted application configuration.
const peer = new Peer(windowTransport(remoteWindow, 'https://other-app.example'), {
  identity: { name: 'My music application', version: '1.0' },
  registry: commands,
  onEvent: (topic, data) => console.log(topic, data),
  onMidi: bytes => console.log('MIDI', bytes)
})
await peer.connect() // Call after the other application's listener is installed.
console.log(await peer.list())
await peer.subscribe('transport.changed')
await peer.call('transport.setTempo', { bpm: 128 })
// On teardown: peer.close()
```

The receiving peer can call back after the same handshake; it does not need a second connection. `CommandRegistry.list()` and `.call()` also work locally, so a command palette and remote clients can share handlers and validation. Command IDs are stable API names, not translated labels or DOM selectors.

## Examples and integration

- [Two in-memory peers](examples/peers.js): runnable connect → discover → read → subscribe → set → notification exchange, representing Harmoneasy and an OpenDAW integration.
- [MIDI 2 and properties](examples/midi2.js): negotiated UMP, exact high-resolution words, a versioned capability bundle, and property discovery/write/subscription.
- [Two browser windows](examples/browser.html): build first, then serve this repository with your preferred static HTTP server and open `/examples/browser.html`. It requires HTTP(S), not `file://`. This example uses an explicit readiness message before initialization.
- [Harmoneasy remote control](api/remote-control.html): control Harmoneasy without pairing, from notes and pitch bend to any control in its command palette. See [Control Harmoneasy](docs/integration.md#control-harmoneasy).
- [Pairing codes and retained state](examples/pairing.html): a popup that requires a pairing code, and a controller that receives tempo state with its subscription.
- [Example console](api/console.html): runs the in-memory examples in a browser and shows their output.
- [MIDI destination with optional sound](examples/receiver.html): a popup receiver for Harmoneasy's Protocol Output, with explicit origin pairing, tempo commands, panic, MIDI logging, and Level 1 patches.
- [Wire protocol](docs/protocol.md): framing, lifecycle, methods, errors, and compatibility.
- [Application integration](docs/integration.md): audioBus Input, Output and command palette patterns.

Only explicitly paired peers should receive a transport. `windowTransport` requires an exact origin and checks both `event.source` and `event.origin`; it never accepts a wildcard. Origin validation establishes which application is connected, not which commands it should be allowed to execute: expose a registry appropriate to that connection. When the peer window was not chosen by your application, such as `window.opener`, require a pairing code shown to the person (`generatePairingCode()`, `requirePairingCode`, `pairingCode`); see [pairing codes](docs/protocol.md#pairing-codes-sdk-03). Hosts that let people opt in to control without pairing should follow [accepting unpaired senders](docs/protocol.md#accepting-unpaired-senders). Commands requiring a browser user gesture may still require local interaction.

## Initial scope

Package 0.3 adds pairing codes for peers whose window was not chosen by the application, and retained topic state: `registry.retain(topic, read)` lets `peer.subscribeState(topic)` receive current state atomically with the subscription. Wire protocol version 1 is unchanged and older peers interoperate unless a pairing code is required.

Package 0.2 adds negotiated UMP, discoverable scalar properties and application-defined capability bundles while retaining wire protocol version 1 and older peers. Opt in with `ump:true` on both Peers and provide `onUmp` at receiving endpoints. `sendUmp()` sends one packet as unsigned 32-bit words, preserving MIDI 2 precision; it rejects unless both peers advertised UMP. Byte MIDI remains unchanged. No implicit MIDI 1 conversion takes place in the SDK.

`registry.registerProperty()` describes a scalar using its schema, title, unit, getter and optional setter. Clients use `peer.listProperties()`, `getProperty(id)`, and `setProperty(id,value)`. Subscribe to `properties.changed` for `{id,value}` updates and `properties.listChanged` for metadata changes. Hosts call `registry.notifyProperty(id)` after local state changes. Writes validate the value, recheck dynamic writability, invoke the host setter, read back actual state and publish it. `registerBundle()` groups required commands and properties under a namespaced ID and integer version; clients use `peer.listBundles()`.

These properties and bundles are inspired by MIDI-CI Property Exchange and Profiles; they are application protocol features, not a MIDI-CI implementation or standardized MIDI Profiles. Actual MIDI-CI framing, identity, chunking and resource adapters are not implemented. UMP timing messages can be transported unchanged, but are not interpreted as browser scheduling instructions; there is no clock synchronization or sample-accurate scheduler.

The original commands, scalar argument validation, exact-topic subscriptions, timeouts and WebMidiLink patch exchange remain available. `peer.discover()` validates command metadata; `peer.list()` returns raw JSON. Initialization retries every 250 ms until its timeout; other requests are never retried. Graph edits, device parameters, presets and transport commands belong to the host. No network server, persistence or actual OpenDAW integration is included. A timed-out write or command may already have executed.
