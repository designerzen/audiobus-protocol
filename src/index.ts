import {
  CommandRegistry,
  ProtocolError,
  object,
  assertJson,
  parseCommandDescriptors,
  parsePropertyDescriptors,
  parseBundles,
  type PropertyDescriptor,
  type CapabilityBundle,
  type CommandDescriptor,
  type Json,
  type Params,
} from "./registry.js";
import type { Transport } from "./transport.js";
import { decodeUmp, encodeUmp } from "./ump.js";
export * from "./registry.js";
export * from "./transport.js";
export * from "./ump.js";

export const PROTOCOL_VERSION = 1;
export const CONTROL_PREFIX = "control,";
export const MAX_MESSAGE_LENGTH = 262144;
/** Requests one peer executes at once; further requests fail with `limit_exceeded`. */
export const MAX_CONCURRENT_REQUESTS = 32;
/** Failed initializations, including retried copies, before a peer stops accepting codes. */
export const MAX_PAIRING_ATTEMPTS = 5;
// 32 symbols without I, O, 0 or 1, so each random byte maps without bias.
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random code for a person to copy from one application into the other. */
export function generatePairingCode(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => PAIRING_ALPHABET[byte & 31]).join("");
}
/** Case- and separator-insensitive comparison form. */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** Groups of four for display, for example `ABCD-EFGH`. */
export function formatPairingCode(code: string): string {
  return normalizePairingCode(code).match(/.{1,4}/g)?.join("-") ?? "";
}
/** Random, unguessable prefix so one connection's request IDs never match another's. */
function requestToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
/** Splits a control envelope into its kind and decoded JSON body; undefined when malformed. */
export function decodeControl(
  message: string,
): { kind: string; body: Record<string, unknown> } | undefined {
  if (!message.startsWith(CONTROL_PREFIX) || message.length > MAX_MESSAGE_LENGTH) return;
  const separator = message.indexOf(",", CONTROL_PREFIX.length);
  if (separator < 0) return;
  try {
    const body: unknown = JSON.parse(decodeURIComponent(message.slice(separator + 1)));
    return object(body) ? { kind: message.slice(CONTROL_PREFIX.length, separator), body } : undefined;
  } catch {
    return;
  }
}
/** True for the first message a new connection sends: an `initialize` request. */
export function isInitializeRequest(message: string): boolean {
  const control = decodeControl(message);
  return (
    control?.kind === "request" &&
    control.body.method === "initialize" &&
    typeof control.body.id === "string"
  );
}
function sameCode(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export interface Identity {
  name: string;
  version: string;
}
type Pending = {
  resolve: (value: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setInterval>;
};
export interface PeerOptions {
  identity: Identity;
  registry?: CommandRegistry;
  timeoutMs?: number;
  onMidi?: (bytes: Uint8Array) => void;
  onEvent?: (topic: string, data: Json) => void;
  getPatch?: () => string;
  setPatch?: (patch: string) => void;
  onPatch?: (patch: string) => void;
  onReady?: () => void;
  /** Explicit opt-in to UMP transport; both peers must advertise it. */
  ump?: boolean;
  onUmp?: (words: number[]) => void;
  /** Code presented to the remote peer when this peer initializes it. */
  pairingCode?: string;
  /**
   * Code the remote peer must present before this peer handles its requests, MIDI or patches.
   * Use it when the peer window was not chosen by this application, such as `window.opener`.
   */
  requirePairingCode?: string;
  /** Called once the remote peer has presented the required pairing code. */
  onAuthorized?: () => void;
  /** Called when the remote peer closes its connection; held state should be released. */
  onClosed?: () => void;
  /**
   * Receives failures that would otherwise be dropped: malformed messages, application callbacks
   * that throw, and events that cannot be sent. Never called for errors returned to the remote.
   */
  onError?: (error: unknown, context: string) => void;
}
export interface SubscriptionState {
  /** True when the remote provides retained state for the topic. */
  retained: boolean;
  /** State captured atomically with the subscription; later changes arrive as events. */
  state?: Json;
}

/** One full MIDI message; no running status, concatenated messages, or invalid data bytes. */
export function decodeMidi(message: string): Uint8Array | undefined {
  const fields = message.split(",");
  if (
    fields.shift() !== "midi" ||
    !fields.length ||
    fields.some((x) => !/^[0-9a-f]{1,2}$/i.test(x))
  )
    return;
  const bytes = fields.map((x) => parseInt(x, 16)),
    status = bytes[0]!;
  if (status < 0x80) return;
  if (status === 0xf0) {
    if (bytes.length < 2 || bytes.at(-1) !== 0xf7 || bytes.slice(1, -1).some((x) => x > 127))
      return;
  } else {
    const length =
      status < 0xf0
        ? status >> 4 === 0xc || status >> 4 === 0xd
          ? 2
          : 3
        : status === 0xf1 || status === 0xf3
          ? 2
          : status === 0xf2
            ? 3
            : 1;
    if (
      [0xf4, 0xf5, 0xf7, 0xf9, 0xfd].includes(status) ||
      bytes.length !== length ||
      bytes.slice(1).some((x) => x > 127)
    )
      return;
  }
  return Uint8Array.from(bytes);
}
export class Peer {
  readonly registry: CommandRegistry;
  private pending = new Map<string, Pending>();
  private topics = new Set<string>();
  private sequence = 0;
  private initialized = false;
  private remoteCapabilities = new Set<string>();
  private closed = false;
  private authorized: boolean;
  private requiredCode?: string;
  private failedPairings = 0;
  private readonly token = requestToken();
  private handling = 0;
  private prepared?: { id: string; result: Json; message: string };
  private unlisten: () => void;
  private unobserve: () => void;
  constructor(
    private transport: Transport,
    private options: PeerOptions,
  ) {
    this.registry = options.registry ?? new CommandRegistry();
    if (options.requirePairingCode !== undefined) {
      this.requiredCode = normalizePairingCode(options.requirePairingCode);
      if (!this.requiredCode) throw new Error("A pairing code must contain letters or digits");
    }
    this.authorized = this.requiredCode === undefined;
    this.unlisten = transport.listen((message) => {
      void this.receive(message);
    });
    this.unobserve = this.registry.observe((topic, data) => {
      if (!this.initialized || !this.topics.has(topic)) return;
      try {
        this.send("event", { topic, data });
      } catch (error) {
        // One peer's failure must not stop the registry notifying its other listeners.
        this.report(error, `event ${topic}`);
      }
    });
  }
  private report(error: unknown, context: string): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      /* An error hook must not fail the caller. */
    }
  }
  private send(kind: string, body: Record<string, unknown>): void {
    if (this.closed) throw new ProtocolError("closed", "Peer is closed");
    assertJson(body);
    const message = `${CONTROL_PREFIX}${kind},${encodeURIComponent(JSON.stringify(body))}`;
    if (message.length > MAX_MESSAGE_LENGTH)
      throw new ProtocolError("message_too_large", "Message exceeds limit");
    this.transport.send(message);
  }
  get capabilities(): string[] {
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
  get isAuthorized(): boolean {
    return this.authorized;
  }
  /** True after too many incorrect pairing codes; the peer must be replaced to pair again. */
  get isLocked(): boolean {
    return this.failedPairings >= MAX_PAIRING_ATTEMPTS;
  }
  /** True once either side has completed initialization and until the connection ends. */
  get isInitialized(): boolean {
    return this.initialized;
  }
  supports(capability: string): boolean {
    return (
      this.initialized &&
      this.capabilities.includes(capability) &&
      this.remoteCapabilities.has(capability)
    );
  }
  private readCapabilities(value: unknown): Set<string> {
    if (value === undefined) return new Set(["commands", "events", "webmidilink"]);
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw new ProtocolError("invalid_params", "Invalid capabilities");
    return new Set(value);
  }
  private requireCapability(capability: string): void {
    if (this.closed) throw new ProtocolError("closed", "Peer is closed");
    if (!this.supports(capability))
      throw new ProtocolError("unsupported_capability", `Capability not negotiated: ${capability}`);
  }
  private acceptCapabilities(value: unknown): void {
    const capabilities = this.readCapabilities(value);
    if (
      this.initialized &&
      (capabilities.size !== this.remoteCapabilities.size ||
        [...capabilities].some((item) => !this.remoteCapabilities.has(item)))
    ) {
      throw new ProtocolError("invalid_params", "Capabilities cannot change within a connection");
    }
    this.remoteCapabilities = capabilities;
  }
  async connect(): Promise<Json> {
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
  request(method: string, params: Params = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new ProtocolError("closed", "Peer is closed"));
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
        } catch (error) {
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
        this.pending.get(id)!.retry = setInterval(send, 250);
      }
    });
  }
  list(): Promise<Json> {
    return this.request("commands.list");
  }
  async discover(): Promise<CommandDescriptor[]> {
    return parseCommandDescriptors(await this.list());
  }
  async listProperties(): Promise<PropertyDescriptor[]> {
    this.requireCapability("properties");
    return parsePropertyDescriptors(await this.request("properties.list"));
  }
  async getProperty(id: string): Promise<Json> {
    this.requireCapability("properties");
    return this.request("properties.get", { id });
  }
  async setProperty(id: string, value: Json): Promise<Json> {
    this.requireCapability("properties");
    return this.request("properties.set", { id, value });
  }
  async listBundles(): Promise<CapabilityBundle[]> {
    this.requireCapability("bundles");
    return parseBundles(await this.request("bundles.list"));
  }
  sendUmp(words: ArrayLike<number>): void {
    this.requireCapability("ump");
    let message: string;
    try {
      message = encodeUmp(words);
    } catch {
      throw new ProtocolError("invalid_ump", "Expected one complete UMP packet");
    }
    this.transport.send(message);
  }
  private sendLink(message: string): void {
    if (this.closed) throw new ProtocolError("closed", "Peer is closed");
    if (message.length > MAX_MESSAGE_LENGTH)
      throw new ProtocolError("message_too_large", "Message exceeds limit");
    this.transport.send(message);
  }
  announceReady(): void {
    this.sendLink("link,ready");
  }
  requestPatch(): void {
    this.sendLink("link,reqpatch");
  }
  setPatch(patch: string): void {
    if (typeof patch !== "string" || patch.includes(","))
      throw new ProtocolError("invalid_params", "Patch must be a comma-free string");
    this.sendLink(`link,setpatch,${patch}`);
  }
  call(command: string, args: Params = {}): Promise<Json> {
    return this.request("commands.call", { command, arguments: args });
  }
  subscribe(topic: string): Promise<Json> {
    return this.request("events.subscribe", { topic });
  }
  /** Subscribe and receive the topic's current state in the same response, when retained. */
  async subscribeState(topic: string): Promise<SubscriptionState> {
    const result = await this.subscribe(topic);
    return object(result) && Object.hasOwn(result, "state")
      ? { retained: true, state: result.state as Json }
      : { retained: false };
  }
  unsubscribe(topic: string): Promise<Json> {
    return this.request("events.unsubscribe", { topic });
  }
  sendMidi(bytes: ArrayLike<number>): void {
    const values = Array.from(bytes);
    if (values.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
      throw new ProtocolError("invalid_midi", "Invalid MIDI bytes");
    const message = `midi,${values.map((x) => x.toString(16)).join(",")}`;
    if (!decodeMidi(message) || message.length > MAX_MESSAGE_LENGTH)
      throw new ProtocolError("invalid_midi", "Expected one complete MIDI message");
    if (this.closed) throw new ProtocolError("closed", "Peer is closed");
    this.transport.send(message);
  }
  private async receive(message: unknown): Promise<void> {
    if (this.closed || typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) return;
    // Until the remote proves the pairing code, only control envelopes are processed; requests
    // other than initialize are rejected in handle().
    if (!this.authorized && !message.startsWith(CONTROL_PREFIX)) return;
    try {
      if (message.startsWith("ump,")) {
        if (!this.supports("ump")) return;
        const words = decodeUmp(message);
        if (words) this.options.onUmp?.(words);
        return;
      }
      if (message.startsWith("midi,")) {
        const bytes = decodeMidi(message);
        if (bytes) this.options.onMidi?.(bytes);
        return;
      }
      if (message === "link,reqpatch" && this.options.getPatch) {
        const patch = this.options.getPatch();
        if (patch.includes(",") || patch.length + 11 > MAX_MESSAGE_LENGTH) return;
        this.transport.send(`link,patch,${patch}`);
        return;
      }
      if (message === "link,ready") {
        this.options.onReady?.();
        return;
      }
      if (message.startsWith("link,setpatch,")) {
        const patch = message.slice(14);
        if (!patch.includes(",")) this.options.setPatch?.(patch);
        return;
      }
      if (message.startsWith("link,patch,")) {
        const patch = message.slice(11);
        if (!patch.includes(",")) this.options.onPatch?.(patch);
        return;
      }
      const control = decodeControl(message);
      if (!control) return;
      const { kind, body } = control;
      if (kind === "bye") {
        if (this.initialized && this.authorized) this.endSession();
      } else if (kind === "response" && typeof body.id === "string") {
        const pending = this.pending.get(body.id);
        if (!pending || !(Object.hasOwn(body, "result") !== Object.hasOwn(body, "error"))) return;
        if (
          Object.hasOwn(body, "error") &&
          (!object(body.error) ||
            typeof body.error.code !== "string" ||
            typeof body.error.message !== "string")
        )
          return;
        clearTimeout(pending.timer);
        clearInterval(pending.retry);
        this.pending.delete(body.id);
        if (object(body.error))
          pending.reject(
            new ProtocolError(body.error.code as string, body.error.message as string),
          );
        else pending.resolve(body.result as Json);
      } else if (
        kind === "event" &&
        this.initialized &&
        this.authorized &&
        typeof body.topic === "string" &&
        Object.hasOwn(body, "data")
      ) {
        this.options.onEvent?.(body.topic, body.data as Json);
      } else if (
        kind === "request" &&
        typeof body.id === "string" &&
        typeof body.method === "string"
      ) {
        const id = body.id;
        const fail = (error: unknown) => {
          if (!this.closed)
            this.send("response", {
              id,
              error: {
                code: error instanceof ProtocolError ? error.code : "internal_error",
                message: error instanceof ProtocolError ? error.message : "Command failed",
              },
            });
        };
        const reply = (result: Json) => {
          try {
            if (this.closed) return;
            const prepared = this.prepared;
            this.prepared = undefined;
            // A reply already serialized by fits() is sent as it is, not encoded again.
            if (prepared?.id === id && prepared.result === result) this.transport.send(prepared.message);
            else this.send("response", { id, result });
          } catch (error) {
            fail(error);
          }
        };
        if (this.handling >= MAX_CONCURRENT_REQUESTS) {
          fail(new ProtocolError("limit_exceeded", "Too many requests in progress"));
          return;
        }
        this.handling++;
        let result: Json | Promise<Json>;
        try {
          result = this.handle(body.method, body.params, id);
        } catch (error) {
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
        } catch (error) {
          this.handling--;
          fail(error);
          return;
        }
        this.handling--;
        reply(result);
      }
    } catch (error) {
      // Malformed envelopes and failing application callbacks never reach the transport.
      this.report(error, "receive");
    }
  }
  /** The remote ended the connection: forget its subscriptions and fail its requests. */
  private endSession(): void {
    this.initialized = false;
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
    } catch (error) {
      this.report(error, "onClosed");
    }
  }
  private checkPairing(code: unknown): void {
    if (this.requiredCode === undefined) return;
    if (this.failedPairings >= MAX_PAIRING_ATTEMPTS)
      throw new ProtocolError("unauthorized", "Too many incorrect pairing codes; pair again");
    if (
      typeof code !== "string" ||
      code.length > 64 ||
      !sameCode(normalizePairingCode(code), this.requiredCode)
    ) {
      this.failedPairings++;
      throw new ProtocolError("unauthorized", "Incorrect or missing pairing code");
    }
  }
  /** Serializes a reply once, keeping it for the send if it fits. */
  private fits(id: string, result: Json): boolean {
    const message = `${CONTROL_PREFIX}response,${encodeURIComponent(JSON.stringify({ id, result }))}`;
    if (message.length > MAX_MESSAGE_LENGTH) return false;
    this.prepared = { id, result, message };
    return true;
  }
  private handle(method: string, params: unknown, id = ""): Json | Promise<Json> {
    if (!object(params)) throw new ProtocolError("invalid_params", "Expected an argument object");
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
        } catch {
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
    if (!this.initialized) throw new ProtocolError("not_initialized", "Initialize first");
    switch (method) {
      case "properties.list":
        this.requireCapability("properties");
        return this.registry.listProperties() as unknown as Json;
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
        return this.registry.listBundles() as unknown as Json;
      case "commands.list":
        return this.registry.list() as unknown as Json;
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
          const topic = params.topic,
            added = !this.topics.has(topic);
          this.topics.add(topic);
          try {
            const retained = this.registry.readRetained(topic);
            const result: Json = retained
              ? { topic, subscribed: true, state: retained.value }
              : { topic, subscribed: true };
            if (!this.fits(id, result))
              throw new ProtocolError("message_too_large", "Retained state exceeds message limit");
            return result;
          } catch (error) {
            if (added) this.topics.delete(topic);
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
  close(options: { notify?: boolean } = {}): void {
    if (this.closed) return;
    if (options.notify !== false && this.initialized && this.authorized) {
      try {
        this.send("bye", {});
      } catch {
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
