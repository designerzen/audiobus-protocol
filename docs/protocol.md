# Wire protocol version 1

## Transport and framing

Each transport message is a single string. The default browser transport uses `window.postMessage`; custom transports implement `send(string)` and `listen(callback) → unsubscribe`. Transport implementations must isolate one authorized peer and preserve message order. A `Peer` owns its listener and subscriptions, not the underlying window. The SDK also provides `portTransport` (MessagePort, BroadcastChannel), `socketTransport` (WebSocket, RTCDataChannel) and `midiTransport` (Web MIDI SysEx) for applications that cannot reach each other's windows, such as cross-origin isolated pages; see [cross-origin isolated applications](isolation.md).

### MIDI SysEx framing

`midiTransport` carries each protocol message, plain MIDI included, as one or more non-commercial SysEx messages, so a peer can recognise its own echoes on a loopback port and tell senders apart:

```text
F0 7D 61 42 <version> <room> <sender×4> <sequence×2> <index×3> <flags> <payload…> F7
```

| Field | Bytes | Meaning |
| --- | --- | --- |
| `7D` | 1 | Non-commercial manufacturer ID |
| `61 42` | 2 | Signature, ASCII `aB` |
| version | 1 | Framing version, `01` |
| room | 1 | 0–127; peers ignore other rooms |
| sender | 4 | Random 7-bit bytes chosen per transport; frames with the receiver's own sender are echoes |
| sequence | 2 | Message number, 14 bits, most significant first, wrapping |
| index | 3 | Frame number within the message, 21 bits, starting at 0 |
| flags | 1 | Bit 0 set on the message's last frame |
| payload | any | Part of the message's UTF-8 bytes, packed into 7-bit data bytes |

Packing splits the UTF-8 bytes into groups of up to seven. Each group is sent as one byte holding the group's high bits (bit *n* is the high bit of byte *n*), followed by the group's bytes with their high bits cleared. The packed stream is cut into frames of at most 240 bytes by default. A receiver concatenates the payloads of frames with consecutive indexes from one sender and sequence, unpacks them on the last frame, and drops the message on any gap, on invalid UTF-8, or when it exceeds the message limit. It talks to one other sender, chosen by a completed handshake: the receiver accepted that sender's `initialize` request, or that sender accepted the receiver's. Until then, other senders' messages are ignored unless they are `initialize` requests or answers to the receiver's own, and their reassembly is limited to a few small messages. `bye` from the followed sender ends the session.

`socketTransport` sends each protocol message as one socket message when it fits within `maxMessageSize` bytes, 65,536 by default. Longer messages are sent as `frag,<id>,<index>,<last>,<text>` fragments. Here `id` numbers the message, `index` counts from 0, `last` is `1` on the final fragment, and `text` is the next part of the message, never splitting a surrogate pair. The receiver joins consecutive fragments of one message and drops it on any gap or when it exceeds the message limit.

Control messages are `control,<kind>,<payload>`, where kind is `request`, `response`, `event` or `bye` and payload is `encodeURIComponent(JSON.stringify(body))`. Decode exactly once. Encoded payloads contain no literal commas. Maximum total message length is 262,144 JavaScript UTF-16 code units; larger messages are rejected on send and ignored on receipt. Unknown prefixes, malformed frames, and malformed responses are ignored. Control framing is an audioBus extension, not part of WebMidiLink.

Decoded examples:

```json
{"id":"1","method":"initialize","params":{"protocolVersion":1,"name":"Harmoneasy","version":"0.19"}}
{"id":"1","result":{"protocolVersion":1,"name":"Other application","version":"1","capabilities":["commands","events","webmidilink"],"maxMessageLength":262144}}
{"id":"2","method":"commands.call","params":{"command":"transport.setTempo","arguments":{"bpm":128}}}
{"id":"2","result":{"bpm":128}}
{"id":"3","error":{"code":"unknown_command","message":"Unknown command: missing"}}
{"topic":"transport.changed","data":{"bpm":128}}
```

IDs are strings, unique among requests pending in the same direction. The SDK prefixes each ID with a random per-Peer token (`3f9a1c7b2d40-2`), so a reply to a request from an earlier Peer on the same transport can never resolve a request from its replacement. Responses echo IDs and have exactly one of `result` or `error`. Results and event data must be JSON values; return `null` for commands with no result. Internal exceptions become `internal_error` without exposing exception text. A peer must not send functions, circular objects, undefined, non-finite numbers, or other non-JSON results.

## Lifecycle

Install listeners on both sides, then call `connect()` on either side after application readiness. It sends `initialize`. Both sides must agree on the exact integer protocol version; version 1 rejects other versions with `unsupported_version`. The response returns application identity, capabilities, and the message limit. Successful initialization enables control in both directions. Application versions do not determine protocol compatibility. Repeated initialization of the same connection is allowed and does not clear subscriptions.

The SDK does not discover windows automatically. A host can provide an exact window and origin, or accept incoming windows as separate sessions as audioBus does by default (below). A reload creates a new application session: close the old peer, release its input notes, create a new peer and initialize again. Close rejects outstanding local requests and removes local listeners and subscriptions. On current `main`, `close()` also sends `control,bye,%7B%7D` to an initialized peer, unless called with `{ notify: false }`; the receiver forgets the sender's subscriptions, fails its own pending requests with `closed`, and calls `onClosed`, where a host releases notes held for that connection. Close has no wire acknowledgement and cannot cancel a command already executing remotely. Remote disappearance is detected through request timeouts or application lifecycle signals, not heartbeats.

### Pairing codes (SDK 0.3)

A window transport proves which window and origin sent a message, not that a person intended the connection. When a peer's window was not chosen by its own application, such as `window.opener` or an embedding parent, show a code generated with `generatePairingCode()` and construct the Peer with `requirePairingCode`. The other application's person enters it, and that Peer passes it as `pairingCode`. `initialize` then carries `pairingCode`; comparison ignores case, spaces and dashes.

Until a matching code arrives, the requiring peer ignores `midi`, `ump` and `link` messages and rejects every request except `initialize` with `unauthorized`. This holds even after the requiring peer has initialized the other side itself, so a peer cannot gain access by waiting to be initialized. After `MAX_PAIRING_ATTEMPTS` (5) failed initializations, retried copies included, the peer rejects all codes until it is replaced; generate a new code when pairing again. Inbound events are also ignored until then. `peer.isAuthorized` and `onAuthorized` report acceptance. Legacy WebMidiLink senders never initialize, so they cannot present a code. Codes are short-lived proof of a person's intent, not a secret for an untrusted transport: they travel inside the authorized window channel.

### Accepting unpaired senders

A host may accept control from any window without pairing. HarmonEasy's audioBus Protocol Input listens this way by default; pairing is optional in advanced settings. The SDK has no wildcard transport; the host listens for `message` events itself and creates one Peer per sending window, with a transport whose `send` posts only to that window and that event's exact origin. Hosts doing this should:

- document the acceptance policy; audioBus listens by default and offers optional pairing in advanced settings;
- ignore messages without a source window or with an empty or `null` origin, since replies could only be broadcast with `*`;
- start a fresh session, releasing its held notes, when a known window's origin changes;
- cap the number of sessions and free the slots of closed windows;
- route each session's MIDI through its own note tracking, so closing one session releases only its notes;
- allocate sessions for valid `initialize` requests or valid legacy MIDI (`decodeMidi(message)`), never malformed frames; expire incomplete initialization attempts without requiring legacy senders to initialize;
- end the session on `bye`, through `onClosed`;
- run one listener for the whole application when several Inputs accept unpaired control, so each application command executes once per request.

The sender connects with an ordinary `windowTransport` to the host window and its origin; no pairing code is involved.

## Methods

| Method | Arguments | Result |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `name`, `version` | negotiated version, identity, capabilities, limit |
| `commands.list` | `{}` | command descriptors |
| `commands.call` | `command`, `arguments` | command result |
| `events.subscribe` | `topic` | `{topic, subscribed:true}`, plus `state` for retained topics |
| `events.unsubscribe` | `topic` | `{topic, subscribed:false}` |

Descriptors contain `id`, `title`, `description`, `inputSchema`, and current `available`. Availability is checked again at execution. The input schema supports object properties of type string, boolean, finite number, or integer; optional enum, numeric minimum/maximum, required properties, and `additionalProperties:false`. This is a bounded JSON Schema subset, not a complete JSON Schema validator. Nested objects and arrays as command arguments are reserved for a later version. Results and events may contain arbitrary JSON trees.

Topics are exact strings of 1–200 characters, with at most 128 subscriptions per connection. Repeated subscriptions are idempotent; there are no wildcards. Hosts may retain a topic with `registry.retain(topic, read)`; the subscribe result then includes `state`, read synchronously and sent in the same task as the subscription is recorded. Every later change arrives as an event after that response, so clients apply the state and then events in arrival order. `peer.subscribeState(topic)` returns `{retained, state}`. A subscription whose state would exceed the message limit is rejected with `message_too_large` and not recorded. Peers advertise this with the `retained` capability; for topics without a retained reader, subscribe then read current state. State events can arrive before the response to the call that triggered them. `commands.changed` is published when commands are registered or removed; hosts should publish it when dynamic availability changes. Subscribe/list again to refresh discovery.

A peer executes at most `MAX_CONCURRENT_REQUESTS` (32) requests at once and answers further ones with `limit_exceeded` until some complete. Failures that produce no reply, such as malformed frames, throwing application callbacks and events that cannot be sent, go to the optional `onError(error, context)` hook; an event that cannot be sent to one peer never stops the registry notifying its other listeners.

Error codes: `invalid_params`, `invalid_result`, `unknown_method`, `unknown_command`, `unavailable`, `unsupported_version`, `not_initialized`, `limit_exceeded`, `message_too_large`, `internal_error`; `unauthorized` (pairing code missing, incorrect or locked out); SDK-local errors also include `timeout`, `closed`, and `invalid_midi`. The default request timeout is 5 seconds; configure `timeoutMs` per peer. Initialization requests repeat every 250 ms with the same ID until a response or timeout; initialization is idempotent. No other requests are retried. Timeouts do not imply rollback.

## Optional MIDI 2 and property extensions (SDK 0.2)

Wire version remains 1. Both initialization requests and responses now carry a `capabilities` string array. The SDK advertises `commands`, `events`, `webmidilink`, `properties`, and `bundles`, plus `ump` when `PeerOptions.ump` is true. Missing capabilities imply only the three original features. Unknown capability names are ignored. Features use the intersection of local and remote capabilities; `peer.supports(name)` reports that intersection only after initialization. Optional methods reject with `unsupported_capability` unless negotiated. These capability names are application protocol extensions, not UMP Endpoint Discovery or MIDI-CI negotiation messages.

UMP framing is `ump,<word>[,<word>…]`: each word is exactly eight hexadecimal digits in protocol order. One message contains exactly one complete packet of 1, 2, 3, or 4 words as determined by its Message Type. Words must be unsigned integers from 0 to 4294967295; no signed JavaScript bitwise results, concatenated packets, MIDI running status or byte-order reinterpretation is accepted. Example: `ump,43913c00,abcd1234`. Unnegotiated or malformed incoming packets are ignored; sending without negotiation rejects. The SDK validates framing and packet length and preserves words, including packet types it does not interpret. JR and delta timing words do not establish a shared clock or schedule browser execution.

| Method | Arguments | Result |
| --- | --- | --- |
| `properties.list` | `{}` | property descriptors |
| `properties.get` | `{id}` | current scalar value |
| `properties.set` | `{id,value}` | actual value read back after the setter completes |
| `bundles.list` | `{}` | available application capability bundles |

Property descriptors contain `id`, `title`, `description`, `schema` (the same scalar Parameter subset used by commands), optional `unit`, `available` and `readOnly`. Getters supply current values rather than discovery snapshots. Writability and availability are checked again on every call. Setter-only properties are not supported. Errors include `unknown_property`, `read_only`, `invalid_params`, and `unavailable`; non-JSON values are rejected. Nested state and arbitrary JSON property schemas are reserved for a future extension.

Subscribe to `properties.changed` for `{id,value}` notifications and `properties.listChanged` for a `null` signal to repeat discovery. Successful SDK property writes publish the actual value. Hosts call `notifyProperty(id)` for external changes, or publish the same event shape from authoritative state. Notifications are not retained; subscribe before reading initial state, and tolerate duplicate notifications. Property getters/setters and commands invoke the same host application services.

Bundles contain a namespaced `id` (such as `org.audiobus.transport`), a positive integer `version`, and arrays of required `commands` and `properties`. Register members before the bundle. A bundle is listed only while all its members are registered; availability and writability still vary at runtime. Bundles describe contracts and do not enable or disable MIDI behavior. `bundles.changed` signals bundle registration changes. These are not MIDI Association Profile IDs and must not be advertised as MIDI-CI Profiles.

Additional SDK error codes are `unsupported_capability` and `invalid_ump`.

## WebMidiLink compatibility

MIDI uses unmodified `midi,<hex-byte>,…`, one full message per postMessage, with no running status. MIDI may arrive before control initialization so existing Level 0 senders still work, unless the receiving Peer requires a pairing code. Notes, controllers, system common/realtime, and complete SysEx are decoded; invalid byte ranges, message lengths, and concatenated messages are rejected. Receiving applications decide whether to allow SysEx and which messages to route. Message arrival time is used; version 1 adds no MIDI timestamp.

Optional `getPatch`, `setPatch`, and `onPatch` hooks receive `link,reqpatch`, `link,setpatch,<data>`, and `link,patch,<data>`. Patch data must be a comma-free string; encode application JSON using percent encoding or base64url. Hosts providing Level 1 functionality send `link,ready` themselves when ready. `link` semantics remain patch exchange, not application command discovery. The SDK does not require a control handshake for legacy patch messages; the transport must already authorize their sender.

The SDK provides `peer.announceReady()`, `peer.requestPatch()`, and `peer.setPatch(data)` to send Level 1 messages; `onReady` receives readiness. Patch requests have no correlation ID, acknowledgement, or SDK promise; replies go to `onPatch`. Comma-containing payloads are rejected. Legacy senders can instantiate a Peer and send MIDI or patches without calling `connect()`, which is only needed for the new control protocol.

`peer.discover()` requests `commands.list` and validates command IDs, availability, metadata, and the supported schema subset before returning typed descriptors. Invalid metadata rejects with `invalid_result`; `peer.list()` preserves access to the raw JSON result for other clients.
