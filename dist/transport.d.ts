export interface Transport {
    send(message: string): void;
    listen(receive: (message: unknown) => void): () => void;
}
/** The host explicitly selects a peer window and an exact origin. */
export declare function windowTransport(target: Window, origin: string, host?: Window): Transport;
