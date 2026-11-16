export interface Transport {
    send(message: string): void;
    listen(receive: (message: unknown) => void): () => void;
}
/** Throws unless `origin` is an exact, non-opaque origin such as `https://app.example`. */
export declare function assertPeerOrigin(origin: string): void;
/** The host explicitly selects a peer window and an exact origin. */
export declare function windowTransport(target: Window, origin: string, host?: Window): Transport;
