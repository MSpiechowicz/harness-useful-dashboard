import {
  type AttrValue,
  type Attrs,
  emptyAttrs,
  MAX_DEPTH,
  MAX_FIELDS,
  nanosToMs,
  OtlpDecodeError,
  type OtlpBatch,
  type OtlpLog,
  type OtlpSpan,
  OtlpTooLarge,
  recordCounter,
  ValueBudget,
} from "./model.ts";

/**
 * OTLP/JSON bodies: the protobuf messages in lowerCamelCase, ids as hex, 64-bit integers as strings. Read into the same
 * OtlpBatch as protobuf. A body that is no JSON object, or nests values too deeply, is rejected, and one that carries
 * more attribute values, resources and scopes than MAX_VALUES, or more values of any kind than MAX_FIELDS, is too large.
 * Nesting and the count of values are looked at before the body is parsed, so parsing never takes long.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown) => (typeof v === "string" ? v : null);

function guard(depth: number): void {
  if (depth > MAX_DEPTH) throw new OtlpDecodeError("value nested too deeply");
}

/** A number sent as a number or a string ("123"), as int64 and enums may be. */
function number(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** The most digits a uint64 has: a longer string is no time, and never read into a BigInt (that takes long). */
const MAX_DIGITS = 20;

/** Unix nanoseconds, a string as the spec sends them (or a number), as epoch ms. */
function ms(v: unknown): number | null {
  if (typeof v === "string" && v.length <= MAX_DIGITS && /^\d+$/.test(v)) return nanosToMs(BigInt(v));
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return nanosToMs(BigInt(Math.trunc(v)));
  return null;
}

/** An id as lowercase hex: hex as the spec sends it, or base64 as generic protobuf JSON encodes bytes. */
function id(v: unknown): string {
  if (typeof v !== "string" || v === "") return "";
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return v.toLowerCase();
  return Buffer.from(v, "base64").toString("hex");
}

function anyValue(v: unknown, depth: number, budget: ValueBudget): AttrValue {
  guard(depth);
  if (!isObject(v)) return null;

  if ("stringValue" in v) return text(v.stringValue) ?? "";
  if ("boolValue" in v) return v.boolValue === true || v.boolValue === "true";
  if ("intValue" in v) return number(v.intValue);
  if ("doubleValue" in v) return number(v.doubleValue);
  if ("arrayValue" in v) return values(isObject(v.arrayValue) ? v.arrayValue.values : null, depth + 1, budget);
  if ("kvlistValue" in v) return attrs(isObject(v.kvlistValue) ? v.kvlistValue.values : null, depth + 1, budget);
  if ("bytesValue" in v) return new Uint8Array(Buffer.from(text(v.bytesValue) ?? "", "base64"));
  return null;
}

/** An ArrayValue's values, each counted against the budget. */
function values(v: unknown, depth: number, budget: ValueBudget): AttrValue[] {
  const items = list(v);
  budget.list(items.length);
  return items.map((x) => {
    budget.take();
    return anyValue(x, depth + 1, budget);
  });
}

/** A repeated KeyValue as one object, each attribute counted against the budget. */
function attrs(v: unknown, depth: number, budget: ValueBudget): Attrs {
  guard(depth);
  const out = emptyAttrs();
  for (const kv of list(v)) {
    if (!isObject(kv) || typeof kv.key !== "string" || !kv.key) continue;

    budget.take();
    out[kv.key] = anyValue(kv.value, depth + 1, budget);
  }
  return out;
}

function span(s: Json, budget: ValueBudget, resource: Attrs, scope: string | null): OtlpSpan {
  const status = isObject(s.status) ? s.status : {};
  return {
    resource,
    scope,
    traceId: id(s.traceId),
    spanId: id(s.spanId),
    parentSpanId: id(s.parentSpanId) || null,
    name: text(s.name) ?? "",
    kind: number(s.kind),
    startMs: ms(s.startTimeUnixNano),
    endMs: ms(s.endTimeUnixNano),
    attrs: attrs(s.attributes, 4, budget),
    status: { code: number(status.code), message: text(status.message) },
  };
}

function logRecord(l: Json, budget: ValueBudget, resource: Attrs, scope: string | null): OtlpLog {
  if (l.body != null) budget.take();
  return {
    resource,
    scope,
    timeMs: ms(l.timeUnixNano),
    observedMs: ms(l.observedTimeUnixNano),
    severityNumber: number(l.severityNumber),
    severityText: text(l.severityText),
    body: anyValue(l.body, 4, budget),
    attrs: attrs(l.attributes, 4, budget),
    traceId: id(l.traceId) || null,
    spanId: id(l.spanId) || null,
    eventName: text(l.eventName) || null,
  };
}

/** Brackets a body may have open at once. Values nested as deep as MAX_DEPTH allows take fewer. */
const MAX_BRACKETS = 64;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const [OPEN_ARRAY, CLOSE_ARRAY, OPEN_OBJECT, CLOSE_OBJECT] = [0x5b, 0x5d, 0x7b, 0x7d];

/**
 * Rejects a body that nests brackets more than MAX_BRACKETS deep, or has more than MAX_FIELDS objects, arrays and list
 * items, in one pass over its bytes: a parse of it would take long. Brackets and commas within strings don't count.
 */
function prescan(body: Uint8Array): void {
  let depth = 0;
  let values = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
      continue;
    }

    if (c === QUOTE) {
      inString = true;
    } else if (c === OPEN_ARRAY || c === OPEN_OBJECT) {
      if (++depth > MAX_BRACKETS) throw new OtlpDecodeError("body nested too deeply");
      if (++values > MAX_FIELDS) throw new OtlpTooLarge(`more than ${MAX_FIELDS} values`);
    } else if (c === CLOSE_ARRAY || c === CLOSE_OBJECT) {
      depth--;
    } else if (c === COMMA) {
      if (++values > MAX_FIELDS) throw new OtlpTooLarge(`more than ${MAX_FIELDS} values`);
    }
  }
}

function parse(body: Uint8Array): Json {
  prescan(body);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new OtlpDecodeError("body is not valid JSON");
  }
  if (!isObject(v)) throw new OtlpDecodeError("body is not a JSON object");
  return v;
}

/**
 * Each record of an export: the resources under `resourceKey`, their scopes under `scopeKey` and the records under
 * `recordKey`, with the resource's attributes and the scope's name.
 */
function walk(root: Json, keys: [string, string, string], on: (record: Json, budget: ValueBudget, resource: Attrs, scope: string | null) => void): void {
  const [resourceKey, scopeKey, recordKey] = keys;
  const count = recordCounter();
  const budget = new ValueBudget();
  // Each resource and scope counts against the budget too, so a body of empty ones is as large as one of values.
  for (const r of list(root[resourceKey])) {
    budget.take();
    if (!isObject(r)) continue;
    const resource = attrs(isObject(r.resource) ? r.resource.attributes : null, 2, budget);

    for (const s of list(r[scopeKey])) {
      budget.take();
      if (!isObject(s)) continue;
      const scope = isObject(s.scope) ? text(s.scope.name) : null;

      // Each record counts, also one that is no object: a list of millions of numbers is too large, not skipped.
      for (const rec of list(s[recordKey])) {
        count();
        if (!isObject(rec)) continue;
        on(rec, budget, resource, scope);
      }
    }
  }
}

export function decodeTracesJson(body: Uint8Array): OtlpBatch {
  const spans: OtlpSpan[] = [];
  walk(parse(body), ["resourceSpans", "scopeSpans", "spans"], (s, budget, resource, scope) => spans.push(span(s, budget, resource, scope)));
  return { spans, logs: [] };
}

export function decodeLogsJson(body: Uint8Array): OtlpBatch {
  const logs: OtlpLog[] = [];
  walk(parse(body), ["resourceLogs", "scopeLogs", "logRecords"], (l, budget, resource, scope) => logs.push(logRecord(l, budget, resource, scope)));
  return { spans: [], logs };
}
