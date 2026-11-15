import {
  CommandRegistry,
  ProtocolError,
  object,
  assertJson,
  parseCommandDescriptors,
  type CommandDescriptor,
  type Json,
  type Params,
} from "./registry.js";
import type { Transport } from "./transport.js";
export * from "./registry.js";
export * from "./transport.js";

export const PROTOCOL_VERSION = 1;
export const CONTROL_PREFIX = "control,";
export const MAX_MESSAGE_LENGTH = 262144;
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
  private closed = false;
  private unlisten: () => void;
  private unobserve: () => void;
  constructor(
    private transport: Transport,
    private options: PeerOptions,
  ) {
    this.registry = options.registry ?? new CommandRegistry();
    this.unlisten = transport.listen((message) => {
      void this.receive(message);
    });
    this.unobserve = this.registry.observe((topic, data) => {
      if (this.initialized && this.topics.has(topic)) this.send("event", { topic, data });
    });
  }
  private send(kind: string, body: Record<string, unknown>): void {
    if (this.closed) throw new ProtocolError("closed", "Peer is closed");
    assertJson(body);
    const message = `${CONTROL_PREFIX}${kind},${encodeURIComponent(JSON.stringify(body))}`;
    if (message.length > MAX_MESSAGE_LENGTH)
      throw new ProtocolError("message_too_large", "Message exceeds limit");
    this.transport.send(message);
  }
  async connect(): Promise<Json> {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      ...this.options.identity,
    });
    if (!object(result) || result.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolError("unsupported_version", "Peer did not negotiate protocol version 1");
    }
    this.initialized = true;
    return result;
  }
  request(method: string, params: Params = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new ProtocolError("closed", "Peer is closed"));
    if (!this.initialized && method !== "initialize")
      return Promise.reject(new ProtocolError("not_initialized", "Connect first"));
    const id = String(++this.sequence);
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
    try {
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
      if (!message.startsWith(CONTROL_PREFIX)) return;
      const separator = message.indexOf(",", CONTROL_PREFIX.length);
      if (separator < 0) return;
      const kind = message.slice(CONTROL_PREFIX.length, separator);
      const body: unknown = JSON.parse(decodeURIComponent(message.slice(separator + 1)));
      if (!object(body)) return;
      if (kind === "response" && typeof body.id === "string") {
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
        typeof body.topic === "string" &&
        Object.hasOwn(body, "data")
      ) {
        this.options.onEvent?.(body.topic, body.data as Json);
      } else if (
        kind === "request" &&
        typeof body.id === "string" &&
        typeof body.method === "string"
      ) {
        try {
          const result = await this.handle(body.method, body.params);
          if (!this.closed) this.send("response", { id: body.id, result });
        } catch (error) {
          if (!this.closed)
            this.send("response", {
              id: body.id,
              error: {
                code: error instanceof ProtocolError ? error.code : "internal_error",
                message: error instanceof ProtocolError ? error.message : "Command failed",
              },
            });
        }
      }
    } catch {
      /* Ignore malformed envelopes and isolate transport/application callbacks. */
    }
  }
  private async handle(method: string, params: unknown): Promise<Json> {
    if (!object(params)) throw new ProtocolError("invalid_params", "Expected an argument object");
    if (method === "initialize") {
      if (params.protocolVersion !== PROTOCOL_VERSION)
        throw new ProtocolError("unsupported_version", "Expected protocol version 1");
      if (typeof params.name !== "string" || typeof params.version !== "string")
        throw new ProtocolError("invalid_params", "Expected peer identity");
      this.initialized = true;
      return {
        ...this.options.identity,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ["commands", "events", "webmidilink"],
        maxMessageLength: MAX_MESSAGE_LENGTH,
      };
    }
    if (!this.initialized) throw new ProtocolError("not_initialized", "Initialize first");
    switch (method) {
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
        if (method === "events.subscribe") {
          if (this.topics.size >= 128 && !this.topics.has(params.topic))
            throw new ProtocolError("limit_exceeded", "Too many subscriptions");
          this.topics.add(params.topic);
        } else this.topics.delete(params.topic);
        return { topic: params.topic, subscribed: method === "events.subscribe" };
      default:
        throw new ProtocolError("unknown_method", `Unknown method: ${method}`);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
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
