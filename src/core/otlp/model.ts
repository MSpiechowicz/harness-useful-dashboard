/**
 * What an OTLP/HTTP export carries, decoded from protobuf (proto.ts) or OTLP/JSON (json.ts) into one shape: the spans
 * and log records, each with the attributes of the resource and the scope that sent it.
 */

/** An attribute's value: AnyValue with its int64 as a number, a kvlist as an object and bytes as they came. */
export type AttrValue = string | number | boolean | null | Uint8Array | AttrValue[] | { [key: string]: AttrValue };

export type Attrs = Record<string, AttrValue>;

/** Attributes with no prototype: a key like `__proto__` or `constructor` is just a key. */
export const emptyAttrs = (): Attrs => Object.create(null) as Attrs;

export interface OtlpSpan {
  resource: Attrs;
  scope: string | null;
  /** Lowercase hex. */
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  /** Epoch ms. */
  startMs: number | null;
  endMs: number | null;
  attrs: Attrs;
  status: { code: number; message: string | null };
}

export interface OtlpLog {
  resource: Attrs;
  scope: string | null;
  /** Epoch ms. */
  timeMs: number | null;
  observedMs: number | null;
  severityNumber: number;
  severityText: string | null;
  body: AttrValue;
  attrs: Attrs;
  traceId: string | null;
  spanId: string | null;
  eventName: string | null;
}

export interface OtlpBatch {
  spans: OtlpSpan[];
  logs: OtlpLog[];
}

/** A body that is no valid export: the request is rejected whole. */
export class OtlpDecodeError extends Error {}

/** An export with more spans and log records than one request may carry. */
export class OtlpTooLarge extends OtlpDecodeError {}

/** The most spans and log records one request may carry. */
export const MAX_RECORDS = 10_000;

/** Nesting deeper than this (messages within messages, values within values) is rejected. */
export const MAX_DEPTH = 32;

/** The most attribute values one request may carry: every attribute, array element and kvlist entry, at any depth. */
export const MAX_VALUES = 200_000;

/** The most elements one array or kvlist value may have. */
export const MAX_LIST = 10_000;

/** The largest body decoded, in bytes: what the listener takes once inflated. */
export const MAX_BYTES = 8 * 1024 * 1024;

/**
 * The most fields one request may carry, in protobuf at every depth (known ones and skipped ones alike), in JSON every
 * object, array and list item: what bounds the work of reading a body of many tiny fields.
 */
export const MAX_FIELDS = 2_000_000;

/** Unix nanoseconds as epoch ms; zero (unset) is null. */
export function nanosToMs(nanos: bigint): number | null {
  return nanos > 0n ? Number(nanos / 1_000_000n) : null;
}

/** Counts the records decoded so far against MAX_RECORDS. */
export function recordCounter(): () => void {
  let n = 0;
  return () => {
    if (++n > MAX_RECORDS) throw new OtlpTooLarge(`more than ${MAX_RECORDS} spans and log records`);
  };
}

/**
 * Counts the attribute values decoded so far against MAX_VALUES, one list's length against MAX_LIST, and the protobuf
 * fields read against MAX_FIELDS.
 */
export class ValueBudget {
  private n = 0;
  private fields = 0;

  take(): void {
    if (++this.n > MAX_VALUES) throw new OtlpTooLarge(`more than ${MAX_VALUES} attribute values`);
  }

  field(): void {
    if (++this.fields > MAX_FIELDS) throw new OtlpTooLarge(`more than ${MAX_FIELDS} fields`);
  }

  list(length: number): void {
    if (length > MAX_LIST) throw new OtlpTooLarge(`a list of more than ${MAX_LIST} values`);
  }
}
