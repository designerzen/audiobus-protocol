export declare const CONTROL_PREFIX = "control,";
export declare const MAX_MESSAGE_LENGTH = 262144;
/** Splits a control envelope into its kind and decoded JSON body; undefined when malformed. */
export declare function decodeControl(message: string): {
    kind: string;
    body: Record<string, unknown>;
} | undefined;
/** True for the first message a new connection sends: an `initialize` request. */
export declare function isInitializeRequest(message: string): boolean;
/** One full MIDI message; no running status, concatenated messages, or invalid data bytes. */
export declare function decodeMidi(message: string): Uint8Array | undefined;
