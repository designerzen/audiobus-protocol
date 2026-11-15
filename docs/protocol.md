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

## WebMidiLink compatibility

MIDI uses unmodified `midi,<hex-byte>,…`, one full message per postMessage, with no running status. MIDI may arrive before control initialization so existing Level 0 senders still work. Notes, controllers, system common/realtime, and complete SysEx are decoded; invalid byte ranges, message lengths, and concatenated messages are rejected. Receiving applications decide whether to allow SysEx and which messages to route. Message arrival time is used; version 1 adds no MIDI timestamp.

Optional `getPatch`, `setPatch`, and `onPatch` hooks receive `link,reqpatch`, `link,setpatch,<data>`, and `link,patch,<data>`. Patch data must be a comma-free string; encode application JSON using percent encoding or base64url. Hosts providing Level 1 functionality send `link,ready` themselves when ready. `link` semantics remain patch exchange, not application command discovery. The SDK does not require a control handshake for legacy patch messages; the transport must already authorize their sender.

The SDK provides `peer.announceReady()`, `peer.requestPatch()`, and `peer.setPatch(data)` to send Level 1 messages; `onReady` receives readiness. Patch requests have no correlation ID, acknowledgement, or SDK promise; replies go to `onPatch`. Comma-containing payloads are rejected. Legacy senders can instantiate a Peer and send MIDI or patches without calling `connect()`, which is only needed for the new control protocol.

`peer.discover()` requests `commands.list` and validates command IDs, availability, metadata, and the supported schema subset before returning typed descriptors. Invalid metadata rejects with `invalid_result`; `peer.list()` preserves access to the raw JSON result for other clients.
