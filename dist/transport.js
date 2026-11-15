const EVENT_MESSAGE = "message";
/** The host explicitly selects a peer window and an exact origin. */
export function windowTransport(target, origin, host = window) {
    if (origin === "*" || origin === "null" || new URL(origin).origin !== origin) {
        throw new Error("An exact, non-opaque peer origin is required");
    }
    return {
        send: (message) => target.postMessage(message, origin),
        listen(receive) {
            const listener = (event) => {
                if (event.source === target && event.origin === origin)
                    receive(event.data);
            };
            host.addEventListener(EVENT_MESSAGE, listener);
            return () => host.removeEventListener(EVENT_MESSAGE, listener);
        },
    };
}
