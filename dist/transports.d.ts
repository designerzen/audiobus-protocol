import type { Transport } from "./transport.js";
type MessageListener = (event: {
    data: unknown;
}) => void;
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
export declare function portTransport(port: PortLike): Transport;
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
export declare const MAX_QUEUED_MESSAGES = 256;
/** A message size every WebRTC implementation accepts. */
export declare const DEFAULT_SOCKET_MESSAGE_SIZE = 65536;
/**
 * A transport over a WebSocket or WebRTC data channel. Messages sent while it is still connecting
 * are queued and sent in order once it opens; sending on a closed socket throws. Closing the
 * peer discards anything still queued.
 */
export declare function socketTransport(socket: SocketLike, options?: SocketTransportOptions): Transport;
/** The SysEx manufacturer ID reserved for non-commercial use. */
export declare const SYSEX_MANUFACTURER = 125;
/** Default packed payload bytes per SysEx frame, a size every MIDI driver accepts. */
export declare const DEFAULT_SYSEX_CHUNK = 240;
/** Spreads 8-bit bytes over 7-bit SysEx data bytes: each group of up to seven gets a byte of high bits. */
export declare function packSysex(bytes: Uint8Array): number[];
/** Reverses packSysex; undefined for data that packSysex cannot have produced. */
export declare function unpackSysex(data: ArrayLike<number>): Uint8Array | undefined;
export interface MidiInputLike {
    addEventListener(type: "midimessage", listener: (event: {
        data: Uint8Array | null;
    }) => void): void;
    removeEventListener(type: "midimessage", listener: (event: {
        data: Uint8Array | null;
    }) => void): void;
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
export declare function midiTransport(input: MidiInputLike, output: MidiOutputLike, options?: MidiTransportOptions): Transport;
/** Minimal shape of the MIDIAccess returned by navigator.requestMIDIAccess. */
export interface MidiAccessLike {
    inputs: {
        values(): Iterable<MidiInputLike & {
            name?: string | null;
        }>;
    };
    outputs: {
        values(): Iterable<MidiOutputLike & {
            name?: string | null;
        }>;
    };
}
/**
 * The input and output of one virtual port, matched by name. Loopback drivers give both
 * directions the same name, such as `loopMIDI Port` or `IAC Driver Bus 1`.
 */
export declare function findMidiPort(access: MidiAccessLike, name: string): {
    input: MidiInputLike;
    output: MidiOutputLike;
} | undefined;
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
export declare function isolationReport(scope?: typeof globalThis): IsolationReport;
/**
 * A snapshot: false when a window reference is missing or closed, as it is once
 * Cross-Origin-Opener-Policy has moved a popup to another browsing context group. A popup can
 * still look open until its page loads, so confirm a connection with `peer.connect()`.
 */
export declare function windowReachable(target: {
    closed?: boolean;
} | null | undefined): boolean;
export {};
