# Cross-origin isolated applications

Web audio applications use `SharedArrayBuffer` to share audio and timing data with AudioWorklets and workers. Browsers only allow it in a **cross-origin isolated** page, which usually means sending two headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Cross-Origin-Opener-Policy: same-origin` puts the page in its own browsing context group. That cuts it off from any top-level window of another origin that opened it or that it opens. Once the other page loads, the `window.open()` reference reports `closed` and `window.opener` is `null`. `windowTransport` needs a live window to post to, so **two top-level pages on different origins cannot connect with `postMessage` when either sends this policy.** Same-origin pages with the same policy keep their references, and iframes are not affected, because a frame stays in its parent's browsing context group.

The protocol itself is unchanged by any of this. A `Peer` runs over any `Transport` with `send(string)` and `listen(callback)`. This page lists the transports that still work and when to use each.

## Check what a page can reach

```js
import { isolationReport, windowReachable } from 'audiobus-protocol'

isolationReport()
// { crossOriginIsolated: true, sharedArrayBuffer: true, opener: false, embedded: false }

const popup = window.open('https://other-app.example/')
const peer = new Peer(windowTransport(popup, 'https://other-app.example'), { identity, timeoutMs: 10000 })
try {
  await peer.connect()
} catch (error) {
  // No answer. windowReachable(popup) is false once opener policy has severed the popup;
  // use another transport below.
}
```

`windowReachable` is a snapshot. A popup can still look open until its page has loaded and its opener policy has applied, so only a completed `connect()` proves the connection.

## Choose a transport

| Situation | Use | Needs |
| --- | --- | --- |
| One application can embed the other | [An iframe](#embed-one-application-in-the-other) with `windowTransport` | Headers on both sides; no install |
| Separate pages, Chromium browsers | [Document-Isolation-Policy](#keep-window-references-with-document-isolation-policy) with `windowTransport` | A header change; no install |
| Separate pages, same computer, browsers with Web MIDI | [A MIDI port](#connect-through-a-midi-port) with `midiTransport` | A loopback MIDI port and SysEx permission |
| Separate pages, any modern browser, any device | [A WebRTC data channel](#connect-with-a-webrtc-data-channel) with `socketTransport` | A handshake code exchange or signalling service, and STUN or TURN servers across networks |
| An installed helper is acceptable | [An extension](#relay-through-a-browser-extension) with `portTransport`, or a [local socket](#connect-to-a-local-or-remote-socket) with `socketTransport` | An extension or a desktop bridge |

## Embed one application in the other

Either application can be the top-level page, and the frame can come from any origin. Both stay isolated and keep `SharedArrayBuffer`.

The top-level page sends the isolation headers and lets the frame be isolated too:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

```html
<iframe id="app" src="https://other-app.example/" allow="cross-origin-isolated; midi; autoplay"></iframe>
<script type="module">
import { Peer, windowTransport } from 'audiobus-protocol'
const frame = document.querySelector('#app')
const peer = new Peer(windowTransport(frame.contentWindow, 'https://other-app.example'), {
  identity: { name: 'Controller', version: '1' },
  timeoutMs: 15000 // initialization repeats until the frame is listening
})
await peer.connect()
</script>
```

The framed application sends `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin`, and must not forbid framing with `X-Frame-Options` or a `frame-ancestors` policy. It connects to `window.parent` with the parent's exact origin, or accepts it as an [unpaired sender](protocol.md#accepting-unpaired-senders).

Without `allow="cross-origin-isolated"`, a cross-origin frame loads but is not isolated, so it loses `SharedArrayBuffer`.

## Keep window references with Document-Isolation-Policy

`Document-Isolation-Policy` isolates a page for `SharedArrayBuffer` without an opener policy, so popups and openers keep working and `windowTransport` connects as usual. Send it **instead of** both the opener and embedder policies:

```http
Document-Isolation-Policy: isolate-and-require-corp
```

`isolate-and-credentialless` is the alternative when cross-origin resources cannot add `Cross-Origin-Resource-Policy`. Chrome added it in version 137 on desktop. Check current support for other browsers and platforms before relying on it. Other browsers ignore the header, so the page is not isolated there. Detect that at start-up with `crossOriginIsolated`, and either run without `SharedArrayBuffer` or offer an isolated build, such as one at a separate path that still sends the two classic headers and connects through an iframe or MIDI.

Do not send `Cross-Origin-Opener-Policy: same-origin` alongside it: that severs window references again.

## Connect through a MIDI port

A virtual MIDI port connects any two pages on one computer, whatever their origins or isolation, in browsers with Web MIDI: Chromium-based browsers and Firefox, but not Safari. Check for `navigator.requestMIDIAccess` first. Musicians often have a port already. Create a loopback port with loopMIDI on Windows, the IAC Driver on macOS, or `snd-virmidi` on Linux, and open it in both applications:

```js
import { Peer, midiTransport, findMidiPort } from 'audiobus-protocol'

const access = await navigator.requestMIDIAccess({ sysex: true })
const port = findMidiPort(access, 'loopMIDI Port') // the input and output share the port's name
const secret = codeInput.value // the same in both applications; see Secure channels below
const peer = new Peer(midiTransport(port.input, port.output, { room: 0, secret }), {
  identity: { name: 'My application', version: '1' },
  registry: commands
})
await peer.connect() // or wait for the other application to connect
```

Every protocol message, MIDI included, travels as non-commercial SysEx, in the [MIDI SysEx framing](protocol.md#midi-sysex-framing). That is why the transport needs the SysEx permission. It works as follows:

- The transport drops its own messages when the loopback port echoes them back.
- It talks to one other sender at a time, and only after a completed handshake. Either this side accepted that sender's `initialize` request, or that sender accepted this side's. Other senders can only offer a new `initialize`, so a reloaded application reconnects by itself. With a [pairing code](protocol.md#pairing-codes-sdk-03), an offer with a wrong code is refused and the current session continues.
- **A port is a shared bus with no sender authentication of its own.** Any software that can use the port can read the traffic and impersonate either side. Pass a [`secret`](#secure-channels) both applications know, and every message is encrypted and authenticated.
- `room` (0–127) lets several pairs of applications share one port; peers only hear their own room.
- Plain MIDI on the port, such as notes or clock from a keyboard routed into it, is ignored unless you pass `acceptPlainMidi: true`. It is then delivered as WebMidiLink `midi,…` messages. The transport never sends plain MIDI, so this cannot echo.
- Senders that have not completed a handshake get only a few small reassembly slots, so junk traffic cannot grow memory.
- Messages are split into frames of 240 data bytes by default (`chunkSize`). A typical command call is one or two frames. Large replies, such as a long `commands.list`, take more frames, but stay fast on a virtual port.

[Try it in two tabs](../examples/midi-port.html).

## Connect with a WebRTC data channel

A data channel connects pages on any origins, on the same or different devices. The two pages first exchange a description of the connection, called signalling. That can be a person copying a code, which suits the pairing-code flow, or any signalling service you already run. Signalling does not make the pages reachable by itself. On one computer or one network they usually connect directly. Across networks they need a STUN server, and behind strict NATs a TURN server, which relays the traffic.

```js
import { Peer, socketTransport } from 'audiobus-protocol'

const connection = new RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.example.org' }, { urls: 'turn:turn.example.org', username, credential }]
})
// Wait for every network candidate, so one code holds the whole description.
const gathered = () => new Promise((resolve, reject) => {
  if (connection.iceGatheringState === 'complete') return resolve()
  const timer = setTimeout(() => reject(new Error('Network discovery timed out')), 10000)
  const check = () => {
    if (connection.iceGatheringState !== 'complete') return
    clearTimeout(timer)
    connection.removeEventListener('icegatheringstatechange', check)
    resolve()
  }
  connection.addEventListener('icegatheringstatechange', check)
})

// In the first application:
const channel = connection.createDataChannel('audiobus') // ordered and reliable by default
await connection.setLocalDescription(await connection.createOffer())
await gathered()
showCode(btoa(JSON.stringify(connection.localDescription))) // the person copies this across
await connection.setRemoteDescription(JSON.parse(atob(await askForAnswerCode())))
const peer = new Peer(socketTransport(channel, { maxMessageSize: connection.sctp?.maxMessageSize }), { identity, registry: commands })

// The second application calls setRemoteDescription with the offer, then createAnswer,
// setLocalDescription and gathered(), shows its own code, and wraps the channel from its
// `datachannel` event the same way.
```

`socketTransport` queues messages until the channel opens, so `connect()` can be called straight away. Data channels limit each message to `sctp.maxMessageSize` bytes, and 65,536 bytes is the default the transport assumes. Longer protocol messages are split into `frag,…` fragments and reassembled by the `socketTransport` on the other side.

## Relay through a browser extension

An extension's content scripts can reach both pages and pass messages between them through the extension, whatever the pages' origins or headers. Hand each page one end of a `MessageChannel`, so the page never listens to arbitrary window messages. The page asks until it gets a port, because the content script may load before or after it:

```js
// Content script, in each page:
let handed = false
window.addEventListener('message', (event) => {
  if (handed || event.source !== window || event.data !== 'audiobus,want-port') return
  handed = true
  const { port1, port2 } = new MessageChannel()
  const relay = chrome.runtime.connect({ name: 'audiobus' })
  port1.onmessage = (message) => relay.postMessage(message.data)
  relay.onMessage.addListener((message) => port1.postMessage(message))
  window.postMessage('audiobus,port', location.origin, [port2])
})

// Page:
import { Peer, portTransport } from 'audiobus-protocol'
let peer
const ask = setInterval(() => window.postMessage('audiobus,want-port', location.origin), 250)
window.addEventListener('message', (event) => {
  if (peer || event.source !== window || event.data !== 'audiobus,port' || !(event.ports[0] instanceof MessagePort)) return
  clearInterval(ask)
  peer = new Peer(portTransport(event.ports[0]), { identity, registry: commands })
})
```

Page scripts can post the same window messages, so the handoff does not prove the port came from the extension. Authorization belongs in the extension's background script, which pairs the two runtime ports and decides which tabs may talk.

## Connect to a local or remote socket

A desktop bridge, such as an Electron build of the application, can listen on a local WebSocket, and a relay server can join pages on different machines:

```js
import { Peer, socketTransport } from 'audiobus-protocol'
const socket = new WebSocket('ws://127.0.0.1:47900/audiobus')
const peer = new Peer(socketTransport(socket), { identity, registry: commands })
await peer.connect()
```

Anything on the machine can open a local socket, so authenticate the connection with a [pairing code](protocol.md#pairing-codes-sdk-03) or a token, and check the `Origin` header on the server. Messages above 65,536 bytes are split into `frag,…` fragments unless you pass `maxMessageSize: Infinity`. A server that relays messages unchanged needs no changes for this.

## Secure channels

Pass a secret both applications know, and the channel is encrypted and authenticated:

```js
import { midiTransport, secureTransport, socketTransport, generatePairingCode } from 'audiobus-protocol'

const secret = generatePairingCode(12) // shown in one application, typed into the other

midiTransport(input, output, { secret })
secureTransport(socketTransport(channel), { secret })   // WebSocket or WebRTC data channel
secureTransport(portTransport(port), { secret })        // extension MessagePort
```

Each side starts with a fresh key pair and sends its public key, then a random nonce for this session. Both combine the two keys, both nonces and the secret into session keys, and prove they hold them before anything else is accepted. A sender with the wrong secret ends up with different keys, so its proof fails and it is ignored. Every message is then sealed with AES-GCM and numbered, so it cannot be read, altered, forged or replayed. The secret itself never crosses the channel. Both sides must use the same transport options; one side with a secret and one without do not connect.

On a shared MIDI port, only an application that proves the secret can take over a session, and only when it starts a connection or accepts one, as a reloaded application does. Several pairs can still share a port with separate rooms or separate secrets.

A program on the channel that starts a handshake gets a proof it can test guesses at the secret against, offline. PBKDF2 slows each guess, but short secrets still fall, so use `generatePairingCode(12)` (60 random bits) or a passphrase of four or more random words. An 8-character code keeps out mistakes and casual listeners, not a determined attacker. The secret protects the channel, not the computer: software that can read the browser's memory or keystrokes can read the secret too. Others on the channel can still see that two applications are talking and how much, and anything that can write to it can disrupt the connection, though not read or forge it. The [README](../README.md#secure-channels-for-isolated-apps) summarises each risk, and the [wire format](protocol.md#secure-channels) is specified for other implementations.

## Security

Origins are not checked on the MIDI, data channel, extension or socket transports, because those channels carry no origin. The channel's owner decides who is on the other end: whoever can use the MIDI port, whoever completed the WebRTC handshake, the extension, or the socket server. Give these channels a [secret](#secure-channels): a Peer pairing code alone travels in the clear inside `initialize`, so it guards against mistakes, not against software listening on the same channel. Give each connection a registry that suits it.
