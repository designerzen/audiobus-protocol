// Message helpers shared by Peer and the transports, kept apart so transports can validate
// handshakes without importing Peer.
import { object } from "./registry.js";
export const CONTROL_PREFIX = "control,";
export const MAX_MESSAGE_LENGTH = 262144;
/** Splits a control envelope into its kind and decoded JSON body; undefined when malformed. */
export function decodeControl(message) {
    if (!message.startsWith(CONTROL_PREFIX) || message.length > MAX_MESSAGE_LENGTH)
        return;
    const separator = message.indexOf(",", CONTROL_PREFIX.length);
    if (separator < 0)
        return;
    try {
        const body = JSON.parse(decodeURIComponent(message.slice(separator + 1)));
        return object(body) ? { kind: message.slice(CONTROL_PREFIX.length, separator), body } : undefined;
    }
    catch {
        return;
    }
}
/** True for the first message a new connection sends: an `initialize` request. */
export function isInitializeRequest(message) {
    const control = decodeControl(message);
    return (control?.kind === "request" &&
        control.body.method === "initialize" &&
        typeof control.body.id === "string");
}
/** One full MIDI message; no running status, concatenated messages, or invalid data bytes. */
export function decodeMidi(message) {
    const fields = message.split(",");
    if (fields.shift() !== "midi" ||
        !fields.length ||
        fields.some((x) => !/^[0-9a-f]{1,2}$/i.test(x)))
        return;
    const bytes = fields.map((x) => parseInt(x, 16)), status = bytes[0];
    if (status < 0x80)
        return;
    if (status === 0xf0) {
        if (bytes.length < 2 || bytes.at(-1) !== 0xf7 || bytes.slice(1, -1).some((x) => x > 127))
            return;
    }
    else {
        const length = status < 0xf0
            ? status >> 4 === 0xc || status >> 4 === 0xd
                ? 2
                : 3
            : status === 0xf1 || status === 0xf3
                ? 2
                : status === 0xf2
                    ? 3
                    : 1;
        if ([0xf4, 0xf5, 0xf7, 0xf9, 0xfd].includes(status) ||
            bytes.length !== length ||
            bytes.slice(1).some((x) => x > 127))
            return;
    }
    return Uint8Array.from(bytes);
}
