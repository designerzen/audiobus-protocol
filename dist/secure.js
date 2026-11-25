import { CONTROL_PREFIX, MAX_MESSAGE_LENGTH, decodeControl, isInitializeRequest } from "./control.js";
/** The sender of messages from outside the protocol, such as plain MIDI from a keyboard. */
export const PLAIN_SENDER = "";
const POINT_TO_POINT = "peer";
const SECURE_PREFIX = "secure,";
const HELLO = `${SECURE_PREFIX}hello,1,`;
const NONCE = `${SECURE_PREFIX}nonce,`;
const CONFIRM = `${SECURE_PREFIX}confirm,`;
const DATA = `${SECURE_PREFIX}data,`;
const RESPONSE = `${CONTROL_PREFIX}response,`;
const KDF_LABEL = "audiobus-protocol secure 1";
/** PBKDF2 rounds that stretch the secret, so every guess at it costs an attacker time. */
export const SECRET_ITERATIONS = 210000;
/** Longest encrypted message on the wire: base64 of three UTF-8 bytes per character, plus framing. */
export const MAX_SECURE_LENGTH = 4 * MAX_MESSAGE_LENGTH + 256;
// Messages held until a peer proves the secret, and handshakes kept besides the current one.
const MAX_OUTBOX = 256;
const MAX_SESSIONS = 4;
const MAX_AWAITED = 8;
const NONCE_BYTES = 16;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/; // 65-byte uncompressed P-256 point in base64url
const SESSION_NONCE = /^[A-Za-z0-9_-]{22}$/; // NONCE_BYTES in base64url
const toBase64 = (bytes) => {
    let text = "";
    for (let start = 0; start < bytes.length; start += 0x8000)
        text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromBase64 = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
const nonce = (counter) => {
    const iv = new Uint8Array(12);
    const view = new DataView(iv.buffer);
    view.setUint32(4, Math.floor(counter / 2 ** 32));
    view.setUint32(8, counter >>> 0);
    return iv;
};
/** Keeps at most MAX_SESSIONS entries, dropping the oldest that is not `keep`. */
const bound = (sessions, keep) => {
    for (const [key, session] of sessions) {
        if (sessions.size <= MAX_SESSIONS)
            break;
        if (session !== keep)
            sessions.delete(key);
    }
};
/** Case, spaces, dashes, dots and underscores are ignored, as with pairing codes. */
export function normalizeSecret(secret) {
    return secret.normalize("NFKC").toUpperCase().replace(/[\s._-]/gu, "");
}
/**
 * Encrypts and authenticates a bus with a shared secret, such as a pairing code or passphrase that
 * both applications know. Each side proves it knows the secret before anything else is accepted;
 * listeners without it see only random bytes, and cannot inject, alter or replay messages.
 *
 * Messages sent before a peer has proved the secret wait, in order, until one has.
 */
export function secureBus(bus, secret) {
    const normalized = normalizeSecret(secret);
    if (!normalized)
        throw new Error("A secret must contain letters or digits");
    const subtle = crypto.subtle;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    // The secret is stretched once; each session mixes it with a key agreement and fresh nonces.
    const salt = (async () => {
        const material = await subtle.importKey("raw", encoder.encode(normalized), "PBKDF2", false, [
            "deriveBits",
        ]);
        const bits = await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(KDF_LABEL), iterations: SECRET_ITERATIONS }, material, 256);
        return new Uint8Array(bits);
    })();
    const identity = (async () => {
        const pair = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
            "deriveBits",
        ]));
        return { pair, pub: toBase64(new Uint8Array(await subtle.exportKey("raw", pair.publicKey))) };
    })();
    void salt.catch(() => { });
    void identity.catch(() => { });
    // Handshakes in progress, and sessions whose peer proved the secret, by sender.
    const pending = new Map();
    const proven = new Map();
    const outbox = [];
    const awaited = [];
    const receivers = new Set();
    let current;
    let unsubscribe;
    let sending = Promise.resolve();
    let receiving = Promise.resolve();
    const derive = async (session) => {
        try {
            const me = await identity;
            const theirs = await subtle.importKey("raw", fromBase64(session.pub), { name: "ECDH", namedCurve: "P-256" }, false, []);
            const shared = await subtle.deriveBits({ name: "ECDH", public: theirs }, me.pair.privateKey, 256);
            const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
            const low = me.pub < session.pub;
            const [first, second] = low
                ? [`${me.pub},${session.mine}`, `${session.pub},${session.theirs}`]
                : [`${session.pub},${session.theirs}`, `${me.pub},${session.mine}`];
            const info = encoder.encode(`${KDF_LABEL},${first},${second}`);
            const bits = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: await salt, info }, material, 768));
            // One key per direction, so the two sides never reuse a nonce under the same key.
            const aes = (bytes, use) => subtle.importKey("raw", bytes, "AES-GCM", false, [use]);
            const [upward, downward] = [bits.subarray(0, 32), bits.subarray(32, 64)];
            return {
                send: await aes(low ? upward : downward, "encrypt"),
                receive: await aes(low ? downward : upward, "decrypt"),
                confirm: await subtle.importKey("raw", bits.subarray(64), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
            };
        }
        catch {
            return undefined;
        }
    };
    const seal = (session, message) => {
        const counter = ++session.sent;
        sending = sending
            .then(async () => {
            const keys = await session.keys;
            if (!keys)
                return;
            const sealed = await subtle.encrypt({ name: "AES-GCM", iv: nonce(counter) }, keys.send, encoder.encode(message));
            bus.send(`${DATA}${counter},${toBase64(new Uint8Array(sealed))}`);
        })
            .catch(() => {
            /* The bus refused it; the protocol's request timeouts report the loss. */
        });
    };
    const follow = (session) => {
        current = session;
        bus.follow(session.from);
        for (const message of outbox.splice(0))
            seal(session, message);
    };
    const open = async (session, sealed) => {
        const comma = sealed.indexOf(",");
        const counter = Number(sealed.slice(0, comma));
        // Counters only rise, so a recorded message cannot be replayed within its session.
        if (comma < 1 || !Number.isSafeInteger(counter) || counter <= session.received)
            return;
        const keys = await session.keys;
        if (!keys)
            return;
        try {
            const plain = await subtle.decrypt({ name: "AES-GCM", iv: nonce(counter) }, keys.receive, fromBase64(sealed.slice(comma + 1)));
            session.received = counter;
            return decoder.decode(plain);
        }
        catch {
            return;
        }
    };
    const handle = async (message, from) => {
        if (from === PLAIN_SENDER) {
            receivers.forEach((receive) => receive(message));
            return;
        }
        if (message.startsWith(HELLO)) {
            const pub = message.slice(HELLO.length);
            const me = await identity;
            if (!PUBLIC_KEY.test(pub) || pub === me.pub)
                return;
            if (pending.get(from)?.pub === pub || proven.get(from)?.pub === pub)
                return;
            // A newcomer: introduce this side, and start a session with a nonce of its own.
            bus.send(HELLO + me.pub);
            const mine = toBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
            const session = { from, pub, mine, sent: 0, received: 0 };
            pending.delete(from);
            pending.set(from, session);
            bound(pending);
            bus.send(`${NONCE}${pub},${mine}`);
            return;
        }
        if (message.startsWith(NONCE)) {
            const [to, theirs] = message.slice(NONCE.length).split(",");
            const me = await identity;
            const session = pending.get(from);
            // The first nonce for a session counts; later ones, replayed or forged, are ignored.
            if (to !== me.pub || !theirs || !SESSION_NONCE.test(theirs) || !session || session.theirs)
                return;
            session.theirs = theirs;
            session.keys = derive(session);
            const keys = await session.keys;
            if (!keys)
                return;
            const proof = await subtle.sign("HMAC", keys.confirm, encoder.encode(`${me.pub},${session.pub}`));
            bus.send(`${CONFIRM}${session.pub},${toBase64(new Uint8Array(proof))}`);
            return;
        }
        if (message.startsWith(CONFIRM)) {
            const [to, proof] = message.slice(CONFIRM.length).split(",");
            const me = await identity;
            const session = pending.get(from);
            if (to !== me.pub || !proof || !session?.keys)
                return;
            const keys = await session.keys;
            let valid = false;
            try {
                valid =
                    !!keys &&
                        (await subtle.verify("HMAC", keys.confirm, fromBase64(proof), encoder.encode(`${session.pub},${me.pub}`)));
            }
            catch {
                /* Malformed proofs fail like wrong ones. */
            }
            // A wrong proof is ignored, so a forged one cannot cancel the real one that follows.
            if (!valid)
                return;
            pending.delete(from);
            proven.delete(from);
            proven.set(from, session);
            bound(proven, current);
            if (!current)
                follow(session);
            return;
        }
        if (message.startsWith(DATA)) {
            const sealed = message.slice(DATA.length);
            const candidates = [current?.from === from ? current : undefined, proven.get(from)].filter((session, index, all) => !!session && all.indexOf(session) === index);
            for (const session of candidates) {
                const plain = await open(session, sealed);
                if (plain === undefined)
                    continue;
                if (session !== current) {
                    // Another holder of the secret, such as a reloaded application, takes over only when it
                    // starts a connection, or accepts the one this side started.
                    const control = plain.startsWith(RESPONSE) ? decodeControl(plain) : undefined;
                    const accepted = control?.kind === "response" &&
                        awaited.includes(control.body.id) &&
                        Object.hasOwn(control.body, "result");
                    if (!isInitializeRequest(plain) && !accepted)
                        return;
                    follow(session);
                }
                receivers.forEach((receive) => receive(plain));
                return;
            }
        }
    };
    return {
        send(message) {
            if (message.length > MAX_MESSAGE_LENGTH)
                throw new Error("Message exceeds limit");
            if (isInitializeRequest(message)) {
                // Offer a new connection to every side that has proved the secret, as on an open port.
                const id = decodeControl(message).body.id;
                awaited.push(id);
                if (awaited.length > MAX_AWAITED)
                    awaited.shift();
                const sessions = [...proven.values()];
                if (current && !sessions.includes(current))
                    sessions.push(current);
                if (sessions.length) {
                    sessions.forEach((session) => seal(session, message));
                    return;
                }
            }
            else if (current) {
                seal(current, message);
                return;
            }
            if (outbox.length >= MAX_OUTBOX)
                throw new Error("No peer has proved the secret yet");
            outbox.push(message);
        },
        listen(receive) {
            receivers.add(receive);
            if (!unsubscribe) {
                unsubscribe = bus.listen((message, from) => {
                    receiving = receiving.then(() => handle(message, from)).catch(() => { });
                });
                void identity.then((me) => bus.send(HELLO + me.pub)).catch(() => { });
            }
            return () => {
                receivers.delete(receive);
                if (receivers.size || !unsubscribe)
                    return;
                unsubscribe();
                unsubscribe = undefined;
                outbox.length = 0;
            };
        },
    };
}
/**
 * Encrypts and authenticates a transport that reaches one peer, such as a WebSocket relay or an
 * extension's MessagePort, with a secret both applications know. Both sides must use it.
 */
export function secureTransport(transport, options) {
    return secureBus({
        send: (message) => transport.send(message),
        listen: (receive) => transport.listen((message) => {
            if (typeof message === "string")
                receive(message, POINT_TO_POINT);
        }),
        follow() { },
    }, options.secret);
}
