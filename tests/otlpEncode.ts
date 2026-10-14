/**
 * Test-only OTLP encoder: builds ExportTraceServiceRequest / ExportLogsServiceRequest bodies, as protobuf or OTLP/JSON,
 * from plain fixtures, plus realistic Hermes (hermes-otel) and Claude Code exports.
 *
 *   bun tests/otlpEncode.ts hermes        a Hermes ExportTraceServiceRequest (protobuf) on stdout
 *   bun tests/otlpEncode.ts claude-json   a Claude Code logs export (OTLP/JSON) on stdout
 */

/** An attribute value: integers become intValue, other numbers doubleValue (or wrap one with dbl), objects kvlists. */
export type AttrIn = string | number | boolean | Uint8Array | Dbl | AttrIn[] | { [key: string]: AttrIn };
export type AttrsIn = Record<string, AttrIn>;

export class Dbl {
  constructor(readonly value: number) {}
}
export const dbl = (n: number) => new Dbl(n);

export interface SpanIn {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startMs: number;
  endMs: number;
  attrs?: AttrsIn;
  status?: { code: number; message?: string };
}

export interface LogIn {
  timeMs?: number;
  observedMs?: number;
  severityNumber?: number;
  severityText?: string;
  body?: AttrIn;
  attrs?: AttrsIn;
  traceId?: string;
  spanId?: string;
  eventName?: string;
}

export interface ResourceIn<R> {
  resource: AttrsIn;
  scope?: { name: string; version?: string };
  records: R[];
}

// ---- Protobuf ----------------------------------------------------------------------------------------------------

/** A protobuf message being written: fields appended in order. */
export class Pb {
  private parts: number[] = [];

  /** A raw varint (also a tag: field << 3 | wire type). */
  varint(v: number | bigint): this {
    let n = BigInt.asUintN(64, BigInt(v));
    while (n >= 0x80n) {
      this.parts.push(Number(n & 0x7fn) | 0x80);
      n >>= 7n;
    }
    this.parts.push(Number(n));
    return this;
  }

  tag(field: number, wire: number): this {
    return this.varint(field * 8 + wire);
  }

  raw(bytes: Uint8Array | number[]): this {
    for (const b of bytes) this.parts.push(b);
    return this;
  }

  int(field: number, v: number | bigint): this {
    return this.tag(field, 0).varint(v);
  }

  fixed64(field: number, v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return this.tag(field, 1).raw(b);
  }

  double(field: number, v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.tag(field, 1).raw(b);
  }

  bytes(field: number, v: Uint8Array): this {
    return this.tag(field, 2).varint(v.length).raw(v);
  }

  string(field: number, v: string): this {
    return this.bytes(field, new TextEncoder().encode(v));
  }

  message(field: number, m: Pb): this {
    return this.bytes(field, m.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

const nanos = (ms: number) => BigInt(ms) * 1_000_000n;
const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

export function anyValuePb(v: AttrIn): Pb {
  const m = new Pb();
  if (typeof v === "string") return m.string(1, v);
  if (typeof v === "boolean") return m.int(2, v ? 1 : 0);
  if (v instanceof Dbl) return m.double(4, v.value);
  if (typeof v === "number") return Number.isInteger(v) ? m.int(3, v) : m.double(4, v);
  if (v instanceof Uint8Array) return m.bytes(7, v);
  if (Array.isArray(v)) {
    const arr = new Pb();
    for (const x of v) arr.message(1, anyValuePb(x));
    return m.message(5, arr);
  }
  const kv = new Pb();
  for (const [k, x] of Object.entries(v)) kv.message(1, keyValuePb(k, x));
  return m.message(6, kv);
}

const keyValuePb = (key: string, v: AttrIn) => new Pb().string(1, key).message(2, anyValuePb(v));

function attrsPb(m: Pb, field: number, attrs: AttrsIn = {}): Pb {
  for (const [k, v] of Object.entries(attrs)) m.message(field, keyValuePb(k, v));
  return m;
}

function scopePb(scope: { name: string; version?: string }): Pb {
  const m = new Pb().string(1, scope.name);
  return scope.version ? m.string(2, scope.version) : m;
}

function spanPb(s: SpanIn): Pb {
  const m = new Pb().bytes(1, hexBytes(s.traceId)).bytes(2, hexBytes(s.spanId));
  if (s.parentSpanId) m.bytes(4, hexBytes(s.parentSpanId));
  m.string(5, s.name).int(6, s.kind ?? 1).fixed64(7, nanos(s.startMs)).fixed64(8, nanos(s.endMs));
  attrsPb(m, 9, s.attrs);
  if (s.status) {
    const st = new Pb();
    if (s.status.message) st.string(2, s.status.message);
    m.message(15, st.int(3, s.status.code));
  }
  return m;
}

function logPb(l: LogIn): Pb {
  const m = new Pb();
  if (l.timeMs != null) m.fixed64(1, nanos(l.timeMs));
  if (l.severityNumber != null) m.int(2, l.severityNumber);
  if (l.severityText) m.string(3, l.severityText);
  if (l.body != null) m.message(5, anyValuePb(l.body));
  attrsPb(m, 6, l.attrs);
  if (l.traceId) m.bytes(9, hexBytes(l.traceId));
  if (l.spanId) m.bytes(10, hexBytes(l.spanId));
  if (l.observedMs != null) m.fixed64(11, nanos(l.observedMs));
  if (l.eventName) m.string(12, l.eventName);
  return m;
}

function exportPb<R>(resources: ResourceIn<R>[], record: (r: R) => Pb): Uint8Array {
  const req = new Pb();
  for (const r of resources) {
    const scoped = new Pb();
    if (r.scope) scoped.message(1, scopePb(r.scope));
    for (const rec of r.records) scoped.message(2, record(rec));
    req.message(1, new Pb().message(1, attrsPb(new Pb(), 1, r.resource)).message(2, scoped));
  }
  return req.finish();
}

export const encodeTraces = (resources: ResourceIn<SpanIn>[]) => exportPb(resources, spanPb);
export const encodeLogs = (resources: ResourceIn<LogIn>[]) => exportPb(resources, logPb);

// ---- OTLP/JSON ---------------------------------------------------------------------------------------------------

export function anyValueJson(v: AttrIn): unknown {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (v instanceof Dbl) return { doubleValue: v.value };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (v instanceof Uint8Array) return { bytesValue: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValueJson) } };
  return { kvlistValue: { values: attrsJson(v) } };
}

const attrsJson = (attrs: AttrsIn = {}) => Object.entries(attrs).map(([key, v]) => ({ key, value: anyValueJson(v) }));

function exportJson<R>(resources: ResourceIn<R>[], keys: [string, string, string], record: (r: R) => unknown): Uint8Array {
  const [resourceKey, scopeKey, recordKey] = keys;
  const body = {
    [resourceKey]: resources.map((r) => ({
      resource: { attributes: attrsJson(r.resource) },
      [scopeKey]: [{ ...(r.scope ? { scope: r.scope } : {}), [recordKey]: r.records.map(record) }],
    })),
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

export const tracesJson = (resources: ResourceIn<SpanIn>[]) =>
  exportJson(resources, ["resourceSpans", "scopeSpans", "spans"], (s) => ({
    traceId: s.traceId,
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    kind: s.kind ?? 1,
    startTimeUnixNano: String(nanos(s.startMs)),
    endTimeUnixNano: String(nanos(s.endMs)),
    attributes: attrsJson(s.attrs),
    ...(s.status ? { status: s.status } : {}),
  }));

export const logsJson = (resources: ResourceIn<LogIn>[]) =>
  exportJson(resources, ["resourceLogs", "scopeLogs", "logRecords"], (l) => ({
    ...(l.timeMs != null ? { timeUnixNano: String(nanos(l.timeMs)) } : {}),
    ...(l.observedMs != null ? { observedTimeUnixNano: String(nanos(l.observedMs)) } : {}),
    ...(l.severityNumber != null ? { severityNumber: l.severityNumber } : {}),
    ...(l.severityText ? { severityText: l.severityText } : {}),
    ...(l.body != null ? { body: anyValueJson(l.body) } : {}),
    attributes: attrsJson(l.attrs),
    ...(l.traceId ? { traceId: l.traceId } : {}),
    ...(l.spanId ? { spanId: l.spanId } : {}),
    ...(l.eventName ? { eventName: l.eventName } : {}),
  }));

// ---- Fixtures ----------------------------------------------------------------------------------------------------

export const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);
export const HERMES_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
export const HERMES_SESSION = "20261010_090000_ab12cd";
export const HERMES_CHILD = "20261010_090130_ef34gh";

const hermesResource = (host?: string): AttrsIn => ({
  "service.name": "hermes-agent",
  "service.instance.id": "0b6f2c1e-6c5e-4f3a-9a51-3d2f6e1c9b70",
  "service.version": "0.9.2",
  "process.pid": 41237,
  "hermes.profile": "default",
  ...(host ? { "host.name": host } : {}),
});

const hermesSession = (session: string) => ({ "session.id": session, session_id: session });

/**
 * One Hermes turn as hermes-otel exports it: the session root, the turn's llm.* span (totals again), two api.* model
 * calls (input counting its cache reads and writes), a tool call under the first, and a delegated subagent.
 */
export function hermesSpans(opts: { host?: string; previews?: boolean } = {}): ResourceIn<SpanIn>[] {
  const t = HERMES_TRACE;
  const previews = opts.previews ?? true;
  const spans: SpanIn[] = [
    {
      traceId: t, spanId: "1000000000000001", name: "agent", startMs: T0, endMs: T0 + 120_000,
      attrs: { "hermes.session.kind": "session", ...hermesSession(HERMES_SESSION), "hermes.session_id": HERMES_SESSION, "gen_ai.operation.name": "invoke_agent", "gen_ai.conversation.id": HERMES_SESSION },
    },
    {
      traceId: t, spanId: "1000000000000002", parentSpanId: "1000000000000001", name: "llm.anthropic/claude-sonnet-4.5", startMs: T0 + 1_000, endMs: T0 + 90_000,
      attrs: {
        ...hermesSession(HERMES_SESSION), "llm.model_name": "anthropic/claude-sonnet-4.5", "gen_ai.operation.name": "chat", "gen_ai.conversation.id": HERMES_SESSION,
        "llm.token_count.prompt": 24_000, "llm.token_count.completion": 900, "gen_ai.usage.input_tokens": 24_000, "gen_ai.usage.output_tokens": 900,
        ...(previews ? { "input.value": "refactor the parser", "gen_ai.input.messages": '[{"role":"user","content":"refactor the parser"}]', "output.value": "Done." } : {}),
      },
    },
    {
      traceId: t, spanId: "1000000000000003", parentSpanId: "1000000000000002", name: "api.anthropic/claude-sonnet-4.5", startMs: T0 + 1_000, endMs: T0 + 6_000,
      attrs: {
        "llm.api_mode": "chat_completions", ...hermesSession(HERMES_SESSION), "llm.model_name": "anthropic/claude-sonnet-4.5", "gen_ai.request.model": "anthropic/claude-sonnet-4.5",
        "llm.provider": "openrouter", "gen_ai.provider.name": "openrouter", "gen_ai.operation.name": "chat", "gen_ai.conversation.id": HERMES_SESSION,
        "gen_ai.response.model": "anthropic/claude-sonnet-4.5",
        "llm.token_count.prompt": 12_000, "llm.token_count.completion": 400, "llm.token_count.total": 12_400,
        "gen_ai.usage.input_tokens": 12_000, "gen_ai.usage.output_tokens": 400, "gen_ai.usage.total_tokens": 12_400,
        "llm.token_count.prompt_details.cache_read": 9_000, "gen_ai.usage.cache_read.input_tokens": 9_000, "gen_ai.usage.cache_read_input_tokens": 9_000,
        "llm.token_count.prompt_details.cache_write": 2_000, "gen_ai.usage.cache_creation.input_tokens": 2_000, "gen_ai.usage.cache_creation_input_tokens": 2_000,
        "llm.token_count.completion_details.reasoning": 120, "gen_ai.usage.reasoning.output_tokens": 120,
        "hermes.cost.status": "estimated", "hermes.cost.source": "openrouter", "hermes.cost.usage": dbl(0.0123),
        "llm.response.duration_ms": dbl(5000), "llm.response.finish_reason": "tool_calls", "gen_ai.response.finish_reasons": ["tool_calls"],
        ...(previews ? { "gen_ai.system_instructions": "You are Hermes", "gen_ai.output.messages": '[{"role":"assistant"}]' } : {}),
      },
    },
    {
      traceId: t, spanId: "1000000000000004", parentSpanId: "1000000000000003", name: "tool.read_file", startMs: T0 + 6_100, endMs: T0 + 6_300,
      attrs: {
        "tool.name": "read_file", "gen_ai.tool.name": "read_file", "gen_ai.tool.call.id": "call_01", "hermes.tool.target": "/srv/app/parser.py",
        ...hermesSession(HERMES_SESSION), "gen_ai.operation.name": "execute_tool", "hermes.tool.outcome": "completed",
        ...(previews ? { "input.value": '{"path":"/srv/app/parser.py"}', "gen_ai.tool.call.arguments": '{"path":"/srv/app/parser.py"}', "gen_ai.tool.call.result": "def parse(): ..." } : {}),
      },
    },
    {
      traceId: t, spanId: "1000000000000005", parentSpanId: "1000000000000002", name: "api.anthropic/claude-sonnet-4.5", startMs: T0 + 7_000, endMs: T0 + 10_000,
      attrs: {
        ...hermesSession(HERMES_SESSION), "gen_ai.request.model": "anthropic/claude-sonnet-4.5", "gen_ai.operation.name": "chat",
        "gen_ai.usage.input_tokens": 12_000, "gen_ai.usage.output_tokens": 500, "gen_ai.usage.cache_read.input_tokens": 11_500,
      },
    },
    {
      traceId: t, spanId: "1000000000000006", parentSpanId: "1000000000000002", name: "subagent.researcher", startMs: T0 + 11_000, endMs: T0 + 80_000,
      attrs: {
        "gen_ai.operation.name": "invoke_agent", "hermes.subagent.child_session_id": HERMES_CHILD, "gen_ai.agent.name": "researcher", "hermes.subagent.role": "researcher",
        ...hermesSession(HERMES_SESSION), "hermes.subagent.parent_session_id": HERMES_SESSION,
        ...(previews ? { "hermes.subagent.goal": "find every caller of parse()", "input.value": "find every caller of parse()" } : {}),
      },
    },
  ];
  return [{ resource: hermesResource(opts.host), scope: { name: "hermes-otel-plugin" }, records: spans }];
}

/** The subagent's own model call, in its own trace (it may come in a later request than its subagent span). */
export function hermesChildSpans(opts: { host?: string } = {}): ResourceIn<SpanIn>[] {
  return [
    {
      resource: hermesResource(opts.host),
      scope: { name: "hermes-otel-plugin" },
      records: [
        {
          traceId: "5bf92f3577b34da6a3ce929d0e0e4737", spanId: "2000000000000001", name: "api.anthropic/claude-haiku-4.5", startMs: T0 + 20_000, endMs: T0 + 22_000,
          attrs: { ...hermesSession(HERMES_CHILD), "gen_ai.request.model": "anthropic/claude-haiku-4.5", "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 3_000, "gen_ai.usage.output_tokens": 200 },
        },
      ],
    },
  ];
}

export const CLAUDE_SESSION = "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5";
export const CLAUDE_PROMPT = "b2c3d4e5-6f70-4182-93a4-b5c6d7e8f901";

const claudeResource = (host?: string): AttrsIn => ({
  "service.name": "claude-code",
  "service.version": "2.1.40",
  "os.type": "linux",
  "host.arch": "amd64",
  ...(host ? { "host.name": host } : {}),
  "harness.project": "payments-api",
});

/** Standard attributes Claude Code puts on every event (counts and flags as strings, as it sends them). */
const claudeStd = (sequence: number) => ({
  "session.id": CLAUDE_SESSION,
  "user.id": "c0ffee",
  "organization.id": "org-1",
  "terminal.type": "vscode",
  "app.version": "2.1.40",
  "event.sequence": String(sequence),
  "prompt.id": CLAUDE_PROMPT,
});

/** One Claude Code prompt as its OTel logs exporter sends it: the prompt, a model call and a tool result. */
export function claudeLogs(opts: { host?: string; promptText?: boolean } = {}): ResourceIn<LogIn>[] {
  const logs: LogIn[] = [
    {
      timeMs: T0, observedMs: T0, body: "claude_code.user_prompt",
      attrs: { ...claudeStd(1), "event.name": "user_prompt", "event.timestamp": new Date(T0).toISOString(), prompt_length: "38", ...(opts.promptText !== false ? { prompt: "add retries to the stripe webhook handler" } : {}) },
    },
    {
      timeMs: T0 + 4_000, observedMs: T0 + 4_000, body: "claude_code.api_request", eventName: "claude_code.api_request",
      attrs: {
        ...claudeStd(2), "event.name": "api_request", model: "claude-opus-5-5", cost_usd: "9.99", duration_ms: "3200", input_tokens: "12", output_tokens: "450",
        cache_read_tokens: "30000", cache_creation_tokens: "1500", speed: "normal", request_id: "req_011CXabc",
      },
    },
    {
      timeMs: T0 + 5_000, observedMs: T0 + 5_000, body: "claude_code.tool_result",
      attrs: { ...claudeStd(3), "event.name": "tool_result", tool_name: "Edit", tool_use_id: "toolu_01ABC", success: "true", duration_ms: "40", tool_parameters: '{"file_path":"/home/dev/payments/webhook.ts"}' },
    },
    {
      timeMs: T0 + 6_000, observedMs: T0 + 6_000, body: "claude_code.tool_result",
      attrs: { ...claudeStd(4), "event.name": "tool_result", tool_name: "Bash", tool_use_id: "toolu_01DEF", success: "false", error: "exit 1", duration_ms: "900" },
    },
  ];
  return [{ resource: claudeResource(opts.host), scope: { name: "com.anthropic.claude_code.events", version: "2.1.40" }, records: logs }];
}

if (import.meta.main) {
  const which = process.argv[2];
  if (which === "hermes") process.stdout.write(encodeTraces(hermesSpans({ host: "build-box" })));
  else if (which === "claude-json") process.stdout.write(logsJson(claudeLogs({ host: "laptop-2" })));
  else {
    console.error("usage: bun tests/otlpEncode.ts hermes|claude-json");
    process.exit(2);
  }
}
