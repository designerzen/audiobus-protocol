export interface Transport {
  send(message: string): void;
  listen(receive: (message: unknown) => void): () => void;
}
const EVENT_MESSAGE = "message";
/** Throws unless `origin` is an exact, non-opaque origin such as `https://app.example`. */
export function assertPeerOrigin(origin: string): void {
  let parsed: string | undefined;
  try {
    parsed = new URL(origin).origin;
  } catch {
    /* Reported below. */
  }
  if (origin === "*" || origin === "null" || parsed !== origin) {
    throw new Error("An exact, non-opaque peer origin is required");
  }
}
/** The host explicitly selects a peer window and an exact origin. */
export function windowTransport(target: Window, origin: string, host: Window = window): Transport {
  assertPeerOrigin(origin);
  return {
    send: (message) => target.postMessage(message, origin),
    listen(receive) {
      const listener = (event: MessageEvent) => {
        if (event.source === target && event.origin === origin) receive(event.data);
      };
      host.addEventListener(EVENT_MESSAGE, listener);
      return () => host.removeEventListener(EVENT_MESSAGE, listener);
    },
  };
}
