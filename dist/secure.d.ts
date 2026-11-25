import type { Transport } from "./transport.js";
/** A channel whose messages carry their sender, such as a shared MIDI port. */
export interface Bus {
    send(message: string): void;
    listen(receive: (message: string, from: string) => void): () => void;
    /** The sender this side talks to, which gets the full message budget; undefined for none. */
    follow(from: string | undefined): void;
}
/** The sender of messages from outside the protocol, such as plain MIDI from a keyboard. */
export declare const PLAIN_SENDER = "";
/** PBKDF2 rounds that stretch the secret, so every guess at it costs an attacker time. */
export declare const SECRET_ITERATIONS = 210000;
/** Longest encrypted message on the wire: base64 of three UTF-8 bytes per character, plus framing. */
export declare const MAX_SECURE_LENGTH: number;
/** Case, spaces, dashes, dots and underscores are ignored, as with pairing codes. */
export declare function normalizeSecret(secret: string): string;
/**
 * Encrypts and authenticates a bus with a shared secret, such as a pairing code or passphrase that
 * both applications know. Each side proves it knows the secret before anything else is accepted;
 * listeners without it see only random bytes, and cannot inject, alter or replay messages.
 *
 * Messages sent before a peer has proved the secret wait, in order, until one has.
 */
export declare function secureBus(bus: Bus, secret: string): Transport;
/**
 * Encrypts and authenticates a transport that reaches one peer, such as a WebSocket relay or an
 * extension's MessagePort, with a secret both applications know. Both sides must use it.
 */
export declare function secureTransport(transport: Transport, options: {
    secret: string;
}): Transport;
