# audioBus Protocol

Discover and control music applications over a small, symmetric protocol inspired by [WebMidiLink](https://www.g200kg.com/en/docs/webmidilink/spec.html). Each application can expose commands and call the other application's commands. MIDI retains the original WebMidiLink wire format. This is a new protocol, not an MCP server.

The package has no runtime dependencies. Application state and command handlers belong to the host; the protocol does not depend on audioBus, Harmoneasy, OpenDAW, React, or a DOM.

## Develop and run

Requires Node.js 22+ and npm. From this repository:

```sh
npm install
npm test
npm run example
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
- [Two browser windows](examples/browser.html): build first, then serve this repository with your preferred static HTTP server and open `/examples/browser.html`. It requires HTTP(S), not `file://`. This example uses an explicit readiness message before initialization.
- [MIDI destination with optional sound](examples/receiver.html): a popup receiver for Harmoneasy's Protocol Output, with explicit origin pairing, tempo commands, panic, MIDI logging, and Level 1 patches.
- [Wire protocol](docs/protocol.md): framing, lifecycle, methods, errors, and compatibility.
- [Application integration](docs/integration.md): audioBus Input, Output and command palette patterns.

Only explicitly paired peers should receive a transport. `windowTransport` requires an exact origin and checks both `event.source` and `event.origin`; it never accepts a wildcard. Origin validation establishes which application is connected, not which commands it should be allowed to execute: expose a registry appropriate to that connection. Commands requiring a browser user gesture may still require local interaction.

## Initial scope

Version 1 supports command discovery and calls, scalar argument validation, exact-topic subscriptions, timeouts, and WebMidiLink MIDI/optional patch exchange. `peer.discover()` validates remote descriptors before a client builds controls; `peer.list()` remains the raw discovery response. Graph edits, device parameters, presets, and transport commands are registered by applications, not hardcoded into the protocol. Initialization is retried every 250 ms until its timeout, allowing listeners to load; application commands are never retried. No network server, persistence, sample-accurate scheduling, or actual OpenDAW integration is included. A command timeout can occur after that command has already executed.
