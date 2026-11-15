export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export type Params = Record<string, Json>;
export declare const TOPIC_COMMANDS_CHANGED = "commands.changed";
export declare const TOPIC_PROPERTIES_CHANGED = "properties.changed";
export declare const TOPIC_PROPERTIES_LIST_CHANGED = "properties.listChanged";
export declare const TOPIC_BUNDLES_CHANGED = "bundles.changed";
export declare const TOPIC_TRANSPORT_CHANGED = "transport.changed";
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
export declare class ProtocolError extends Error {
    code: string;
    constructor(code: string, message: string);
}
export declare const EMPTY_SCHEMA: InputSchema;
export declare function assertJson(value: unknown, ancestors?: Set<unknown>): asserts value is Json;
export declare function object(value: unknown): value is Record<string, unknown>;
/** Validate remote metadata before a client builds controls from it. */
export declare function parseCommandDescriptors(value: unknown): CommandDescriptor[];
export declare function validate(schema: InputSchema, value: unknown): asserts value is Params;
export declare function parsePropertyDescriptors(value: unknown): PropertyDescriptor[];
export declare function parseBundles(value: unknown): CapabilityBundle[];
export declare class CommandRegistry {
    private commands;
    private properties;
    private bundles;
    private listeners;
    private retained;
    register(command: Command): () => void;
    list(): CommandDescriptor[];
    call(id: string, params?: unknown): Promise<Json>;
    registerProperty(property: Property): () => void;
    listProperties(): PropertyDescriptor[];
    private property;
    getProperty(id: string): Promise<Json>;
    setProperty(id: string, value: unknown): Promise<Json>;
    notifyProperty(id: string): Promise<Json>;
    registerBundle(bundle: CapabilityBundle): () => void;
    listBundles(): CapabilityBundle[];
    /**
     * Provide the current state of a topic to new subscribers. The reader must be synchronous so the
     * state is captured atomically with the subscription; later changes arrive as published events.
     */
    retain(topic: string, read: () => Json): () => void;
    readRetained(topic: string): {
        value: Json;
    } | undefined;
    publish(topic: string, data: Json): void;
    observe(listener: (topic: string, data: Json) => void): () => void;
}
