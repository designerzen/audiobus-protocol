// Transports that work when window references do not, such as between cross-origin isolated
// applications. See docs/isolation.md.
import type { Transport } from "./transport.js";
import { CONTROL_PREFIX, MAX_MESSAGE_LENGTH, decodeControl, decodeMidi } from "./control.js";

const EVENT_MESSAGE = "message";
const EVENT_OPEN = "open";
const EVENT_MIDI_MESSAGE = "midimessage";
const BYE_PREFIX = `${CONTROL_PREFIX}bye,`;
const REQUEST_PREFIX = `${CONTROL_PREFIX}request,`;
const RESPONSE_PREFIX = `${CONTROL_PREFIX}response,`;

type MessageListener = (event: { data: unknown }) => void;

/** MessagePort, BroadcastChannel, Worker or anything else with `postMessage` and message events. */
export interface PortLike {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  start?(): void;
}

/**
 * A transport over a channel that already reaches exactly one peer, such as a MessagePort handed
 * over by an extension or a parent page. The channel's owner decides who is on the other end.
 */
export function portTransport(port: PortLike): Transport {
  return {
    send: (message) => port.postMessage(message),
    listen(receive) {
      const listener: MessageListener = (event) => receive(event.data);
      port.addEventListener(EVENT_MESSAGE, listener);
      // MessagePorts deliver nothing until started; other channels have no start().
      port.start?.();
      return () => port.removeEventListener(EVENT_MESSAGE, listener);
    },
  };
}

/** WebSocket or RTCDataChannel. */
export interface SocketLike {
  send(message: string): void;
  readyState?: number | string;
  addEventListener(type: "message" | "open", listener: MessageListener): void;
  removeEventListener(type: "message" | "open", listener: MessageListener): void;
}
export interface SocketTransportOptions {
  /**
   * Largest message, in UTF-8 bytes, the socket accepts. Longer protocol messages are split into
   * `frag,…` fragments that the other socketTransport reassembles. Pass an RTCPeerConnection's
   * `sctp.maxMessageSize` for a data channel, or Infinity for a WebSocket server that accepts
   * any size. Default DEFAULT_SOCKET_MESSAGE_SIZE.
   */
  maxMessageSize?: number;
}
/** Messages a socket transport holds while its socket is still connecting. */
export const MAX_QUEUED_MESSAGES = 256;
/** A message size every WebRTC implementation accepts. */
export const DEFAULT_SOCKET_MESSAGE_SIZE = 65536;
const FRAGMENT_PREFIX = "frag,";

/**
 * A transport over a WebSocket or WebRTC data channel. Messages sent while it is still connecting
 * are queued and sent in order once it opens; sending on a closed socket throws. Closing the
 * peer discards anything still queued.
 */
export function socketTransport(socket: SocketLike, options: SocketTransportOptions = {}): Transport {
  const maxSize = options.maxMessageSize ?? DEFAULT_SOCKET_MESSAGE_SIZE;
  if (!(maxSize >= 256)) throw new Error("maxMessageSize must be at least 256 bytes");
  const encoder = new TextEncoder();
  const queue: string[] = [];
  let waiting = false;
  let disposed = false;
  let fragments = 0;
  const state = () => {
    const ready = socket.readyState;
    if (ready === undefined || ready === 1 || ready === EVENT_OPEN) return "open";
    return ready === 0 || ready === "connecting" ? "connecting" : "closed";
  };
  const write = (message: string) => {
    // Most messages are far below the limit, so measure only when they might not be.
    if (message.length * 3 <= maxSize || encoder.encode(message).length <= maxSize) {
      socket.send(message);
      return;
    }
    const id = (fragments = (fragments + 1) % 1e9);
    // Three bytes per UTF-16 unit is the worst case, leaving room for the fragment header.
    const size = Math.max(1, Math.floor((maxSize - 40) / 3));
    for (let start = 0, index = 0; start < message.length; index++) {
      let end = Math.min(start + size, message.length);
      // Never split a surrogate pair, which would corrupt the character in UTF-8.
      const code = message.charCodeAt(end - 1);
      if (end < message.length && code >= 0xd800 && code <= 0xdbff) end--;
      const last = end === message.length ? 1 : 0;
      socket.send(`${FRAGMENT_PREFIX}${id},${index},${last},${message.slice(start, end)}`);
      start = end;
    }
  };
  const drain: MessageListener = () => {
    socket.removeEventListener(EVENT_OPEN, drain);
    waiting = false;
    while (queue.length && !disposed) {
      try {
        write(queue[0]!);
      } catch {
        // A closed socket fails everything left; otherwise only this message is lost, and the
        // protocol's request timeouts report it.
        if (state() !== "open") {
          queue.length = 0;
          return;
        }
      }
      queue.shift();
    }
  };
  return {
    send(message) {
      const now = state();
      if (disposed || now === "closed") throw new Error("Socket is closed");
      // Anything sent while older messages wait joins the end of the queue, keeping order.
      if (now === "connecting" || queue.length) {
        if (queue.length >= MAX_QUEUED_MESSAGES) throw new Error("Socket is still connecting");
        queue.push(message);
        if (!waiting) {
          waiting = true;
          socket.addEventListener(EVENT_OPEN, drain);
        }
        if (now === "open") drain({ data: null });
        return;
      }
      write(message);
    },
    listen(receive) {
      let partial: { id: string; next: number; parts: string[]; length: number } | undefined;
      const listener: MessageListener = ({ data }) => {
        if (typeof data !== "string" || !data.startsWith(FRAGMENT_PREFIX)) {
          receive(data);
          return;
        }
        const fields = data.split(",", 4);
        const header = fields.join(",").length + 1;
        const [, id, rawIndex, last] = fields;
        const index = Number(rawIndex);
        if (index === 0) partial = { id: id!, next: 0, parts: [], length: 0 };
        if (!partial || partial.id !== id || partial.next !== index) {
          partial = undefined;
          return;
        }
        const text = data.slice(header);
        partial.parts.push(text);
        partial.length += text.length;
        partial.next++;
        if (partial.length > MAX_MESSAGE_LENGTH) {
          partial = undefined;
        } else if (last === "1") {
          const message = partial.parts.join("");
          partial = undefined;
          receive(message);
        }
      };
      socket.addEventListener(EVENT_MESSAGE, listener);
      return () => {
        socket.removeEventListener(EVENT_MESSAGE, listener);
        disposed = true;
        queue.length = 0;
        if (waiting) socket.removeEventListener(EVENT_OPEN, drain);
        waiting = false;
      };
    },
  };
}

// MIDI SysEx framing. Every protocol message, MIDI included, travels in non-commercial SysEx
// (manufacturer 0x7D) so this transport can tell its own echoes and other senders apart:
// F0 7D 61 42 <version> <room> <sender×4> <sequence×2> <index×3> <flags> <payload…> F7
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
/** The SysEx manufacturer ID reserved for non-commercial use. */
export const SYSEX_MANUFACTURER = 0x7d;
const SIGNATURE = [0x61, 0x42]; // "aB"
const FRAME_VERSION = 1;
const HEADER_LENGTH = 1 + 1 + SIGNATURE.length + 1 + 1 + 4 + 2 + 3 + 1;
const FLAG_LAST = 1;
/** Default packed payload bytes per SysEx frame, a size every MIDI driver accepts. */
export const DEFAULT_SYSEX_CHUNK = 240;
const MAX_SYSEX_CHUNK = 65536;
// Worst case: every UTF-16 unit becomes 3 UTF-8 bytes, plus one byte in eight for packing.
const MAX_PACKED_LENGTH = Math.ceil((MAX_MESSAGE_LENGTH * 3 * 8) / 7) + 8;
// Senders this transport does not follow may only start a connection, so they get a small
// budget and a few slots, and cannot grow memory by starting many messages.
const CANDIDATE_PACKED_LENGTH = 16384;
const MAX_CANDIDATES = 4;
// Initialize requests this transport sent, so it can recognise the answer to one.
const MAX_AWAITED = 8;

/** Spreads 8-bit bytes over 7-bit SysEx data bytes: each group of up to seven gets a byte of high bits. */
export function packSysex(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (let start = 0; start < bytes.length; start += 7) {
    const group = bytes.subarray(start, start + 7);
    let high = 0;
    group.forEach((byte, index) => (high |= (byte >> 7) << index));
    out.push(high);
    for (const byte of group) out.push(byte & 0x7f);
  }
  return out;
}
/** Reverses packSysex; undefined for data that packSysex cannot have produced. */
export function unpackSysex(data: ArrayLike<number>): Uint8Array | undefined {
  const out = new Uint8Array(Math.floor((data.length * 7) / 8));
  let length = 0;
  const valid = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0x7f;
  for (let start = 0; start < data.length; start += 8) {
    const high = data[start]!;
    const count = Math.min(start + 8, data.length) - start - 1;
    // Every group has at least one byte, and no high bits for bytes it does not have.
    if (count < 1 || !valid(high) || high >> count !== 0) return;
    for (let index = 0; index < count; index++) {
      const low = data[start + 1 + index]!;
      if (!valid(low)) return;
      out[length++] = low | (((high >> index) & 1) << 7);
    }
  }
  return out.subarray(0, length);
}
const bits7 = (value: number, count: number) =>
  Array.from({ length: count }, (_, index) => (value >> (7 * (count - 1 - index))) & 0x7f);
const read7 = (data: ArrayLike<number>, start: number, count: number) => {
  let value = 0;
  for (let index = 0; index < count; index++) value = (value << 7) | data[start + index]!;
  return value;
};

export interface MidiInputLike {
  addEventListener(type: "midimessage", listener: (event: { data: Uint8Array | null }) => void): void;
  removeEventListener(
    type: "midimessage",
    listener: (event: { data: Uint8Array | null }) => void,
  ): void;
}
export interface MidiOutputLike {
  send(data: number[] | Uint8Array): void;
}
export interface MidiTransportOptions {
  /**
   * 0–127. Peers only hear frames for their own room, so several pairs of applications can share
   * one port. Default 0.
   */
  room?: number;
  /** Packed payload bytes per SysEx frame, 8–65536. Default DEFAULT_SYSEX_CHUNK. */
  chunkSize?: number;
  /**
   * Also deliver plain MIDI arriving on the input, such as notes or clock from a keyboard, as
   * WebMidiLink `midi,…` messages. Off by default. This transport never sends plain MIDI, so its
   * own messages cannot echo back this way.
   */
  acceptPlainMidi?: boolean;
}

/**
 * A transport over Web MIDI, for applications that cannot reach each other's windows, such as two
 * cross-origin isolated pages. Open the same virtual or loopback port (loopMIDI, the macOS IAC
 * driver, ALSA virmidi) in both applications, with `requestMIDIAccess({ sysex: true })`.
 *
 * The transport ignores its own echoes and talks to one other sender at a time. It starts
 * following a sender only after a completed handshake: this peer accepted that sender's
 * `initialize` request, or that sender accepted this peer's. A port is a shared bus with no
 * sender authentication, so only use ports that trusted software can write to.
 */
export function midiTransport(
  input: MidiInputLike,
  output: MidiOutputLike,
  options: MidiTransportOptions = {},
): Transport {
  const room = options.room ?? 0;
  const chunkSize = options.chunkSize ?? DEFAULT_SYSEX_CHUNK;
  if (!Number.isInteger(room) || room < 0 || room > 127)
    throw new Error("A MIDI room is an integer from 0 to 127");
  if (!Number.isInteger(chunkSize) || chunkSize < 8 || chunkSize > MAX_SYSEX_CHUNK)
    throw new Error(`chunkSize is an integer from 8 to ${MAX_SYSEX_CHUNK}`);
  const sender = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte & 0x7f);
  const self = sender.join(".");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let sequence = 0;
  // The sender this transport talks to, and a sender whose initialize request awaits our answer.
  let peer: string | undefined;
  let candidate: { from: string; id: string } | undefined;
  const awaited: string[] = [];
  const forgetOthers = new Set<() => void>();

  const follow = (from: string) => {
    peer = from;
    candidate = undefined;
    forgetOthers.forEach((forget) => forget());
  };
  const frame = (message: string) => {
    const payload = packSysex(encoder.encode(message));
    const id = bits7(sequence, 2);
    sequence = (sequence + 1) & 0x3fff;
    const chunks = Math.max(1, Math.ceil(payload.length / chunkSize));
    for (let index = 0; index < chunks; index++) {
      const part = payload.slice(index * chunkSize, (index + 1) * chunkSize);
      const bytes = new Uint8Array(HEADER_LENGTH + part.length + 1);
      bytes.set([SYSEX_START, SYSEX_MANUFACTURER, ...SIGNATURE, FRAME_VERSION, room, ...sender, ...id, ...bits7(index, 3), index === chunks - 1 ? FLAG_LAST : 0]);
      bytes.set(part, HEADER_LENGTH);
      bytes[bytes.length - 1] = SYSEX_END;
      output.send(bytes);
    }
  };
  return {
    send(message) {
      if (message.length > MAX_MESSAGE_LENGTH) throw new Error("Message exceeds limit");
      // Only requests, and replies while a new sender waits, are decoded; other traffic is not.
      const control =
        message.startsWith(REQUEST_PREFIX) || (candidate && message.startsWith(RESPONSE_PREFIX))
          ? decodeControl(message)
          : undefined;
      if (control?.kind === "request" && control.body.method === "initialize") {
        const id = control.body.id;
        if (typeof id === "string" && !awaited.includes(id)) {
          awaited.push(id);
          if (awaited.length > MAX_AWAITED) awaited.shift();
        }
      } else if (
        control?.kind === "response" &&
        candidate &&
        control.body.id === candidate.id
      ) {
        // This peer answered a new sender's initialize: follow it only if it was accepted.
        if (Object.hasOwn(control.body, "result")) follow(candidate.from);
        else candidate = undefined;
      }
      frame(message);
    },
    listen(receive) {
      type Assembly = { sequence: number; next: number; parts: Uint8Array[]; length: number };
      const partial = new Map<string, Assembly>();
      const forget = () => {
        for (const key of partial.keys()) if (key !== peer) partial.delete(key);
      };
      forgetOthers.add(forget);
      const deliver = (from: string, assembly: Assembly) => {
        const packed = new Uint8Array(assembly.length);
        let offset = 0;
        for (const part of assembly.parts) {
          packed.set(part, offset);
          offset += part.length;
        }
        const bytes = unpackSysex(packed);
        if (!bytes) return;
        let message: string;
        try {
          message = decoder.decode(bytes);
        } catch {
          return;
        }
        if (message.length > MAX_MESSAGE_LENGTH) return;
        if (from !== peer) {
          const control = decodeControl(message);
          const id = control?.body.id;
          if (typeof id !== "string") return;
          if (control!.kind === "request" && control!.body.method === "initialize") {
            // Deliver it; send() follows this sender once the reply accepts it.
            candidate = { from, id };
          } else if (control!.kind === "response" && awaited.includes(id)) {
            // An answer to this peer's own initialize request.
            if (Object.hasOwn(control!.body, "result")) follow(from);
          } else {
            return;
          }
        }
        receive(message);
        if (from === peer && message.startsWith(BYE_PREFIX)) peer = undefined;
      };
      const listener = (event: { data: Uint8Array | null }) => {
        const data = event.data;
        if (!data?.length) return;
        const ours =
          data[0] === SYSEX_START &&
          data[1] === SYSEX_MANUFACTURER &&
          data[2] === SIGNATURE[0] &&
          data[3] === SIGNATURE[1];
        if (!ours) {
          if (options.acceptPlainMidi && data[0]! >= 0x80) {
            const message = `midi,${Array.from(data, (byte) => byte.toString(16)).join(",")}`;
            if (decodeMidi(message)) receive(message);
          }
          return;
        }
        if (
          data.length < HEADER_LENGTH + 2 ||
          data[4] !== FRAME_VERSION ||
          data[5] !== room ||
          data[data.length - 1] !== SYSEX_END
        )
          return;
        const from = Array.from(data.subarray(6, 10)).join(".");
        if (from === self) return; // Our own message, echoed by a loopback port.
        const id = read7(data, 10, 2);
        const index = read7(data, 12, 3);
        const last = (data[15]! & FLAG_LAST) !== 0;
        const size = data.length - HEADER_LENGTH - 1;
        const budget = from === peer ? MAX_PACKED_LENGTH : CANDIDATE_PACKED_LENGTH;
        let assembly = partial.get(from);
        if (index === 0) {
          partial.delete(from);
          if (from !== peer) {
            const others = [...partial.keys()].filter((key) => key !== peer);
            if (others.length >= MAX_CANDIDATES) partial.delete(others[0]!);
          }
          assembly = { sequence: id, next: 0, parts: [], length: 0 };
          partial.set(from, assembly);
        }
        // A gap, a mixed-up sequence or an oversized message drops it; protocol timeouts recover.
        if (
          !assembly ||
          assembly.sequence !== id ||
          assembly.next !== index ||
          assembly.length + size > budget
        ) {
          partial.delete(from);
          return;
        }
        assembly.parts.push(data.slice(HEADER_LENGTH, data.length - 1));
        assembly.length += size;
        assembly.next++;
        if (last) {
          partial.delete(from);
          deliver(from, assembly);
        }
      };
      input.addEventListener(EVENT_MIDI_MESSAGE, listener);
      return () => {
        input.removeEventListener(EVENT_MIDI_MESSAGE, listener);
        forgetOthers.delete(forget);
        partial.clear();
      };
    },
  };
}

/** Minimal shape of the MIDIAccess returned by navigator.requestMIDIAccess. */
export interface MidiAccessLike {
  inputs: { values(): Iterable<MidiInputLike & { name?: string | null }> };
  outputs: { values(): Iterable<MidiOutputLike & { name?: string | null }> };
}
/**
 * The input and output of one virtual port, matched by name. Loopback drivers give both
 * directions the same name, such as `loopMIDI Port` or `IAC Driver Bus 1`.
 */
export function findMidiPort(
  access: MidiAccessLike,
  name: string,
): { input: MidiInputLike; output: MidiOutputLike } | undefined {
  const matches = (port: { name?: string | null }) => port.name === name;
  const input = [...access.inputs.values()].find(matches);
  const output = [...access.outputs.values()].find(matches);
  return input && output ? { input, output } : undefined;
}

/** What this page can use: SharedArrayBuffer, and which windows it can still reach. */
export interface IsolationReport {
  /** True when the page may use SharedArrayBuffer and high-resolution timers. */
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  /** This page has a reference to the window that opened it. */
  opener: boolean;
  /** This page is in a frame, so it can reach its parent with windowTransport. */
  embedded: boolean;
}
export function isolationReport(scope: typeof globalThis = globalThis): IsolationReport {
  const view = scope as unknown as {
    crossOriginIsolated?: boolean;
    opener?: unknown;
    parent?: unknown;
    window?: unknown;
  };
  return {
    crossOriginIsolated: view.crossOriginIsolated === true,
    sharedArrayBuffer: typeof (scope as { SharedArrayBuffer?: unknown }).SharedArrayBuffer === "function",
    opener: view.opener != null,
    embedded: view.window !== undefined && view.parent != null && view.parent !== view.window,
  };
}
/**
 * A snapshot: false when a window reference is missing or closed, as it is once
 * Cross-Origin-Opener-Policy has moved a popup to another browsing context group. A popup can
 * still look open until its page loads, so confirm a connection with `peer.connect()`.
 */
export function windowReachable(target: { closed?: boolean } | null | undefined): boolean {
  return target != null && target.closed !== true;
}
