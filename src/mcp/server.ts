/**
 * A Model Context Protocol server over stdio: newline-delimited JSON-RPC 2.0, written by hand to keep the binary free
 * of dependencies. Only tools are offered. It speaks both eras of the protocol:
 *  - modern (2026-07-28): no handshake, every request names its version in `_meta`, results carry `resultType`, and
 *    `server/discover` tells a client what is supported.
 *  - legacy (2025-11-25 and earlier): an `initialize` handshake picks the version for the rest of the process.
 * Nothing but protocol messages may reach stdout: the caller sends logs to stderr.
 */

/** Newest first. The first one is what a legacy client gets when it asks for a version we don't know. */
export const MODERN_VERSIONS = ["2026-07-28"] as const;
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META = {
  version: "io.modelcontextprotocol/protocolVersion",
  capabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

export const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedVersion: -32022,
} as const;

/** A JSON Schema subset: what the tools' input schemas use, and what `validate` checks. */
export interface Schema {
  type?: "object" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  /** Returns the result as JSON. A thrown ToolError becomes a result with `isError`, so the agent can correct itself. */
  run(args: Record<string, unknown>): unknown;
}

/** A failure the agent can act on: bad arguments, no database, an unknown session. */
export class ToolError extends Error {}

export interface ServerInfo {
  name: string;
  title?: string;
  version: string;
}

type Id = string | number;
type Json = Record<string, unknown>;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Checks arguments against a tool's schema. Returns the first problem, in words an agent can act on. */
export function validate(value: unknown, schema: Schema, path = "arguments"): string | null {
  switch (schema.type) {
    case "object": {
      if (!isObject(value)) return `${path} must be an object`;
      for (const key of schema.required ?? []) if (value[key] === undefined) return `${path}.${key} is required`;
      for (const [key, v] of Object.entries(value)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) return `${path}.${key} is not a known argument`;
          continue;
        }
        if (v === undefined || v === null) continue;
        const problem = validate(v, sub, `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(", ")}`;
      if (schema.maxLength != null && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters`;
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return `${path} must be ${schema.type === "integer" ? "an integer" : "a number"}`;
      if (schema.minimum != null && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum != null && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    default:
      return null;
  }
}

/** Orders dates as strings: protocol versions are ISO dates. */
const atLeast = (version: string, min: string) => version >= min;

export class McpServer {
  /** The version an `initialize` agreed on, for legacy requests that follow it. */
  private legacyVersion: string | null = null;
  private byName: Map<string, Tool>;

  constructor(
    private tools: Tool[],
    private info: ServerInfo,
    private instructions?: string,
  ) {
    this.byName = new Map(tools.map((t) => [t.name, t]));
  }

  /** Answers one parsed message: a response, or null for a notification (and for a response sent to us). */
  handle(msg: unknown): Json | null {
    if (!isObject(msg) || msg.jsonrpc !== "2.0") return errorResponse(isObject(msg) ? idOf(msg.id) : null, ERR.invalidRequest, "Invalid request: not a JSON-RPC 2.0 message");
    const hasId = msg.id !== undefined;
    if (typeof msg.method !== "string") {
      // A client's answer to a request: we never send any, so there is nothing to match it with.
      if (hasId && ("result" in msg || "error" in msg)) return null;
      return errorResponse(idOf(msg.id), ERR.invalidRequest, "Invalid request: method is missing");
    }
    // Notifications (initialized, cancelled, roots changed, …) need no answer, known or not.
    if (!hasId) return null;
    const id = idOf(msg.id);
    if (id === null) return errorResponse(null, ERR.invalidRequest, "Invalid request: id must be a string or a number");
    try {
      if (msg.params !== undefined && !isObject(msg.params)) throw new RpcError(ERR.invalidParams, "params must be an object");
      return { jsonrpc: "2.0", id, result: this.dispatch(msg.method, (msg.params ?? {}) as Json) };
    } catch (e) {
      if (e instanceof RpcError) return errorResponse(id, e.code, e.message, e.data);
      return errorResponse(id, ERR.internal, `Internal error: ${(e as Error).message}`);
    }
  }

  /** Parses and answers one line from the transport. Null when nothing goes back. */
  handleLine(line: string): string | null {
    if (!line.trim()) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify(errorResponse(null, ERR.parse, "Parse error: not valid JSON"));
    }
    // Batches came with 2025-03-26 and went with 2025-06-18: still answered, one response per request.
    if (Array.isArray(msg)) {
      if (!msg.length) return JSON.stringify(errorResponse(null, ERR.invalidRequest, "Invalid request: empty batch"));
      const out = msg.map((m) => this.handle(m)).filter((r) => r !== null);
      return out.length ? JSON.stringify(out) : null;
    }
    const out = this.handle(msg);
    return out ? JSON.stringify(out) : null;
  }

  private dispatch(method: string, params: Json): Json {
    const meta = isObject(params._meta) ? params._meta : {};
    const requested = meta[META.version];
    // `initialize` is the legacy handshake whatever else it carries.
    if (requested !== undefined && method !== "initialize") return this.modern(method, params, requested, meta);
    return this.legacy(method, params);
  }

  /** A request that names its version: answered on its own, with no state from earlier requests. */
  private modern(method: string, params: Json, requested: unknown, meta: Json): Json {
    if (typeof requested !== "string" || !(MODERN_VERSIONS as readonly string[]).includes(requested)) {
      throw new RpcError(ERR.unsupportedVersion, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });
    }
    if (!isObject(meta[META.capabilities])) throw new RpcError(ERR.invalidParams, `_meta["${META.capabilities}"] is required`);
    const done = (result: Json): Json => ({ resultType: "complete", ...result, _meta: { [META.serverInfo]: this.serverInfo(requested) } });
    switch (method) {
      case "server/discover":
        return done({ supportedVersions: [...MODERN_VERSIONS], capabilities: { tools: {} }, ...(this.instructions ? { instructions: this.instructions } : {}) });
      case "ping":
        return done({});
      case "tools/list":
        return done({ tools: this.listTools(requested) });
      case "tools/call":
        return done(this.call(params, requested));
      default:
        throw new RpcError(ERR.methodNotFound, `Method not found: ${method}`);
    }
  }

  /** The handshake era: `initialize` settles the version, and requests after it carry none. */
  private legacy(method: string, params: Json): Json {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        if (typeof asked !== "string") throw new RpcError(ERR.invalidParams, "params.protocolVersion is required");
        // The version asked for when we speak it, else our newest: the client then decides whether to go on.
        const version = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0];
        this.legacyVersion = version;
        return {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: this.serverInfo(version),
          ...(this.instructions ? { instructions: this.instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.listTools(this.version()) };
      case "tools/call":
        return this.call(params, this.version());
      default:
        throw new RpcError(ERR.methodNotFound, `Method not found: ${method}`);
    }
  }

  /** A client that skipped `initialize` is served as the oldest version: plain text results, which every client reads. */
  private version(): string {
    return this.legacyVersion ?? LEGACY_VERSIONS[LEGACY_VERSIONS.length - 1]!;
  }

  private serverInfo(version: string): Json {
    return atLeast(version, "2025-06-18") && this.info.title ? { ...this.info } : { name: this.info.name, version: this.info.version };
  }

  private listTools(version: string): Json[] {
    return this.tools.map((t) => ({
      name: t.name,
      // Titles came with 2025-06-18, behavior hints with 2025-03-26.
      ...(atLeast(version, "2025-06-18") ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
      ...(atLeast(version, "2025-03-26") ? { annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } } : {}),
    }));
  }

  private call(params: Json, version: string): Json {
    const name = params.name;
    if (typeof name !== "string") throw new RpcError(ERR.invalidParams, "params.name is required");
    const tool = this.byName.get(name);
    if (!tool) throw new RpcError(ERR.invalidParams, `Unknown tool: ${name}`);
    const args = params.arguments ?? {};
    if (!isObject(args)) throw new RpcError(ERR.invalidParams, "params.arguments must be an object");
    // Bad arguments are the tool's error, not the protocol's: the agent sees the message and can try again.
    const problem = validate(args, tool.inputSchema);
    if (problem) return toolError(problem);
    let value: unknown;
    try {
      value = tool.run(args);
    } catch (e) {
      if (e instanceof ToolError) return toolError(e.message);
      return toolError(`${name} failed: ${(e as Error).message}`);
    }
    const text = JSON.stringify(value);
    // Structured results came with 2025-06-18. The same JSON stays in the text for clients that only read that.
    return { content: [{ type: "text", text }], ...(atLeast(version, "2025-06-18") && isObject(value) ? { structuredContent: value } : {}), isError: false };
  }
}

function toolError(message: string): Json {
  return { content: [{ type: "text", text: message }], isError: true };
}

function idOf(v: unknown): Id | null {
  return typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? v : null;
}

function errorResponse(id: Id | null, code: number, message: string, data?: unknown): Json {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Reads messages line by line until the input ends, and writes each answer as one line. Requests are answered in
 * order: the queries are synchronous, so there is nothing to run side by side.
 */
export async function serveStream(server: McpServer, input: ReadableStream<Uint8Array>, write: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    const out = server.handleLine(line.replace(/\r$/, ""));
    if (out !== null) write(out + "\n");
  };
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      flush(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer);
}
