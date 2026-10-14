import { describe, expect, test } from "bun:test";
import { MAX_BYTES, MAX_LIST, MAX_VALUES } from "../src/core/otlp/model.ts";
import { decodeOtlp, MAX_RECORDS, OtlpDecodeError, OtlpTooLarge } from "../src/core/otlp/write.ts";
import { type AttrIn, claudeLogs, dbl, encodeLogs, encodeTraces, HERMES_TRACE, hermesSpans, logsJson, Pb, type SpanIn, T0, tracesJson } from "./otlpEncode.ts";

const span = (over: Partial<SpanIn> = {}): SpanIn => ({ traceId: HERMES_TRACE, spanId: "00f067aa0ba902b7", name: "chat gpt-5", startMs: T0, endMs: T0 + 1500, ...over });
const traces = (spans: SpanIn[], resource: Record<string, AttrIn> = { "service.name": "svc" }) => [{ resource, scope: { name: "my.scope", version: "1.0" }, records: spans }];

describe("decodeOtlp protobuf", () => {
  test("reads a Hermes trace export: ids as hex, times in ms, resource, scope and attributes", () => {
    const batch = decodeOtlp("traces", encodeTraces(hermesSpans({ host: "build-box" })), "protobuf");
    expect(batch.logs).toEqual([]);
    expect(batch.spans.map((s) => s.name)).toEqual([
      "agent",
      "llm.anthropic/claude-sonnet-4.5",
      "api.anthropic/claude-sonnet-4.5",
      "tool.read_file",
      "api.anthropic/claude-sonnet-4.5",
      "subagent.researcher",
    ]);

    const api = batch.spans[2]!;
    expect(api.traceId).toBe(HERMES_TRACE);
    expect(api.spanId).toBe("1000000000000003");
    expect(api.parentSpanId).toBe("1000000000000002");
    expect(api.kind).toBe(1);
    expect(api.startMs).toBe(T0 + 1_000);
    expect(api.endMs).toBe(T0 + 6_000);
    expect(api.scope).toBe("hermes-otel-plugin");
    expect(api.resource).toMatchObject({ "service.name": "hermes-agent", "host.name": "build-box", "process.pid": 41237 });
    expect(api.attrs["gen_ai.usage.input_tokens"]).toBe(12_000);
    expect(api.attrs["hermes.cost.usage"]).toBe(0.0123);
    expect(api.attrs["gen_ai.response.finish_reasons"]).toEqual(["tool_calls"]);
    expect(batch.spans[0]!.parentSpanId).toBeNull();
  });

  test("reads every AnyValue kind", () => {
    const attrs: Record<string, AttrIn> = {
      s: "text",
      t: true,
      f: false,
      neg: -42,
      big: 9_007_199_254_740_991,
      d: dbl(2),
      pi: 3.25,
      arr: ["a", 1, [true]],
      kv: { inner: "x", n: 7 },
      raw: Uint8Array.from([0, 1, 254]),
    };
    const [s] = decodeOtlp("traces", encodeTraces(traces([span({ attrs, status: { code: 2, message: "boom" } })])), "protobuf").spans;
    expect(s!.attrs).toEqual({ ...attrs, d: 2 } as never);
    expect(s!.status).toEqual({ code: 2, message: "boom" });
  });

  test("reads a Claude Code log export: event name, body, times and attributes", () => {
    const { logs } = decodeOtlp("logs", encodeLogs(claudeLogs({ host: "laptop-2" })), "protobuf");
    expect(logs).toHaveLength(4);
    expect(logs[0]!.body).toBe("claude_code.user_prompt");
    expect(logs[0]!.eventName).toBeNull();
    expect(logs[1]!.eventName).toBe("claude_code.api_request");
    expect(logs[1]!.timeMs).toBe(T0 + 4_000);
    expect(logs[1]!.observedMs).toBe(T0 + 4_000);
    expect(logs[1]!.attrs.input_tokens).toBe("12");
    expect(logs[1]!.scope).toBe("com.anthropic.claude_code.events");
    expect(logs[1]!.resource["host.name"]).toBe("laptop-2");
  });

  test("skips fields it does not know, of every wire type", () => {
    const known = encodeTraces(traces([span()]));
    // An unknown varint, fixed64, length-delimited and fixed32 field at the top of the request.
    const extra = new Pb().int(90, 5).fixed64(91, 7n).string(92, "x").tag(93, 5).raw([1, 2, 3, 4]).finish();
    const body = Uint8Array.from([...extra, ...known]);
    expect(decodeOtlp("traces", body, "protobuf")).toEqual(decodeOtlp("traces", known, "protobuf"));
  });

  test("rejects a body cut short, a length past its end and group wire types", () => {
    const body = encodeTraces(hermesSpans());
    expect(() => decodeOtlp("traces", body.subarray(0, body.length - 3), "protobuf")).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp("traces", new Pb().tag(1, 2).varint(500).raw([1, 2]).finish(), "protobuf")).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp("traces", new Pb().tag(1, 3).finish(), "protobuf")).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp("traces", new Pb().tag(7, 4).finish(), "protobuf")).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp("traces", Uint8Array.from([0x80]), "protobuf")).toThrow(OtlpDecodeError);
  });

  test("rejects values nested too deeply", () => {
    const nest = (n: number): AttrIn => (n === 0 ? "leaf" : [nest(n - 1)]);
    expect(decodeOtlp("traces", encodeTraces(traces([span({ attrs: { v: nest(10) } })])), "protobuf").spans).toHaveLength(1);
    expect(() => decodeOtlp("traces", encodeTraces(traces([span({ attrs: { v: nest(20) } })])), "protobuf")).toThrow(OtlpDecodeError);
  });

  test("rejects more records than one request may carry", () => {
    const many = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => span({ spanId: i.toString(16).padStart(16, "0") }));
    expect(decodeOtlp("traces", encodeTraces(traces(many.slice(0, MAX_RECORDS))), "protobuf").spans).toHaveLength(MAX_RECORDS);
    const err = (() => {
      try {
        decodeOtlp("traces", encodeTraces(traces(many)), "protobuf");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OtlpTooLarge);
    expect(err).toBeInstanceOf(OtlpDecodeError);
  });
});

describe("decodeOtlp JSON", () => {
  test("reads the same batch as protobuf, for traces and logs", () => {
    const spans = hermesSpans({ host: "build-box" });
    expect(decodeOtlp("traces", tracesJson(spans), "json")).toEqual(decodeOtlp("traces", encodeTraces(spans), "protobuf"));
    const logs = claudeLogs({ host: "laptop-2" });
    expect(decodeOtlp("logs", logsJson(logs), "json")).toEqual(decodeOtlp("logs", encodeLogs(logs), "protobuf"));

    const attrs: Record<string, AttrIn> = { kv: { inner: "x", n: 7 }, raw: Uint8Array.from([0, 1, 254]), arr: [1, "b"], neg: -3 };
    expect(decodeOtlp("traces", tracesJson(traces([span({ attrs })])), "json")).toEqual(decodeOtlp("traces", encodeTraces(traces([span({ attrs })])), "protobuf"));
  });

  test("takes numbers sent as strings and base64 ids", () => {
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: Buffer.from(HERMES_TRACE, "hex").toString("base64"),
                  spanId: "00F067AA0BA902B7",
                  name: "chat",
                  kind: "3",
                  startTimeUnixNano: String(BigInt(T0) * 1_000_000n),
                  endTimeUnixNano: Number(BigInt(T0 + 1000) * 1_000_000n),
                  attributes: [
                    { key: "n", value: { intValue: "42" } },
                    { key: "d", value: { doubleValue: "1.5" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const [s] = decodeOtlp("traces", new TextEncoder().encode(JSON.stringify(body)), "json").spans;
    expect(s!.traceId).toBe(HERMES_TRACE);
    expect(s!.spanId).toBe("00f067aa0ba902b7");
    expect(s!.kind).toBe(3);
    expect(s!.startMs).toBe(T0);
    expect(s!.endMs).toBe(T0 + 1000);
    expect(s!.attrs).toEqual({ n: 42, d: 1.5 });
  });

  test("rejects bodies that are no JSON object, and values nested too deeply", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(() => decodeOtlp("logs", enc("{not json"), "json")).toThrow(OtlpDecodeError);
    expect(() => decodeOtlp("logs", enc("[1,2]"), "json")).toThrow(OtlpDecodeError);

    const nest = (n: number): AttrIn => (n === 0 ? "leaf" : [nest(n - 1)]);
    expect(() => decodeOtlp("traces", tracesJson(traces([span({ attrs: { v: nest(40) } })])), "json")).toThrow(OtlpDecodeError);
  });

  test("a time of millions of digits is no time, and is read at once", () => {
    const huge = "1".repeat(4_000_000);
    const nanos = String(BigInt(T0) * 1_000_000n);
    const records = [
      { timeUnixNano: huge, observedTimeUnixNano: nanos, body: { stringValue: "x" } },
      // A uint64 has at most 20 digits: one with more is no time, whatever it says.
      { timeUnixNano: nanos.padStart(20, "0"), observedTimeUnixNano: nanos.padStart(21, "0") },
    ];
    const body = new TextEncoder().encode(JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] }));

    const started = performance.now();
    const { logs } = decodeOtlp("logs", body, "json");
    expect(performance.now() - started).toBeLessThan(200);
    expect(logs.map((l) => [l.timeMs, l.observedMs])).toEqual([
      [null, T0],
      [T0, null],
    ]);
  });
});

describe("decodeOtlp limits", () => {
  const formats = [
    ["protobuf", (spans: SpanIn[], resource?: Record<string, AttrIn>) => decodeOtlp("traces", encodeTraces(traces(spans, resource)), "protobuf").spans],
    ["json", (spans: SpanIn[], resource?: Record<string, AttrIn>) => decodeOtlp("traces", tracesJson(traces(spans, resource)), "json").spans],
  ] as const;

  test("an attribute named __proto__ is an attribute like any other, never the object's prototype", () => {
    for (const [format, decode] of formats) {
      const resource: Record<string, AttrIn> = { ["__proto__"]: { "host.name": "proto-host" }, constructor: "c" };
      const [s] = decode([span({ attrs: { ["__proto__"]: "x" } })], resource);
      expect(s!.resource["host.name"], format).toBeUndefined();
      expect(Object.keys(s!.resource).sort(), format).toEqual(["__proto__", "constructor"]);
      expect(s!.attrs["__proto__"], format).toBe("x");
      expect(({} as Record<string, unknown>)["host.name"]).toBeUndefined();
    }
  });

  test("rejects a list longer than MAX_LIST, and more attribute values in all than MAX_VALUES", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => i);
    const lists = Math.ceil(MAX_VALUES / MAX_LIST) + 1;
    for (const [format, decode] of formats) {
      expect(decode([span({ attrs: { v: list(MAX_LIST) } })])[0]!.attrs.v, format).toHaveLength(MAX_LIST);
      expect(() => decode([span({ attrs: { v: list(MAX_LIST + 1) } })]), format).toThrow(OtlpTooLarge);

      const spans = Array.from({ length: lists }, (_, i) => span({ spanId: i.toString(16).padStart(16, "0"), attrs: { v: list(MAX_LIST) } }));
      expect(() => decode(spans), format).toThrow(OtlpTooLarge);
    }
  });

  test("a body of a million empty values is refused at once", () => {
    // A log body: one array of a million empty AnyValues, two bytes each.
    const values = new Uint8Array(2_000_000);
    for (let i = 0; i < values.length; i += 2) values[i] = 0x0a;
    const body = new Pb().message(1, new Pb().message(2, new Pb().message(2, new Pb().message(5, new Pb().bytes(5, values))))).finish();

    const started = performance.now();
    expect(() => decodeOtlp("logs", body, "protobuf")).toThrow(OtlpTooLarge);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("a body of empty resources, scopes or records is refused at once", () => {
    const n = 300_000;
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    const empties = Array.from({ length: n }, () => ({}));
    const pbRepeat = (field: number, inner: Uint8Array = new Uint8Array(0)) => {
      const one = new Pb().bytes(field, inner).finish();
      const out = new Uint8Array(one.length * n);
      for (let i = 0; i < n; i++) out.set(one, i * one.length);
      return out;
    };
    const bodies: [string, () => unknown][] = [
      ["json resources", () => decodeOtlp("traces", enc({ resourceSpans: empties }), "json")],
      ["json scopes", () => decodeOtlp("logs", enc({ resourceLogs: [{ scopeLogs: empties }] }), "json")],
      ["protobuf resources", () => decodeOtlp("traces", pbRepeat(1), "protobuf")],
      ["protobuf scopes", () => decodeOtlp("logs", new Pb().bytes(1, pbRepeat(2)).finish(), "protobuf")],
      ["protobuf records", () => decodeOtlp("traces", new Pb().message(1, new Pb().bytes(2, pbRepeat(2))).finish(), "protobuf")],
    ];

    for (const [what, decode] of bodies) {
      const started = performance.now();
      expect(decode, what).toThrow(OtlpTooLarge);
      expect(performance.now() - started, what).toBeLessThan(1000);
    }
  });

  test("a body as large as may be of tiny fields is refused or read at once, and a larger one is never read", () => {
    /** A length-delimited field around `inner`, without copying it a byte at a time. */
    const wrap = (field: number, inner: Uint8Array) => {
      const head = new Pb().tag(field, 2).varint(inner.length).finish();
      const out = new Uint8Array(head.length + inner.length);
      out.set(head);
      out.set(inner, head.length);
      return out;
    };
    /** One span of `unit` again and again, the body MAX_BYTES at most. */
    const spanOf = (unit: number[]) => {
      const n = Math.floor((MAX_BYTES - 64) / unit.length);
      const inner = new Uint8Array(n * unit.length);
      for (let i = 0; i < n; i++) inner.set(unit, i * unit.length);
      return wrap(1, wrap(2, wrap(2, inner)));
    };
    const timed = (what: string, decode: () => unknown) => {
      const started = performance.now();
      let out: unknown;
      try {
        out = decode();
      } catch (err) {
        out = err;
      }
      expect(performance.now() - started, what).toBeLessThan(1500);
      return out;
    };

    const tiny = timed("1-byte unknown varints", () => decodeOtlp("traces", spanOf([0x18, 0x00]), "protobuf"));
    expect(tiny).toBeInstanceOf(OtlpTooLarge);
    const long = timed("10-byte unknown varints", () => decodeOtlp("traces", spanOf([0x18, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), "protobuf"));
    expect((long as ReturnType<typeof decodeOtlp>).spans).toHaveLength(1);
    const ids = timed("a trace id sent again and again", () => decodeOtlp("traces", spanOf([0x0a, 16, ...Array(16).fill(0xab)]), "protobuf"));
    expect((ids as ReturnType<typeof decodeOtlp>).spans[0]!.traceId).toBe("ab".repeat(16));
    expect(timed("a name sent again and again", () => decodeOtlp("traces", spanOf([0x2a, 1, 0x61]), "protobuf"))).toBeInstanceOf(OtlpTooLarge);
    expect(timed("past MAX_BYTES", () => decodeOtlp("traces", new Uint8Array(MAX_BYTES + 1), "protobuf"))).toBeInstanceOf(OtlpTooLarge);

    const json = (text: string) => decodeOtlp("traces", new TextEncoder().encode(text), "json");
    const half = MAX_BYTES / 2 - 16;
    const deep = timed("json nested deep", () => json(`{"x":${"[".repeat(half)}${"]".repeat(half)}}`));
    expect(deep).toBeInstanceOf(OtlpDecodeError);
    expect(deep).not.toBeInstanceOf(OtlpTooLarge);
    expect(timed("json empty objects", () => json(`{"x":[${"{},".repeat(MAX_BYTES / 3 - 10)}{}]}`))).toBeInstanceOf(OtlpTooLarge);
    expect(timed("json records that are no object", () => json(`{"resourceSpans":[{"scopeSpans":[{"spans":[${"0,".repeat(half)}0]}]}]}`))).toBeInstanceOf(OtlpTooLarge);
    expect(timed("json records under the field cap", () => json(`{"resourceSpans":[{"scopeSpans":[{"spans":[${"0,".repeat(MAX_RECORDS)}0]}]}]}`))).toBeInstanceOf(OtlpTooLarge);
    // Brackets in a string are text, not nesting.
    expect(json(`{"resourceSpans":[],"note":"${"[{".repeat(1000)}\\"${"]}".repeat(1000)}"}`)).toEqual({ spans: [], logs: [] });
  });

  test("a value sent more than once is read once, the last one", () => {
    const twice = new Pb().string(1, "first").string(1, "second").finish();
    const kv = new Pb().string(1, "k").bytes(2, twice);
    const body = new Pb().message(1, new Pb().message(2, new Pb().message(2, new Pb().fixed64(1, 1n).message(6, kv)))).finish();
    expect(decodeOtlp("logs", body, "protobuf").logs[0]!.attrs).toEqual({ k: "second" });
  });
});
