export declare function isUmpPacket(words: unknown): words is number[];
export declare function encodeUmp(words: ArrayLike<number>): string;
export declare function decodeUmp(message: string): number[] | undefined;
