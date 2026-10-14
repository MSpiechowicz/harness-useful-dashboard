import {
  type AttrValue,
  type Attrs,
  emptyAttrs,
  MAX_DEPTH,
  nanosToMs,
  OtlpDecodeError,
  type OtlpBatch,
  type OtlpLog,
  type OtlpSpan,
  recordCounter,
  ValueBudget,
} from "./model.ts";

/**
 * OTLP/HTTP protobuf bodies (opentelemetry-proto v1): ExportTraceServiceRequest and ExportLogsServiceRequest, read by
 * hand so the server keeps no protobuf dependency. Only the fields the mapping reads are decoded; unknown fields are
 * skipped without being decoded. A body that runs past its end, uses group wire types or nests too deeply is rejected,
 * and one that carries more attribute values, resources and scopes than MAX_VALUES, or more fields than MAX_FIELDS, is
 * too large. A field sent more than once is decoded once, the last one.
 */

/**
 * One field's value as it is on the wire: where the bytes of its varint, fixed64, length-delimited or fixed32 value
 * are. A view of them is made only when they are read: most fields are skipped, or sent again and read once.
 */
class Value {
  constructor(
    readonly wire: 0 | 1 | 2 | 5,
    private buf: Uint8Array,
    private start: number,
    private end: number,
  ) {}

  get bytes(): Uint8Array {
    return this.buf.subarray(this.start, this.end);
  }
}

const utf8 = new TextDecoder();

class Reader {
  pos = 0;

  constructor(private buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  /** A tag or a length: a varint as a plain number. */
  uint(): number {
    let n = 0;
    for (let i = 0, mul = 1; i < 10; i++, mul *= 128) {
      if (this.done) throw new OtlpDecodeError("truncated varint");
      const b = this.buf[this.pos++]!;
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
    }
    throw new OtlpDecodeError("varint too long");
  }

  /** Goes past a varint value, up to its last byte, without decoding it: most are skipped, and decoding takes a BigInt. */
  skipVarint(): void {
    for (let i = 0; i < 10; i++) {
      if (this.done) throw new OtlpDecodeError("truncated varint");
      if (this.buf[this.pos++]! < 0x80) return;
    }
    throw new OtlpDecodeError("varint too long");
  }

  skip(n: number): void {
    if (n > this.buf.length - this.pos) throw new OtlpDecodeError("field runs past the end of the message");
    this.pos += n;
  }
}

/** Calls `on` with each field of a message, in wire order, each counted against the request's MAX_FIELDS. */
function each(buf: Uint8Array, budget: ValueBudget, on: (field: number, v: Value) => void): void {
  const r = new Reader(buf);
  while (!r.done) {
    budget.field();
    const tag = r.uint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 0) throw new OtlpDecodeError("field number 0");

    if (wire === 2) {
      const n = r.uint();
      const start = r.pos;
      r.skip(n);
      on(field, new Value(wire, buf, start, r.pos));
      continue;
    }

    const start = r.pos;
    if (wire === 0) r.skipVarint();
    else if (wire === 1) r.skip(8);
    else if (wire === 5) r.skip(4);
    else throw new OtlpDecodeError(`unsupported wire type ${wire}`);
    on(field, new Value(wire, buf, start, r.pos));
  }
}

function guard(depth: number): void {
  if (depth > MAX_DEPTH) throw new OtlpDecodeError("message nested too deeply");
}

/** A varint's bytes as its value, all 64 bits of it. */
function int(v: Value): bigint {
  const bytes = v.bytes;
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) n |= BigInt(bytes[i]! & 0x7f) << BigInt(7 * i);
  return BigInt.asUintN(64, n);
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const text = (v: Value | null) => (v?.wire === 2 ? utf8.decode(v.bytes) : null);
const fixed64 = (v: Value) => (v.wire === 1 ? view(v.bytes).getBigUint64(0, true) : 0n);
const hex = (v: Value | null) => (v?.wire === 2 ? Buffer.from(v.bytes).toString("hex") : "");
const small = (v: Value | null) => (v?.wire === 0 ? Number(BigInt.asIntN(32, int(v))) : 0);
const time = (v: Value | null) => (v ? nanosToMs(fixed64(v)) : null);

/** The wire type of each AnyValue field: string, bool, int, double, array, kvlist, bytes. */
const ANY_VALUE_WIRES = [-1, 2, 0, 0, 1, 2, 2, 2];

function anyValue(buf: Uint8Array, depth: number, budget: ValueBudget): AttrValue {
  guard(depth);
  let last = null as { field: number; v: Value } | null;
  each(buf, budget, (field, v) => {
    if (ANY_VALUE_WIRES[field] === v.wire) last = { field, v };
  });
  if (!last) return null;

  const { field, v } = last;
  if (v.wire === 0) return field === 2 ? int(v) !== 0n : Number(BigInt.asIntN(64, int(v)));
  if (v.wire === 1) return view(v.bytes).getFloat64(0, true);
  if (v.wire !== 2) return null;

  if (field === 1) return utf8.decode(v.bytes);
  if (field === 5) return arrayValue(v.bytes, depth + 1, budget);
  if (field === 6) return keyValues(v.bytes, depth + 1, budget);
  return v.bytes.slice();
}

function arrayValue(buf: Uint8Array, depth: number, budget: ValueBudget): AttrValue[] {
  guard(depth);
  const out: AttrValue[] = [];
  each(buf, budget, (field, v) => {
    if (field !== 1 || v.wire !== 2) return;

    budget.take();
    budget.list(out.length + 1);
    out.push(anyValue(v.bytes, depth + 1, budget));
  });
  return out;
}

/** A KeyValueList: its repeated KeyValue (field 1) as one object. */
function keyValues(buf: Uint8Array, depth: number, budget: ValueBudget): Attrs {
  guard(depth);
  const out = emptyAttrs();
  let n = 0;
  each(buf, budget, (field, v) => {
    if (field !== 1 || v.wire !== 2) return;

    budget.list(++n);
    keyValue(v.bytes, depth + 1, out, budget);
  });
  return out;
}

/** One attribute: counted against the budget, its value decoded once, the last one sent. */
function keyValue(buf: Uint8Array, depth: number, into: Attrs, budget: ValueBudget): void {
  guard(depth);
  budget.take();
  let key = null as Value | null;
  let value = null as Uint8Array | null;
  each(buf, budget, (field, v) => {
    if (field === 1) key = v;
    else if (field === 2 && v.wire === 2) value = v.bytes;
  });

  const name = key ? text(key) : null;
  if (name) into[name] = value ? anyValue(value, depth + 1, budget) : null;
}

/** A Resource's attributes (field 1). */
function resourceAttrs(buf: Uint8Array, depth: number, budget: ValueBudget): Attrs {
  guard(depth);
  const out = emptyAttrs();
  each(buf, budget, (field, v) => {
    if (field === 1 && v.wire === 2) keyValue(v.bytes, depth + 1, out, budget);
  });
  return out;
}

function scopeName(buf: Uint8Array, depth: number, budget: ValueBudget): string | null {
  guard(depth);
  let name = null as Value | null;
  each(buf, budget, (field, v) => {
    if (field === 1) name = v;
  });
  return text(name);
}

/**
 * A ResourceSpans or ResourceLogs: its resource (field 1) and each scope's records (field 2), read once the resource is
 * known whatever order the fields came in.
 */
function resourceRecords(buf: Uint8Array, depth: number, budget: ValueBudget, scoped: (scope: Uint8Array, resource: Attrs) => void): void {
  guard(depth);
  budget.take();
  let resourceBytes = null as Uint8Array | null;
  const scopes: Uint8Array[] = [];
  each(buf, budget, (field, v) => {
    if (v.wire !== 2) return;
    if (field === 1) {
      resourceBytes = v.bytes;
    } else if (field === 2) {
      budget.take();
      scopes.push(v.bytes);
    }
  });

  const resource = resourceBytes ? resourceAttrs(resourceBytes, depth + 1, budget) : emptyAttrs();
  for (const s of scopes) scoped(s, resource);
}

/** A ScopeSpans or ScopeLogs: its scope's name (field 1) and its records (field 2), each counted as it is found. */
function scopeRecords(
  buf: Uint8Array,
  depth: number,
  budget: ValueBudget,
  count: () => void,
  record: (bytes: Uint8Array, scope: string | null) => void,
): void {
  guard(depth);
  let scope = null as string | null;
  const records: Uint8Array[] = [];
  each(buf, budget, (field, v) => {
    if (v.wire !== 2) return;
    if (field === 1) {
      scope = scopeName(v.bytes, depth + 1, budget);
    } else if (field === 2) {
      count();
      records.push(v.bytes);
    }
  });
  for (const r of records) record(r, scope);
}

/** The fields of a span this reads, by number: each one's last value. */
const SPAN_FIELDS = new Set([1, 2, 4, 5, 6, 7, 8]);

function span(buf: Uint8Array, depth: number, budget: ValueBudget, resource: Attrs, scope: string | null): OtlpSpan {
  guard(depth);
  const attrs = emptyAttrs();
  const last = new Map<number, Value>();
  let statusBytes = null as Uint8Array | null;
  each(buf, budget, (field, v) => {
    if (SPAN_FIELDS.has(field)) last.set(field, v);
    else if (field === 9 && v.wire === 2) keyValue(v.bytes, depth + 1, attrs, budget);
    else if (field === 15 && v.wire === 2) statusBytes = v.bytes;
  });

  const at = (field: number) => last.get(field) ?? null;
  return {
    resource,
    scope,
    traceId: hex(at(1)),
    spanId: hex(at(2)),
    parentSpanId: hex(at(4)) || null,
    name: text(at(5)) ?? "",
    kind: small(at(6)),
    startMs: time(at(7)),
    endMs: time(at(8)),
    attrs,
    status: statusBytes ? status(statusBytes, depth + 1, budget) : { code: 0, message: null },
  };
}

function status(buf: Uint8Array, depth: number, budget: ValueBudget): OtlpSpan["status"] {
  guard(depth);
  let message = null as Value | null;
  let code = null as Value | null;
  each(buf, budget, (field, v) => {
    if (field === 2) message = v;
    else if (field === 3) code = v;
  });
  return { code: small(code), message: text(message) };
}

/** The fields of a log record this reads, by number: each one's last value. */
const LOG_FIELDS = new Set([1, 2, 3, 9, 10, 11, 12]);

function logRecord(buf: Uint8Array, depth: number, budget: ValueBudget, resource: Attrs, scope: string | null): OtlpLog {
  guard(depth);
  const attrs = emptyAttrs();
  const last = new Map<number, Value>();
  let body = null as Uint8Array | null;
  each(buf, budget, (field, v) => {
    if (LOG_FIELDS.has(field)) last.set(field, v);
    else if (field === 5 && v.wire === 2) body = v.bytes;
    else if (field === 6 && v.wire === 2) keyValue(v.bytes, depth + 1, attrs, budget);
  });

  const at = (field: number) => last.get(field) ?? null;
  const out: OtlpLog = {
    resource,
    scope,
    timeMs: time(at(1)),
    observedMs: time(at(11)),
    severityNumber: small(at(2)),
    severityText: text(at(3)),
    body: null,
    attrs,
    traceId: hex(at(9)) || null,
    spanId: hex(at(10)) || null,
    eventName: text(at(12)) || null,
  };
  if (body) {
    budget.take();
    out.body = anyValue(body, depth + 1, budget);
  }
  return out;
}

/** An ExportTraceServiceRequest. */
export function decodeTraces(body: Uint8Array): OtlpBatch {
  const count = recordCounter();
  const budget = new ValueBudget();
  const spans: OtlpSpan[] = [];
  each(body, budget, (field, v) => {
    if (field !== 1 || v.wire !== 2) return;
    resourceRecords(v.bytes, 1, budget, (scope, resource) =>
      scopeRecords(scope, 2, budget, count, (bytes, name) => {
        spans.push(span(bytes, 3, budget, resource, name));
      }),
    );
  });
  return { spans, logs: [] };
}

/** An ExportLogsServiceRequest. */
export function decodeLogs(body: Uint8Array): OtlpBatch {
  const count = recordCounter();
  const budget = new ValueBudget();
  const logs: OtlpLog[] = [];
  each(body, budget, (field, v) => {
    if (field !== 1 || v.wire !== 2) return;
    resourceRecords(v.bytes, 1, budget, (scope, resource) =>
      scopeRecords(scope, 2, budget, count, (bytes, name) => {
        logs.push(logRecord(bytes, 3, budget, resource, name));
      }),
    );
  });
  return { spans: [], logs };
}
