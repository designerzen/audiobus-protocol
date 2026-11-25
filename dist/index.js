import { CommandRegistry, ProtocolError, object, assertJson, parseCommandDescriptors, parsePropertyDescriptors, parseBundles, } from "./registry.js";
import { decodeUmp, encodeUmp } from "./ump.js";
import { CONTROL_PREFIX, MAX_MESSAGE_LENGTH, decodeControl, decodeMidi, isInitializeRequest, } from "./control.js";
export * from "./registry.js";
export * from "./transport.js";
export * from "./transports.js";
export { secureTransport, normalizeSecret, SECRET_ITERATIONS, MAX_SECURE_LENGTH } from "./secure.js";
export * from "./ump.js";
export { CONTROL_PREFIX, MAX_MESSAGE_LENGTH, decodeControl, decodeMidi, isInitializeRequest };
export const PROTOCOL_VERSION = 1;
/** Requests one peer executes at once; further requests fail with `limit_exceeded`. */
export const MAX_CONCURRENT_REQUESTS = 32;
/** Failed initializations, including retried copies, before a peer stops accepting codes. */
export const MAX_PAIRING_ATTEMPTS = 5;
// 32 symbols without I, O, 0 or 1, so each random byte maps without bias.
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A random code for a person to copy from one application into the other. */
export function generatePairingCode(length = 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => PAIRING_ALPHABET[byte & 31]).join("");
}
/** Case- and separator-insensitive comparison form. */
export function normalizePairingCode(code) {
    return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** Groups of four for display, for example `ABCD-EFGH`. */
export function formatPairingCode(code) {
    return normalizePairingCode(code).match(/.{1,4}/g)?.join("-") ?? "";
}
/** Random, unguessable prefix so one connection's request IDs never match another's. */
function requestToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function sameCode(a, b) {
    let difference = a.length ^ b.length;
    for (let i = 0; i < b.length; i++)
        difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return difference === 0;
}
export class Peer {
    transport;
    options;
    registry;
    pending = new Map();
    topics = new Set();
    sequence = 0;
    initialized = false;
    remoteCapabilities = new Set();
    closed = false;
    authorized;
    requiredCode;
    failedPairings = 0;
    token = requestToken();
    handling = 0;
    prepared;
    unlisten;
    unobserve;
    constructor(transport, options) {
        this.transport = transport;
        this.options = options;
        this.registry = options.registry ?? new CommandRegistry();
        if (options.requirePairingCode !== undefined) {
            this.requiredCode = normalizePairingCode(options.requirePairingCode);
            if (!this.requiredCode)
                throw new Error("A pairing code must contain letters or digits");
        }
        this.authorized = this.requiredCode === undefined;
        this.unlisten = transport.listen((message) => {
            void this.receive(message);
        });
        this.unobserve = this.registry.observe((topic, data) => {
            if (!this.initialized || !this.topics.has(topic))
                return;
            try {
                this.send("event", { topic, data });
            }
            catch (error) {
                // One peer's failure must not stop the registry notifying its other listeners.
                this.report(error, `event ${topic}`);
            }
        });
    }
    report(error, context) {
        try {
            this.options.onError?.(error, context);
        }
        catch {
            /* An error hook must not fail the caller. */
        }
    }
    send(kind, body) {
        if (this.closed)
            throw new ProtocolError("closed", "Peer is closed");
        assertJson(body);
        const message = `${CONTROL_PREFIX}${kind},${encodeURIComponent(JSON.stringify(body))}`;
        if (message.length > MAX_MESSAGE_LENGTH)
            throw new ProtocolError("message_too_large", "Message exceeds limit");
        this.transport.send(message);
    }
    get capabilities() {
        return [
            "commands",
            "events",
            "webmidilink",
            "properties",
            "bundles",
            "retained",
            ...(this.options.ump ? ["ump"] : []),
        ];
    }
    /** False until the remote presents the required pairing code; always true without one. */
    get isAuthorized() {
        return this.authorized;
    }
    /** True after too many incorrect pairing codes; the peer must be replaced to pair again. */
    get isLocked() {
        return this.failedPairings >= MAX_PAIRING_ATTEMPTS;
    }
    /** True once either side has completed initialization and until the connection ends. */
    get isInitialized() {
        return this.initialized;
    }
    supports(capability) {
        return (this.initialized &&
            this.capabilities.includes(capability) &&
            this.remoteCapabilities.has(capability));
    }
    readCapabilities(value) {
        if (value === undefined)
            return new Set(["commands", "events", "webmidilink"]);
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
            throw new ProtocolError("invalid_params", "Invalid capabilities");
        return new Set(value);
    }
    requireCapability(capability) {
        if (this.closed)
            throw new ProtocolError("closed", "Peer is closed");
        if (!this.supports(capability))
            throw new ProtocolError("unsupported_capability", `Capability not negotiated: ${capability}`);
    }
    acceptCapabilities(value) {
        const capabilities = this.readCapabilities(value);
        if (this.initialized &&
            (capabilities.size !== this.remoteCapabilities.size ||
                [...capabilities].some((item) => !this.remoteCapabilities.has(item)))) {
            throw new ProtocolError("invalid_params", "Capabilities cannot change within a connection");
        }
        this.remoteCapabilities = capabilities;
    }
    async connect() {
        const result = await this.request("initialize", {
            protocolVersion: PROTOCOL_VERSION,
            ...this.options.identity,
            capabilities: this.capabilities,
            ...(this.options.pairingCode === undefined
                ? {}
                : { pairingCode: normalizePairingCode(this.options.pairingCode) }),
        });
        if (!object(result) || result.protocolVersion !== PROTOCOL_VERSION) {
            throw new ProtocolError("unsupported_version", "Peer did not negotiate protocol version 1");
        }
        this.acceptCapabilities(result.capabilities);
        this.initialized = true;
        return result;
    }
    request(method, params = {}) {
        if (this.closed)
            return Promise.reject(new ProtocolError("closed", "Peer is closed"));
        if (!this.initialized && method !== "initialize")
            return Promise.reject(new ProtocolError("not_initialized", "Connect first"));
        const id = `${this.token}-${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                clearInterval(this.pending.get(id)?.retry);
                this.pending.delete(id);
                reject(new ProtocolError("timeout", `Request timed out: ${method}`));
            }, this.options.timeoutMs ?? 5000);
            this.pending.set(id, { resolve, reject, timer });
            const send = () => {
                try {
                    this.send("request", { id, method, params });
                }
                catch (error) {
                    clearTimeout(timer);
                    clearInterval(this.pending.get(id)?.retry);
                    this.pending.delete(id);
                    reject(error);
                }
            };
            send();
            // Initialization is idempotent; listeners may be installed after a popup loads.
            // Never retry application commands, which can already have executed remotely.
            if (method === "initialize" && this.pending.has(id)) {
                this.pending.get(id).retry = setInterval(send, 250);
            }
        });
    }
    list() {
        return this.request("commands.list");
    }
    async discover() {
        return parseCommandDescriptors(await this.list());
    }
    async listProperties() {
        this.requireCapability("properties");
        return parsePropertyDescriptors(await this.request("properties.list"));
    }
    async getProperty(id) {
        this.requireCapability("properties");
        return this.request("properties.get", { id });
    }
    async setProperty(id, value) {
        this.requireCapability("properties");
        return this.request("properties.set", { id, value });
    }
    async listBundles() {
        this.requireCapability("bundles");
        return parseBundles(await this.request("bundles.list"));
    }
    sendUmp(words) {
        this.requireCapability("ump");
        let message;
        try {
            message = encodeUmp(words);
        }
        catch {
            throw new ProtocolError("invalid_ump", "Expected one complete UMP packet");
        }
        this.transport.send(message);
    }
    sendLink(message) {
        if (this.closed)
            throw new ProtocolError("closed", "Peer is closed");
        if (message.length > MAX_MESSAGE_LENGTH)
            throw new ProtocolError("message_too_large", "Message exceeds limit");
        this.transport.send(message);
    }
    announceReady() {
        this.sendLink("link,ready");
    }
    requestPatch() {
        this.sendLink("link,reqpatch");
    }
    setPatch(patch) {
        if (typeof patch !== "string" || patch.includes(","))
            throw new ProtocolError("invalid_params", "Patch must be a comma-free string");
        this.sendLink(`link,setpatch,${patch}`);
    }
    call(command, args = {}) {
        return this.request("commands.call", { command, arguments: args });
    }
    subscribe(topic) {
        return this.request("events.subscribe", { topic });
    }
    /** Subscribe and receive the topic's current state in the same response, when retained. */
    async subscribeState(topic) {
        const result = await this.subscribe(topic);
        return object(result) && Object.hasOwn(result, "state")
            ? { retained: true, state: result.state }
            : { retained: false };
    }
    unsubscribe(topic) {
        return this.request("events.unsubscribe", { topic });
    }
    sendMidi(bytes) {
        const values = Array.from(bytes);
        if (values.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
            throw new ProtocolError("invalid_midi", "Invalid MIDI bytes");
        const message = `midi,${values.map((x) => x.toString(16)).join(",")}`;
        if (!decodeMidi(message) || message.length > MAX_MESSAGE_LENGTH)
            throw new ProtocolError("invalid_midi", "Expected one complete MIDI message");
        if (this.closed)
            throw new ProtocolError("closed", "Peer is closed");
        this.transport.send(message);
    }
    async receive(message) {
        if (this.closed || typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH)
            return;
        // Until the remote proves the pairing code, only control envelopes are processed; requests
        // other than initialize are rejected in handle().
        if (!this.authorized && !message.startsWith(CONTROL_PREFIX))
            return;
        try {
            if (message.startsWith("ump,")) {
                if (!this.supports("ump"))
                    return;
                const words = decodeUmp(message);
                if (words)
                    this.options.onUmp?.(words);
                return;
            }
            if (message.startsWith("midi,")) {
                const bytes = decodeMidi(message);
                if (bytes)
                    this.options.onMidi?.(bytes);
                return;
            }
            if (message === "link,reqpatch" && this.options.getPatch) {
                const patch = this.options.getPatch();
                if (patch.includes(",") || patch.length + 11 > MAX_MESSAGE_LENGTH)
                    return;
                this.transport.send(`link,patch,${patch}`);
                return;
            }
            if (message === "link,ready") {
                this.options.onReady?.();
                return;
            }
            if (message.startsWith("link,setpatch,")) {
                const patch = message.slice(14);
                if (!patch.includes(","))
                    this.options.setPatch?.(patch);
                return;
            }
            if (message.startsWith("link,patch,")) {
                const patch = message.slice(11);
                if (!patch.includes(","))
                    this.options.onPatch?.(patch);
                return;
            }
            const control = decodeControl(message);
            if (!control)
                return;
            const { kind, body } = control;
            if (kind === "bye") {
                if (this.initialized && this.authorized)
                    this.endSession();
            }
            else if (kind === "response" && typeof body.id === "string") {
                const pending = this.pending.get(body.id);
                if (!pending || !(Object.hasOwn(body, "result") !== Object.hasOwn(body, "error")))
                    return;
                if (Object.hasOwn(body, "error") &&
                    (!object(body.error) ||
                        typeof body.error.code !== "string" ||
                        typeof body.error.message !== "string"))
                    return;
                clearTimeout(pending.timer);
                clearInterval(pending.retry);
                this.pending.delete(body.id);
                if (object(body.error))
                    pending.reject(new ProtocolError(body.error.code, body.error.message));
                else
                    pending.resolve(body.result);
            }
            else if (kind === "event" &&
                this.initialized &&
                this.authorized &&
                typeof body.topic === "string" &&
                Object.hasOwn(body, "data")) {
                this.options.onEvent?.(body.topic, body.data);
            }
            else if (kind === "request" &&
                typeof body.id === "string" &&
                typeof body.method === "string") {
                const id = body.id;
                const fail = (error) => {
                    if (!this.closed)
                        this.send("response", {
                            id,
                            error: {
                                code: error instanceof ProtocolError ? error.code : "internal_error",
                                message: error instanceof ProtocolError ? error.message : "Command failed",
                            },
                        });
                };
                const reply = (result) => {
                    try {
                        if (this.closed)
                            return;
                        const prepared = this.prepared;
                        this.prepared = undefined;
                        // A reply already serialized by fits() is sent as it is, not encoded again.
                        if (prepared?.id === id && prepared.result === result)
                            this.transport.send(prepared.message);
                        else
                            this.send("response", { id, result });
                    }
                    catch (error) {
                        fail(error);
                    }
                };
                if (this.handling >= MAX_CONCURRENT_REQUESTS) {
                    fail(new ProtocolError("limit_exceeded", "Too many requests in progress"));
                    return;
                }
                this.handling++;
                let result;
                try {
                    result = this.handle(body.method, body.params, id);
                }
                catch (error) {
                    this.handling--;
                    fail(error);
                    return;
                }
                // Synchronous results, such as subscriptions with retained state, are sent in the same
                // task, so no event can be sent between capturing state and replying with it.
                if (!(result instanceof Promise)) {
                    this.handling--;
                    reply(result);
                    return;
                }
                try {
                    result = await result;
                }
                catch (error) {
                    this.handling--;
                    fail(error);
                    return;
                }
                this.handling--;
                reply(result);
            }
        }
        catch (error) {
            // Malformed envelopes and failing application callbacks never reach the transport.
            this.report(error, "receive");
        }
    }
    /** The remote ended the connection: forget its subscriptions and fail its requests. */
    endSession() {
        this.initialized = false;
        // A later connection on the same transport must present the pairing code again.
        this.authorized = this.requiredCode === undefined;
        this.remoteCapabilities.clear();
        this.topics.clear();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            clearInterval(pending.retry);
            pending.reject(new ProtocolError("closed", "Peer ended the connection"));
        }
        this.pending.clear();
        try {
            this.options.onClosed?.();
        }
        catch (error) {
            this.report(error, "onClosed");
        }
    }
    checkPairing(code) {
        if (this.requiredCode === undefined)
            return;
        if (this.failedPairings >= MAX_PAIRING_ATTEMPTS)
            throw new ProtocolError("unauthorized", "Too many incorrect pairing codes; pair again");
        if (typeof code !== "string" ||
            code.length > 64 ||
            !sameCode(normalizePairingCode(code), this.requiredCode)) {
            this.failedPairings++;
            throw new ProtocolError("unauthorized", "Incorrect or missing pairing code");
        }
    }
    /** Serializes a reply once, keeping it for the send if it fits. */
    fits(id, result) {
        const message = `${CONTROL_PREFIX}response,${encodeURIComponent(JSON.stringify({ id, result }))}`;
        if (message.length > MAX_MESSAGE_LENGTH)
            return false;
        this.prepared = { id, result, message };
        return true;
    }
    handle(method, params, id = "") {
        if (!object(params))
            throw new ProtocolError("invalid_params", "Expected an argument object");
        if (method === "initialize") {
            if (params.protocolVersion !== PROTOCOL_VERSION)
                throw new ProtocolError("unsupported_version", "Expected protocol version 1");
            if (typeof params.name !== "string" || typeof params.version !== "string")
                throw new ProtocolError("invalid_params", "Expected peer identity");
            this.checkPairing(params.pairingCode);
            this.acceptCapabilities(params.capabilities);
            this.initialized = true;
            if (!this.authorized) {
                this.authorized = true;
                try {
                    this.options.onAuthorized?.();
                }
                catch {
                    /* Application callbacks cannot fail an accepted handshake. */
                }
            }
            return {
                ...this.options.identity,
                protocolVersion: PROTOCOL_VERSION,
                capabilities: this.capabilities,
                maxMessageLength: MAX_MESSAGE_LENGTH,
            };
        }
        if (!this.authorized)
            throw new ProtocolError("unauthorized", "Present the pairing code when initializing");
        if (!this.initialized)
            throw new ProtocolError("not_initialized", "Initialize first");
        switch (method) {
            case "properties.list":
                this.requireCapability("properties");
                return this.registry.listProperties();
            case "properties.get":
            case "properties.set":
                this.requireCapability("properties");
                if (typeof params.id !== "string")
                    throw new ProtocolError("invalid_params", "Expected property ID");
                if (method === "properties.set" && !Object.hasOwn(params, "value"))
                    throw new ProtocolError("invalid_params", "Expected property value");
                return method === "properties.get"
                    ? this.registry.getProperty(params.id)
                    : this.registry.setProperty(params.id, params.value);
            case "bundles.list":
                this.requireCapability("bundles");
                return this.registry.listBundles();
            case "commands.list":
                return this.registry.list();
            case "commands.call":
                if (typeof params.command !== "string")
                    throw new ProtocolError("invalid_params", "Expected command ID");
                return this.registry.call(params.command, params.arguments ?? {});
            case "events.subscribe":
            case "events.unsubscribe":
                if (typeof params.topic !== "string" || !params.topic.length || params.topic.length > 200)
                    throw new ProtocolError("invalid_params", "Expected a topic of 1–200 characters");
                if (method === "events.unsubscribe") {
                    this.topics.delete(params.topic);
                    return { topic: params.topic, subscribed: false };
                }
                if (this.topics.size >= 128 && !this.topics.has(params.topic))
                    throw new ProtocolError("limit_exceeded", "Too many subscriptions");
                {
                    const topic = params.topic, added = !this.topics.has(topic);
                    this.topics.add(topic);
                    try {
                        const retained = this.registry.readRetained(topic);
                        const result = retained
                            ? { topic, subscribed: true, state: retained.value }
                            : { topic, subscribed: true };
                        if (!this.fits(id, result))
                            throw new ProtocolError("message_too_large", "Retained state exceeds message limit");
                        return result;
                    }
                    catch (error) {
                        if (added)
                            this.topics.delete(topic);
                        throw error;
                    }
                }
            default:
                throw new ProtocolError("unknown_method", `Unknown method: ${method}`);
        }
    }
    /**
     * Ends the connection. The remote is told, unless `notify` is false, so it can release notes
     * and subscriptions held for this peer.
     */
    close(options = {}) {
        if (this.closed)
            return;
        if (options.notify !== false && this.initialized && this.authorized) {
            try {
                this.send("bye", {});
            }
            catch {
                /* The transport may already be gone. */
            }
        }
        this.closed = true;
        this.initialized = false;
        this.remoteCapabilities.clear();
        this.unlisten();
        this.unobserve();
        this.topics.clear();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            clearInterval(pending.retry);
            pending.reject(new ProtocolError("closed", "Peer closed before response"));
        }
        this.pending.clear();
    }
}
