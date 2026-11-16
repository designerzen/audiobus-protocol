import { CommandRegistry, type PropertyDescriptor, type CapabilityBundle, type CommandDescriptor, type Json, type Params } from "./registry.js";
import type { Transport } from "./transport.js";
export * from "./registry.js";
export * from "./transport.js";
export * from "./ump.js";
export declare const PROTOCOL_VERSION = 1;
export declare const CONTROL_PREFIX = "control,";
export declare const MAX_MESSAGE_LENGTH = 262144;
/** Requests one peer executes at once; further requests fail with `limit_exceeded`. */
export declare const MAX_CONCURRENT_REQUESTS = 32;
/** Failed initializations, including retried copies, before a peer stops accepting codes. */
export declare const MAX_PAIRING_ATTEMPTS = 5;
/** A random code for a person to copy from one application into the other. */
export declare function generatePairingCode(length?: number): string;
/** Case- and separator-insensitive comparison form. */
export declare function normalizePairingCode(code: string): string;
/** Groups of four for display, for example `ABCD-EFGH`. */
export declare function formatPairingCode(code: string): string;
/** Splits a control envelope into its kind and decoded JSON body; undefined when malformed. */
export declare function decodeControl(message: string): {
    kind: string;
    body: Record<string, unknown>;
} | undefined;
/** True for the first message a new connection sends: an `initialize` request. */
export declare function isInitializeRequest(message: string): boolean;
export interface Identity {
    name: string;
    version: string;
}
export interface PeerOptions {
    identity: Identity;
    registry?: CommandRegistry;
    timeoutMs?: number;
    onMidi?: (bytes: Uint8Array) => void;
    onEvent?: (topic: string, data: Json) => void;
    getPatch?: () => string;
    setPatch?: (patch: string) => void;
    onPatch?: (patch: string) => void;
    onReady?: () => void;
    /** Explicit opt-in to UMP transport; both peers must advertise it. */
    ump?: boolean;
    onUmp?: (words: number[]) => void;
    /** Code presented to the remote peer when this peer initializes it. */
    pairingCode?: string;
    /**
     * Code the remote peer must present before this peer handles its requests, MIDI or patches.
     * Use it when the peer window was not chosen by this application, such as `window.opener`.
     */
    requirePairingCode?: string;
    /** Called once the remote peer has presented the required pairing code. */
    onAuthorized?: () => void;
    /** Called when the remote peer closes its connection; held state should be released. */
    onClosed?: () => void;
    /**
     * Receives failures that would otherwise be dropped: malformed messages, application callbacks
     * that throw, and events that cannot be sent. Never called for errors returned to the remote.
     */
    onError?: (error: unknown, context: string) => void;
}
export interface SubscriptionState {
    /** True when the remote provides retained state for the topic. */
    retained: boolean;
    /** State captured atomically with the subscription; later changes arrive as events. */
    state?: Json;
}
/** One full MIDI message; no running status, concatenated messages, or invalid data bytes. */
export declare function decodeMidi(message: string): Uint8Array | undefined;
export declare class Peer {
    private transport;
    private options;
    readonly registry: CommandRegistry;
    private pending;
    private topics;
    private sequence;
    private initialized;
    private remoteCapabilities;
    private closed;
    private authorized;
    private requiredCode?;
    private failedPairings;
    private readonly token;
    private handling;
    private prepared?;
    private unlisten;
    private unobserve;
    constructor(transport: Transport, options: PeerOptions);
    private report;
    private send;
    get capabilities(): string[];
    /** False until the remote presents the required pairing code; always true without one. */
    get isAuthorized(): boolean;
    /** True after too many incorrect pairing codes; the peer must be replaced to pair again. */
    get isLocked(): boolean;
    /** True once either side has completed initialization and until the connection ends. */
    get isInitialized(): boolean;
    supports(capability: string): boolean;
    private readCapabilities;
    private requireCapability;
    private acceptCapabilities;
    connect(): Promise<Json>;
    request(method: string, params?: Params): Promise<Json>;
    list(): Promise<Json>;
    discover(): Promise<CommandDescriptor[]>;
    listProperties(): Promise<PropertyDescriptor[]>;
    getProperty(id: string): Promise<Json>;
    setProperty(id: string, value: Json): Promise<Json>;
    listBundles(): Promise<CapabilityBundle[]>;
    sendUmp(words: ArrayLike<number>): void;
    private sendLink;
    announceReady(): void;
    requestPatch(): void;
    setPatch(patch: string): void;
    call(command: string, args?: Params): Promise<Json>;
    subscribe(topic: string): Promise<Json>;
    /** Subscribe and receive the topic's current state in the same response, when retained. */
    subscribeState(topic: string): Promise<SubscriptionState>;
    unsubscribe(topic: string): Promise<Json>;
    sendMidi(bytes: ArrayLike<number>): void;
    private receive;
    /** The remote ended the connection: forget its subscriptions and fail its requests. */
    private endSession;
    private checkPairing;
    /** Serializes a reply once, keeping it for the send if it fits. */
    private fits;
    private handle;
    /**
     * Ends the connection. The remote is told, unless `notify` is false, so it can release notes
     * and subscriptions held for this peer.
     */
    close(options?: {
        notify?: boolean;
    }): void;
}
