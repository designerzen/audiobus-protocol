export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Params = Record<string, Json>;
export const TOPIC_COMMANDS_CHANGED = "commands.changed";
export const TOPIC_PROPERTIES_CHANGED = "properties.changed";
export const TOPIC_PROPERTIES_LIST_CHANGED = "properties.listChanged";
export const TOPIC_BUNDLES_CHANGED = "bundles.changed";
export const TOPIC_TRANSPORT_CHANGED = "transport.changed";
export interface Parameter {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
}
/** Deliberately bounded JSON Schema subset; unknown arguments are rejected. */
export interface InputSchema {
  type: "object";
  properties: Record<string, Parameter>;
  required?: string[];
  additionalProperties: false;
}
export interface CommandDescriptor {
  id: string;
  title: string;
  description: string;
  inputSchema: InputSchema;
  available: boolean;
}
export interface Command extends Omit<CommandDescriptor, "available"> {
  available?: () => boolean;
  execute: (params: Params) => Json | Promise<Json>;
}
export interface PropertyDescriptor {
  id: string;
  title: string;
  description: string;
  schema: Parameter;
  unit?: string;
  readOnly: boolean;
  available: boolean;
}
export interface Property extends Omit<PropertyDescriptor, "available" | "readOnly"> {
  get: () => Json | Promise<Json>;
  set?: (value: Json) => void | Promise<void>;
  writable?: () => boolean;
  available?: () => boolean;
}
/** Application-defined contracts, not MIDI-CI Profiles. */
export interface CapabilityBundle {
  id: string;
  version: number;
  commands: string[];
  properties: string[];
}
export class ProtocolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}
export const EMPTY_SCHEMA: InputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export function assertJson(value: unknown, ancestors = new Set<unknown>()): asserts value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value))
    throw new ProtocolError("invalid_result", "Expected finite, acyclic JSON data");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new ProtocolError("invalid_result", "Expected plain JSON data");
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value))
    assertJson(item, ancestors);
  ancestors.delete(value);
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate remote metadata before a client builds controls from it. */
export function parseCommandDescriptors(value: unknown): CommandDescriptor[] {
  const invalid = () => {
    throw new ProtocolError("invalid_result", "Invalid command descriptors");
  };
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  for (const command of value) {
    if (
      !object(command) ||
      typeof command.id !== "string" ||
      !command.id ||
      ids.has(command.id) ||
      typeof command.title !== "string" ||
      typeof command.description !== "string" ||
      typeof command.available !== "boolean"
    )
      return invalid();
    ids.add(command.id);
    const schema = command.inputSchema;
    if (
      !object(schema) ||
      schema.type !== "object" ||
      schema.additionalProperties !== false ||
      !object(schema.properties)
    )
      return invalid();
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (key) => typeof key !== "string" || !Object.hasOwn(schema.properties as object, key),
        ))
    )
      return invalid();
    for (const field of Object.values(schema.properties)) {
      if (
        !object(field) ||
        !["string", "number", "integer", "boolean"].includes(field.type as string)
      )
        return invalid();
      if (field.description !== undefined && typeof field.description !== "string")
        return invalid();
      for (const bound of [field.minimum, field.maximum]) {
        if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound)))
          return invalid();
      }
      if (
        typeof field.minimum === "number" &&
        typeof field.maximum === "number" &&
        field.minimum > field.maximum
      )
        return invalid();
      if (
        field.enum !== undefined &&
        (!Array.isArray(field.enum) ||
          !field.enum.length ||
          field.enum.some(
            (item) =>
              typeof item !== (field.type === "integer" ? "number" : field.type) ||
              (typeof item === "number" &&
                (!Number.isFinite(item) || (field.type === "integer" && !Number.isInteger(item)))),
          ))
      )
        return invalid();
    }
  }
  return value as CommandDescriptor[];
}
export function validate(schema: InputSchema, value: unknown): asserts value is Params {
  if (!object(value)) throw new ProtocolError("invalid_params", "Arguments must be an object");
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key))
      throw new ProtocolError("invalid_params", `Missing argument: ${key}`);
  }
  for (const [key, item] of Object.entries(value)) {
    const field = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!field) throw new ProtocolError("invalid_params", `Unknown argument: ${key}`);
    const numeric = field.type === "number" || field.type === "integer";
    if (
      typeof item !== (numeric ? "number" : field.type) ||
      (numeric &&
        (!Number.isFinite(item) || (field.type === "integer" && !Number.isInteger(item)))) ||
      (field.enum && !field.enum.includes(item as string | number | boolean)) ||
      (typeof item === "number" &&
        ((field.minimum !== undefined && item < field.minimum) ||
          (field.maximum !== undefined && item > field.maximum)))
    ) {
      throw new ProtocolError("invalid_params", `Invalid argument: ${key}`);
    }
  }
}
export function parsePropertyDescriptors(value: unknown): PropertyDescriptor[] {
  if (!Array.isArray(value))
    throw new ProtocolError("invalid_result", "Invalid property descriptors");
  parseCommandDescriptors(
    value.map((item) => {
      if (
        !object(item) ||
        typeof item.readOnly !== "boolean" ||
        (item.unit !== undefined && typeof item.unit !== "string")
      )
        throw new ProtocolError("invalid_result", "Invalid property metadata");
      return {
        ...item,
        inputSchema: {
          type: "object",
          properties: { value: item.schema },
          additionalProperties: false,
        },
      };
    }),
  );
  return value as PropertyDescriptor[];
}
export function parseBundles(value: unknown): CapabilityBundle[] {
  if (!Array.isArray(value))
    throw new ProtocolError("invalid_result", "Invalid capability bundles");
  const ids = new Set<string>();
  for (const item of value) {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(item.id) ||
      ids.has(item.id) ||
      !Number.isInteger(item.version) ||
      (item.version as number) < 1 ||
      !Array.isArray(item.commands) ||
      !Array.isArray(item.properties) ||
      [...item.commands, ...item.properties].some((id) => typeof id !== "string" || !id)
    ) {
      throw new ProtocolError("invalid_result", "Invalid capability bundle");
    }
    ids.add(item.id);
  }
  return value as CapabilityBundle[];
}
export class CommandRegistry {
  private commands = new Map<string, Command>();
  private properties = new Map<string, Property>();
  private bundles = new Map<string, CapabilityBundle>();
  private listeners = new Set<(topic: string, data: Json) => void>();
  register(command: Command): () => void {
    if (!command.id || this.commands.has(command.id))
      throw new Error(`Duplicate or empty command: ${command.id}`);
    this.commands.set(command.id, command);
    this.publish(TOPIC_COMMANDS_CHANGED, null);
    if (this.bundles.size) this.publish(TOPIC_BUNDLES_CHANGED, null);
    return () => {
      if (this.commands.get(command.id) !== command) return;
      this.commands.delete(command.id);
      this.publish(TOPIC_COMMANDS_CHANGED, null);
      if (this.bundles.size) this.publish(TOPIC_BUNDLES_CHANGED, null);
    };
  }
  list(): CommandDescriptor[] {
    return [...this.commands.values()].map(({ execute: _, available, ...descriptor }) => ({
      ...descriptor,
      available: available?.() ?? true,
    }));
  }
  async call(id: string, params: unknown = {}): Promise<Json> {
    const command = this.commands.get(id);
    if (!command) throw new ProtocolError("unknown_command", `Unknown command: ${id}`);
    if (!(command.available?.() ?? true))
      throw new ProtocolError("unavailable", `Unavailable command: ${id}`);
    validate(command.inputSchema, params);
    const result = await command.execute(params);
    assertJson(result);
    return result;
  }
  registerProperty(property: Property): () => void {
    if (!property.id || this.properties.has(property.id))
      throw new Error(`Duplicate or empty property: ${property.id}`);
    parsePropertyDescriptors([
      {
        id: property.id,
        title: property.title,
        description: property.description,
        schema: property.schema,
        ...(property.unit === undefined ? {} : { unit: property.unit }),
        available: true,
        readOnly: !property.set,
      },
    ]);
    this.properties.set(property.id, property);
    this.publish(TOPIC_PROPERTIES_LIST_CHANGED, null);
    if (this.bundles.size) this.publish(TOPIC_BUNDLES_CHANGED, null);
    return () => {
      if (this.properties.get(property.id) !== property) return;
      this.properties.delete(property.id);
      this.publish(TOPIC_PROPERTIES_LIST_CHANGED, null);
      if (this.bundles.size) this.publish(TOPIC_BUNDLES_CHANGED, null);
    };
  }
  listProperties(): PropertyDescriptor[] {
    return [...this.properties.values()].map(
      ({ get: _, set, writable, available, ...descriptor }) => ({
        ...descriptor,
        available: available?.() ?? true,
        readOnly: !set || !(writable?.() ?? true),
      }),
    );
  }
  private property(id: string): Property {
    const property = this.properties.get(id);
    if (!property) throw new ProtocolError("unknown_property", `Unknown property: ${id}`);
    if (!(property.available?.() ?? true))
      throw new ProtocolError("unavailable", `Unavailable property: ${id}`);
    return property;
  }
  async getProperty(id: string): Promise<Json> {
    const property = this.property(id),
      value = await property.get();
    try {
      validate(
        {
          type: "object",
          properties: { value: property.schema },
          required: ["value"],
          additionalProperties: false,
        },
        { value },
      );
    } catch {
      throw new ProtocolError("invalid_result", `Invalid value returned by property: ${id}`);
    }
    return value;
  }
  async setProperty(id: string, value: unknown): Promise<Json> {
    const property = this.property(id);
    if (!property.set || !(property.writable?.() ?? true))
      throw new ProtocolError("read_only", `Read-only property: ${id}`);
    const args = { value };
    validate(
      {
        type: "object",
        properties: { value: property.schema },
        required: ["value"],
        additionalProperties: false,
      },
      args,
    );
    await property.set(args.value as Json);
    return this.notifyProperty(id);
  }
  async notifyProperty(id: string): Promise<Json> {
    const value = await this.getProperty(id);
    this.publish(TOPIC_PROPERTIES_CHANGED, { id, value });
    return value;
  }
  registerBundle(bundle: CapabilityBundle): () => void {
    parseBundles([bundle]);
    if (this.bundles.has(bundle.id)) throw new Error(`Duplicate bundle: ${bundle.id}`);
    if (
      bundle.commands.some((id) => !this.commands.has(id)) ||
      bundle.properties.some((id) => !this.properties.has(id))
    ) {
      throw new Error("Register a bundle's commands and properties first");
    }
    const snapshot = structuredClone(bundle);
    this.bundles.set(bundle.id, snapshot);
    this.publish(TOPIC_BUNDLES_CHANGED, null);
    return () => {
      if (this.bundles.get(bundle.id) === snapshot) {
        this.bundles.delete(bundle.id);
        this.publish(TOPIC_BUNDLES_CHANGED, null);
      }
    };
  }
  listBundles(): CapabilityBundle[] {
    return [...this.bundles.values()]
      .filter(
        (bundle) =>
          bundle.commands.every((id) => this.commands.has(id)) &&
          bundle.properties.every((id) => this.properties.has(id)),
      )
      .map((bundle) => structuredClone(bundle));
  }
  publish(topic: string, data: Json): void {
    assertJson(data);
    for (const listener of this.listeners) listener(topic, data);
  }
  observe(listener: (topic: string, data: Json) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
