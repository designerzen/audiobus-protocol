/** UMP packet sizes in 32-bit words, indexed by the Message Type nibble. */
const WORD_COUNTS = [1, 1, 1, 2, 2, 4, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4];
export function isUmpPacket(words) {
    return (Array.isArray(words) &&
        words.length > 0 &&
        words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffffffff) &&
        words.length === WORD_COUNTS[words[0] >>> 28]);
}
export function encodeUmp(words) {
    const values = Array.from(words);
    if (!isUmpPacket(values))
        throw new Error("Expected one complete UMP packet of unsigned 32-bit words");
    return `ump,${values.map((word) => word.toString(16).padStart(8, "0")).join(",")}`;
}
export function decodeUmp(message) {
    const fields = message.split(",");
    if (fields.shift() !== "ump" || fields.some((field) => !/^[0-9a-f]{8}$/i.test(field)))
        return;
    const words = fields.map((field) => parseInt(field, 16));
    return isUmpPacket(words) ? words : undefined;
}
