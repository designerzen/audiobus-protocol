# Wire protocol version 1

## Transport and framing

Each transport message is a single string. The default browser transport uses `window.postMessage`; custom transports implement `send(string)` and `listen(callback) → unsubscribe`. Transport implementations must isolate one authorized peer and preserve message order. A `Peer` owns its listener and subscriptions, not the underlying window.

Control messages are `control,<kind>,<payload>`, where kind is `request`, `response`, or `event` and payload is `encodeURIComponent(JSON.stringify(body))`. Decode exactly once. Encoded payloads contain no literal commas. Maximum total message length is 262,144 JavaScript UTF-16 code units; larger messages are rejected on send and ignored on receipt. Unknown prefixes, malformed frames, and malformed responses are ignored. Control framing is an audioBus extension, not part of WebMidiLink.

Decoded examples:

```json
{"id":"1","method":"initialize","params":{"protocolVersion":1,"name":"Harmoneasy","version":"0.19"}}
{"id":"1","result":{"protocolVersion":1,"name":"Other application","version":"1","capabilities":["commands","events","webmidilink"],"maxMessageLength":262144}}
{"id":"2","method":"commands.call","params":{"command":"transport.setTempo","arguments":{"bpm":128}}}
{"id":"2","result":{"bpm":128}}
{"id":"3","error":{"code":"unknown_command","message":"Unknown command: missing"}}
{"topic":"transport.changed","data":{"bpm":128}}
```

IDs are strings, unique among requests pending in the same direction. Responses echo IDs and have exactly one of `result` or `error`. Results and event data must be JSON values; return `null` for commands with no result. Internal exceptions become `internal_error` without exposing exception text. A peer must not send functions, circular objects, undefined, non-finite numbers, or other non-JSON results.

## Lifecycle

Install listeners on both sides, then call `connect()` on either side after application readiness. It sends `initialize`. Both sides must agree on the exact integer protocol version; version 1 rejects other versions with `unsupported_version`. The response returns application identity, capabilities, and the message limit. Successful initialization enables control in both directions. Application versions do not determine protocol compatibility. Repeated initialization of the same connection is allowed and does not clear subscriptions.

No automatic window discovery or acceptance of arbitrary senders takes place. The host explicitly provides the remote window and trusted origin. A reload creates a new application session: close the old peer, release its input notes, create a new peer and initialize again. Close rejects outstanding local requests and removes local listeners and subscriptions. Close has no wire acknowledgement and cannot cancel a command already executing remotely. Remote disappearance is detected through request timeouts or application lifecycle signals, not heartbeats.

## Methods

| Method | Arguments | Result |
| --- | --- | --- |
| `initialize` | `protocolVersion`, `name`, `version` | negotiated version, identity, capabilities, limit |
| `commands.list` | `{}` | command descriptors |
| `commands.call` | `command`, `arguments` | command result |
| `events.subscribe` | `topic` | `{topic, subscribed:true}` |
| `events.unsubscribe` | `topic` | `{topic, subscribed:false}` |

Descriptors contain `id`, `title`, `description`, `inputSchema`, and current `available`. Availability is checked again at execution. The input schema supports object properties of type string, boolean, finite number, or integer; optional enum, numeric minimum/maximum, required properties, and `additionalProperties:false`. This is a bounded JSON Schema subset, not a complete JSON Schema validator. Nested objects and arrays as command arguments are reserved for a later version. Results and events may contain arbitrary JSON trees.

Topics are exact strings of 1–200 characters, with at most 128 subscriptions per connection. Repeated subscriptions are idempotent; there is no wildcard or retained initial value. Subscribe then read current state when establishing a view. State events can arrive before the response to the call that triggered them. `commands.changed` is published when commands are registered or removed; hosts should publish it when dynamic availability changes. Subscribe/list again to refresh discovery.

Error codes: `invalid_params`, `invalid_result`, `unknown_method`, `unknown_command`, `unavailable`, `unsupported_version`, `not_initialized`, `limit_exceeded`, `message_too_large`, `internal_error`; SDK-local errors also include `timeout`, `closed`, and `invalid_midi`. The default request timeout is 5 seconds; configure `timeoutMs` per peer. Initialization requests repeat every 250 ms with the same ID until a response or timeout; initialization is idempotent. No other requests are retried. Timeouts do not imply rollback.

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

MIDI uses unmodified `midi,<hex-byte>,…`, one full message per postMessage, with no running status. MIDI may arrive before control initialization so existing Level 0 senders still work. Notes, controllers, system common/realtime, and complete SysEx are decoded; invalid byte ranges, message lengths, and concatenated messages are rejected. Receiving applications decide whether to allow SysEx and which messages to route. Message arrival time is used; version 1 adds no MIDI timestamp.

Optional `getPatch`, `setPatch`, and `onPatch` hooks receive `link,reqpatch`, `link,setpatch,<data>`, and `link,patch,<data>`. Patch data must be a comma-free string; encode application JSON using percent encoding or base64url. Hosts providing Level 1 functionality send `link,ready` themselves when ready. `link` semantics remain patch exchange, not application command discovery. The SDK does not require a control handshake for legacy patch messages; the transport must already authorize their sender.

The SDK provides `peer.announceReady()`, `peer.requestPatch()`, and `peer.setPatch(data)` to send Level 1 messages; `onReady` receives readiness. Patch requests have no correlation ID, acknowledgement, or SDK promise; replies go to `onPatch`. Comma-containing payloads are rejected. Legacy senders can instantiate a Peer and send MIDI or patches without calling `connect()`, which is only needed for the new control protocol.

`peer.discover()` requests `commands.list` and validates command IDs, availability, metadata, and the supported schema subset before returning typed descriptors. Invalid metadata rejects with `invalid_result`; `peer.list()` preserves access to the raw JSON result for other clients.
