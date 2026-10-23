import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanName, identityOf, MAX_COST, MAX_HOSTS, MAX_TOKENS, type MapContext, type MappedGroup, mapBatch } from "../src/core/otlp/map.ts";
import { safePart, sessionId as chatSessionId } from "../src/core/ingest/copilotChatIds.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import type { Attrs, OtlpBatch, OtlpSpan } from "../src/core/otlp/model.ts";
import { decodeOtlp } from "../src/core/otlp/write.ts";
import {
  type AttrIn,
  CLAUDE_PROMPT,
  CLAUDE_SESSION,
  claudeLogs,
  dbl,
  encodeLogs,
  encodeTraces,
  HERMES_CHILD,
  HERMES_SESSION,
  HERMES_TRACE,
  hermesSpans,
  type ResourceIn,
  type SpanIn,
  T0,
} from "./otlpEncode.ts";

const CTX: MapContext = { storeText: false, textLimit: 2000, label: "ci-token", credKey: "tci", localHost: "devbox" };
/** What every id of the credential is namespaced with. */
const NS = "otlp:tci:";

const traces = (r: ResourceIn<SpanIn>[], ctx: Partial<MapContext> = {}) => mapBatch(decodeOtlp("traces", encodeTraces(r), "protobuf"), { ...CTX, ...ctx });
const logs = (r: ReturnType<typeof claudeLogs>, ctx: Partial<MapContext> = {}) => mapBatch(decodeOtlp("logs", encodeLogs(r), "protobuf"), { ...CTX, ...ctx });

/** The one group a single-resource batch maps to. */
function only(groups: MappedGroup[]): MappedGroup {
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

function sessions(g: MappedGroup) {
  const out: Record<string, unknown>[] = [];
  g.sessions.flush({ session: (s) => out.push({ ...s }), prompt() {}, usage() {}, tool() {} });
  return out;
}

describe("mapBatch: Hermes", () => {
  test("each api.* span is one call, its cache reads and writes taken out of the input", () => {
    const g = only(traces(hermesSpans()).groups);
    expect(g.usage).toHaveLength(2);

    const [first, second] = g.usage;
    expect(first).toMatchObject({
      id: `${NS}hermes:${HERMES_TRACE}:1000000000000003`,
      provider: "hermes",
      sessionId: `${NS}hermes:${HERMES_SESSION}`,
      ts: T0 + 6_000,
      model: "anthropic/claude-sonnet-4.5",
      agent: "main",
      isSubagent: false,
      input: 1_000,
      output: 400,
      cacheRead: 9_000,
      cacheWrite: 2_000,
      reasoning: 120,
      costUsd: 0.0123,
    });
    expect(second).toMatchObject({ input: 500, output: 500, cacheRead: 11_500, cacheWrite: 0, costUsd: null });
    expect(g.meta[0]).toEqual({ usageId: first!.id, startTs: T0 + 1_000, endTs: T0 + 6_000, stopReason: "tool_calls" });
  });

  test("llm.* turn totals never count as calls, nor as generic GenAI spans", () => {
    const [r] = hermesSpans();
    const llmOnly = { ...r!, records: r!.records.filter((s) => s.name.startsWith("llm.")) };
    expect(traces([llmOnly]).groups.flatMap((g) => g.usage)).toEqual([]);

    // Recognised as Hermes by its hermes.* attributes alone, without the Hermes resource.
    const anon = { resource: { "service.name": "agent" }, records: [{ ...llmOnly.records[0]!, attrs: { ...llmOnly.records[0]!.attrs, "hermes.session_id": "s" } }] };
    expect(traces([anon]).groups.flatMap((g) => g.usage)).toEqual([]);
  });

  test("tool.* spans are tool calls under their model call, with their outcome", () => {
    const g = only(traces(hermesSpans()).groups);
    expect(g.tools).toEqual([
      {
        id: `${NS}hermes:${HERMES_TRACE}:1000000000000004`,
        usageId: `${NS}hermes:${HERMES_TRACE}:1000000000000003`,
        sessionId: `${NS}hermes:${HERMES_SESSION}`,
        promptId: null,
        provider: "hermes",
        ts: T0 + 6_100,
        project: null,
        tool: "read_file",
        filePath: null,
        skill: null,
        agent: "main",
      },
    ]);
    expect(g.outcomes).toEqual([expect.objectContaining({ id: g.tools[0]!.id, kind: "tool_ok" })]);
  });

  test("subagent.* spans make the child session, its brief and path only when text is kept", () => {
    const off = sessions(only(traces(hermesSpans()).groups));
    expect(off.find((s) => s.id === `${NS}hermes:${HERMES_CHILD}`)).toMatchObject({
      provider: "hermes",
      nativeId: HERMES_CHILD,
      parentSessionId: `${NS}hermes:${HERMES_SESSION}`,
      agent: "researcher",
      brief: null,
      startedAt: T0 + 11_000,
    });
    const parent = off.find((s) => s.id === `${NS}hermes:${HERMES_SESSION}`)!;
    expect(parent).toMatchObject({ startedAt: T0, endedAt: T0 + 120_000 });
    expect(parent.parentSessionId ?? null).toBeNull();

    const g = only(traces(hermesSpans(), { storeText: true, textLimit: 10 }).groups);
    expect(sessions(g).find((s) => s.id === `${NS}hermes:${HERMES_CHILD}`)!.brief).toBe("find every…");
    expect(g.tools[0]!.filePath).toBe("/srv/app/p…");
  });

  test("api.error spans and calls without tokens are no usage", () => {
    const err: SpanIn = { traceId: HERMES_TRACE, spanId: "1000000000000009", name: "api.error", startMs: T0, endMs: T0 + 1, attrs: { "session.id": "s1", "gen_ai.usage.output_tokens": 5 } };
    const empty: SpanIn = { ...err, spanId: "100000000000000a", name: "api.gpt-5", attrs: { "session.id": "s1", "gen_ai.usage.input_tokens": 0 } };
    const g = only(traces([{ resource: { "service.name": "hermes-agent" }, records: [err, empty] }]).groups);
    expect(g.usage).toEqual([]);
  });
});

describe("mapBatch: Claude Code logs", () => {
  test("api_request is a Claude call priced by the book: its cost_usd is not read", () => {
    const g = only(logs(claudeLogs({ host: "laptop-2" })).groups);
    expect(g.usage).toEqual([
      {
        id: `${NS}claude:req_011CXabc`,
        provider: "claude",
        sessionId: `${NS}claude:${CLAUDE_SESSION}`,
        promptId: `${NS}claude:${CLAUDE_SESSION}:${CLAUDE_PROMPT}`,
        ts: T0 + 4_000,
        project: "payments-api",
        model: "claude-opus-5-5",
        skill: null,
        agent: "main",
        isSubagent: false,
        input: 12,
        output: 450,
        cacheRead: 30_000,
        cacheWrite: 1_500,
        cacheWrite1h: 0,
        reasoning: 0,
        speed: "normal",
      },
    ]);
    expect(g.meta).toEqual([{ usageId: `${NS}claude:req_011CXabc`, startTs: T0 + 800, endTs: T0 + 4_000 }]);
  });

  test("tool_result is a tool call with its outcome, user_prompt a prompt with text only when kept", () => {
    const g = only(logs(claudeLogs({ host: "laptop-2" })).groups);
    expect(g.tools.map((t) => [t.id, t.tool, t.filePath])).toEqual([
      [`${NS}claude:toolu_01ABC`, "Edit", null],
      [`${NS}claude:toolu_01DEF`, "Bash", null],
    ]);
    expect(g.outcomes.map((o) => [o.id, o.kind])).toEqual([
      [`${NS}claude:toolu_01ABC`, "tool_ok"],
      [`${NS}claude:toolu_01DEF`, "tool_error"],
    ]);
    expect(g.prompts).toEqual([
      { id: `${NS}claude:${CLAUDE_SESSION}:${CLAUDE_PROMPT}`, sessionId: `${NS}claude:${CLAUDE_SESSION}`, provider: "claude", ts: T0, text: null, skill: null, isCommand: false },
    ]);

    const kept = only(logs(claudeLogs({ host: "laptop-2" }), { storeText: true, textLimit: 9 }).groups);
    expect(kept.prompts[0]!.text).toBe("add retri…");
  });

  test("logs from this machine are skipped: its transcripts count them already", () => {
    const local = logs(claudeLogs({ host: "DevBox" }));
    expect(local.groups).toEqual([]);
    expect(local.skipped).toBe(4);
    expect(local.skippedFor).toEqual({ other: 4 });
  });

  test("Claude Code spans are skipped: its logs carry the same calls", () => {
    const span: SpanIn = { traceId: HERMES_TRACE, spanId: "00f067aa0ba902b7", name: "claude_code.llm_request", startMs: T0, endMs: T0 + 10, attrs: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 50 } };
    const mapped = traces([{ resource: { "service.name": "claude-code" }, records: [span] }]);
    expect(mapped.groups).toEqual([]);
    expect(mapped.skipped).toBe(1);
    expect(mapped.skippedFor).toEqual({ other: 1 });
  });
});

describe("mapBatch: generic GenAI spans", () => {
  test("a chat span with token counts is an otel call; other operations are not", () => {
    const chat: SpanIn = {
      traceId: HERMES_TRACE,
      spanId: "00f067aa0ba902b7",
      name: "chat gpt-5",
      startMs: T0,
      endMs: T0 + 2_000,
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-5",
        "gen_ai.response.model": "gpt-5-2026-08-01",
        "gen_ai.conversation.id": "conv-7",
        "gen_ai.usage.input_tokens": 1_000,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.usage.cache_read.input_tokens": 600,
        "gen_ai.input.messages": "secret prompt",
      },
    };
    const embed: SpanIn = { ...chat, spanId: "00f067aa0ba902b8", attrs: { ...chat.attrs, "gen_ai.operation.name": "embeddings" } };
    const g = only(traces([{ resource: { "service.name": "my-agent", "host.name": "worker-3" }, records: [chat, embed] }]).groups);

    expect(g.host).toBe("worker-3");
    expect(g.usage).toEqual([
      {
        id: `${NS}otel:${HERMES_TRACE}:00f067aa0ba902b7`,
        provider: "otel",
        sessionId: `${NS}otel:conv-7`,
        promptId: null,
        ts: T0 + 2_000,
        project: null,
        model: "gpt-5-2026-08-01",
        skill: null,
        agent: "main",
        isSubagent: false,
        input: 400,
        output: 50,
        cacheRead: 600,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
      },
    ]);
  });
});

describe("mapBatch: identity", () => {
  test("host and user come from the resource, else the credential's label, cleaned", () => {
    const [r] = hermesSpans();
    const named = { ...r!, resource: { ...r!.resource, "host.name": "  build\u0007-box \n", "harness.user": "ana" } };
    expect(only(traces([named]).groups)).toMatchObject({ host: "build-box", user: "ana" });
    expect(only(traces(hermesSpans()).groups)).toMatchObject({ host: "ci-token", user: "ci-token" });

    const long = { ...r!, resource: { ...r!.resource, "host.name": "h".repeat(300) } };
    expect(only(traces([long]).groups).host).toHaveLength(200);
  });

  test("a long name is cut by character, never in the middle of an emoji", () => {
    const [r] = hermesSpans();
    const host = `${"h".repeat(199)}\u{1F600}tail`;
    const named = { ...r!, resource: { ...r!.resource, "host.name": host, "harness.user": `${"u".repeat(198)}\u{1F600}\u{1F600}x` } };
    const g = only(traces([named]).groups);
    expect(g.host).toBe(`${"h".repeat(199)}\u{1F600}`);
    expect(g.user).toBe(`${"u".repeat(198)}\u{1F600}\u{1F600}`);
    expect(g.host.isWellFormed()).toBe(true);
  });

  test("a remote host named like this machine is told apart from it", () => {
    expect(only(traces(hermesSpans({ host: "DEVBOX" })).groups).host).toBe("DEVBOX (remote)");
  });

  test("invisible characters, another Unicode form or the domain don't hide this machine's name", () => {
    const cases = [
      ["devbox\u200b", "devbox (remote)"],
      ["de\u200dv\u2028box", "devbox (remote)"],
      ["\uff24\uff25\uff36\uff22\uff2f\uff38", "DEVBOX (remote)"],
      ["devbox.lan", "devbox.lan (remote)"],
    ];
    for (const [host, stored] of cases) {
      expect(only(traces(hermesSpans({ host })).groups).host, host).toBe(stored!);
      // And Claude Code logs from it are this machine's own, counted from its transcripts.
      expect(logs(claudeLogs({ host })).groups, host).toEqual([]);
    }
    expect(only(traces(hermesSpans({ host: "devbox-2" })).groups).host).toBe("devbox-2");
  });

  test("a host named like one that writes rows of its own is told apart from it", () => {
    const g = only(traces(hermesSpans({ host: "their-box" }), { takenHosts: ["Their-Box.lan"] }).groups);
    expect(g.host).toBe("their-box (remote)");
  });

  test("a host that only looks like this machine or a taken host is told apart from it", () => {
    const lookalikes = [
      "dev\u200bbox", // zero-width space
      "devbox\ufe00", // variation selector
      "dev\u034fbox", // combining grapheme joiner
      "devbox\u3164", // Hangul filler
      "devbox\u2800", // braille blank
      "devbox\u{e0061}", // tag character
      "devb\u043ex", // Cyrillic о
      "devb\u043ex.lan",
    ];
    for (const host of lookalikes) {
      expect(identityOf({ "host.name": host }, "ci-token", "devbox").host, JSON.stringify(host)).toEndWith(" (remote)");
      expect(identityOf({ "host.name": host }, "ci-token", "laptop", ["DevBox"]).host, JSON.stringify(host)).toEndWith(" (remote)");
    }

    // A host of other characters, or with more of them changed than kept, is a host of its own.
    for (const host of ["devbox-2", "d\u00e9vb\u00f8x\u00e9", "\u0434\u0435\u0432\u0431\u043e\u0445"]) {
      expect(identityOf({ "host.name": host }, "ci-token", "devbox").host, host).toBe(host);
    }
  });

  test("a name of megabytes is cleaned at once: only its start is normalized", () => {
    // U+FDFA is one character that NFKC makes eighteen.
    const huge = "\ufdfa".repeat(5_000_000);
    const started = performance.now();
    const id = identityOf({ "host.name": huge, "harness.user": huge }, "ci-token", "devbox");
    expect(performance.now() - started).toBeLessThan(50);
    expect(id.host).toHaveLength(200);
    expect(id.user).toBe(cleanName(huge.slice(0, 1024)));
  });

  test("a request of 3000 resources with long host names is mapped at once, whatever hosts are taken", () => {
    // Each one 1000 characters that NFKC makes eighteen times as many, told apart by its start.
    const resources = Array.from({ length: 3000 }, (_, i) => ({ "host.name": String(i).padStart(4, "0") + "\ufdfa".repeat(996) }));
    const spans: OtlpSpan[] = resources.map((resource, i) => ({
      resource,
      scope: null,
      traceId: "ab".repeat(16),
      spanId: i.toString(16).padStart(16, "0"),
      parentSpanId: null,
      name: "chat",
      kind: 0,
      startMs: T0,
      endMs: T0 + 1_000,
      attrs: { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 10 },
      status: { code: 0, message: null },
    }));

    const started = performance.now();
    const mapped = mapBatch({ spans, logs: [] }, { ...CTX, takenHosts: ["alpha", "beta.lan", "Gamma", "delta-1", "epsilon"] });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(mapped.groups).toHaveLength(50);
    expect(mapped.groups[0]!.host).toBe(cleanName(resources[0]!["host.name"]));
    expect(mapped.skipped).toBe(2950);
    expect(mapped.skippedFor).toEqual({ identities: 2950 });
  });

  test("a cleaned name never starts or ends with whitespace, and cleaning it again changes nothing", () => {
    const names = [
      "a".repeat(199) + " b", // cut right after the space
      "a".repeat(199) + "\u00a0\u00a0b", // no-break spaces at the cut
      "a".repeat(198) + "\u2003x", // an em space at the cut
      "\u200b " + "a".repeat(250),
      "\ufdfa".repeat(11), // NFKC's expansion has spaces: one may fall at the cut
      " \u3000name\u3000 ",
      "a".repeat(1023) + " \ufdfa", // a space right before RAW_NAME
      "cafe\u200b\u0301", // a combining acute kept apart by a zero-width space
    ];
    for (const raw of names) {
      const once = cleanName(raw);
      expect(once, JSON.stringify(raw)).toBe(once.trim());
      expect(cleanName(once), JSON.stringify(raw)).toBe(once);
    }
    expect(cleanName("a".repeat(199) + " b")).toBe("a".repeat(199));
    expect(cleanName("cafe\u200b\u0301")).toBe("caf\u00e9");
  });
});

describe("mapBatch: what a sender can't do", () => {
  const [claude] = claudeLogs({ host: "laptop-2" });
  const withAttrs = (over: Record<string, AttrIn>, records = claude!.records) => [{ ...claude!, records: records.map((l) => ({ ...l, attrs: { ...l.attrs, ...over } })) }];

  test("ids are namespaced by the credential, so two senders never share a row or a session", () => {
    const a = only(logs(claudeLogs({ host: "laptop-2" })).groups);
    const b = only(logs(claudeLogs({ host: "laptop-2" }), { credKey: "b:proxy" }).groups);
    expect(b.usage[0]!.id).toBe("otlp:b:proxy:claude:req_011CXabc");
    expect(b.usage[0]!.sessionId).toBe(`otlp:b:proxy:claude:${CLAUDE_SESSION}`);
    expect(a.usage[0]!.id).not.toBe(b.usage[0]!.id);
    expect([...b.sessionIds]).toEqual([`otlp:b:proxy:claude:${CLAUDE_SESSION}`]);
  });

  test("long names are cut and long ids hashed, the same on every replay", () => {
    const huge = withAttrs({ "session.id": "S".repeat(100_000), model: "M".repeat(100_000), tool_name: "T".repeat(5_000), request_id: "R".repeat(300) });
    const g = only(logs(huge).groups);
    const u = g.usage[0]!;
    expect(u.model).toHaveLength(512);
    expect(g.tools[0]!.tool).toHaveLength(512);
    expect(u.sessionId.length).toBeLessThan(NS.length + 100);
    expect(u.id.length).toBeLessThan(NS.length + 100);
    expect(only(logs(huge).groups).usage[0]!.id).toBe(u.id);
  });

  test("a long model or tool name is cut by character, never in the middle of an emoji", () => {
    const g = only(logs(withAttrs({ model: `${"m".repeat(511)}\u{1F600}more`, tool_name: `${"t".repeat(511)}\u{1F680}` })).groups);
    expect(g.usage[0]!.model).toBe(`${"m".repeat(511)}\u{1F600}`);
    expect(g.tools[0]!.tool).toBe(`${"t".repeat(511)}\u{1F680}`);
    expect(g.usage[0]!.model?.isWellFormed()).toBe(true);
  });

  test("records with a time before 2015 or more than a day ahead are skipped", () => {
    const at = (timeMs: number) => [{ ...claude!, records: claude!.records.map((l) => ({ ...l, timeMs, observedMs: timeMs })) }];
    expect(logs(at(Date.UTC(1999, 0, 1)))).toEqual({ groups: [], skipped: 4, skippedFor: { time: 4 } });
    expect(logs(at(T0), { now: T0 - 2 * 86_400_000 })).toEqual({ groups: [], skipped: 4, skippedFor: { time: 4 } });
    expect(only(logs(at(T0), { now: T0 - 3_600_000 }).groups).usage).toHaveLength(1);

    const [hermes] = hermesSpans();
    const old = { ...hermes!, records: hermes!.records.map((s) => ({ ...s, startMs: 1_000, endMs: 2_000 })) };
    expect(traces([old])).toEqual({ groups: [], skipped: hermes!.records.length, skippedFor: { time: hermes!.records.length } });
  });

  test("records without an id of their own get one from all they say, so two such records never collide", () => {
    const api = claude!.records[1]!;
    const bare = { ...api, attrs: { ...api.attrs, request_id: "" } };
    const twin = { ...bare, observedMs: api.observedMs! + 1, attrs: { ...bare.attrs, input_tokens: "13" } };
    const g = only(logs([{ ...claude!, records: [bare, twin] }]).groups);
    expect(g.usage).toHaveLength(2);
    expect(new Set(g.usage.map((u) => u.id)).size).toBe(2);
    expect(only(logs([{ ...claude!, records: [bare, twin] }]).groups).usage.map((u) => u.id)).toEqual(g.usage.map((u) => u.id));
  });

  test("whether a prompt is a command is never read from its text when text isn't kept", () => {
    const prompt = claude!.records[0]!;
    const slash = { ...prompt, attrs: { ...prompt.attrs, prompt: "/deploy prod" } };
    const named = { ...prompt, attrs: { ...prompt.attrs, prompt: "/deploy prod", command_name: "deploy" } };
    const one = (records: typeof claude.records, ctx: Partial<MapContext> = {}) => only(logs([{ ...claude!, records }], ctx).groups).prompts[0]!;

    expect(one([slash]).isCommand).toBe(false);
    expect(one([named]).isCommand).toBe(true);
    expect(one([slash], { storeText: true })).toMatchObject({ isCommand: true, text: "/deploy prod" });
  });

  test("token counts are whole numbers from 0 to MAX_TOKENS, and a cost below 0 or past MAX_COST is not taken", () => {
    const g = only(logs(withAttrs({ input_tokens: "9007199254740991", output_tokens: "-5", cache_read_tokens: "1e308", cache_creation_tokens: "12.6" })).groups);
    expect(g.usage[0]).toMatchObject({ input: MAX_TOKENS, output: 0, cacheRead: MAX_TOKENS, cacheWrite: 13 });

    const [r] = hermesSpans();
    const withCost = (cost: number) => ({
      ...r!,
      records: r!.records.map((s) => (s.spanId === "1000000000000003" ? { ...s, attrs: { ...s.attrs, "hermes.cost.usage": dbl(cost), "gen_ai.usage.output_tokens": dbl(1e308) } } : s)),
    });
    for (const [cost, taken] of [[-1000, null], [1e308, null], [MAX_COST + 1, null], [MAX_COST, MAX_COST], [0, 0]] as const) {
      const call = only(traces([withCost(cost)]).groups).usage[0]!;
      expect(call.costUsd, String(cost)).toBe(taken);
      expect(call.output).toBe(MAX_TOKENS);
    }
  });

  test("a credential's records of a host past its first MAX_HOSTS are skipped, its known hosts' are kept", () => {
    const known = new Set(Array.from({ length: MAX_HOSTS }, (_, i) => `box-${i}`));
    const from = (host: string) => logs(claudeLogs({ host }), { knownHosts: known });
    expect(from("box-new")).toEqual({ groups: [], skipped: claude!.records.length, skippedFor: { hosts: claude!.records.length } });
    expect(only(from("box-7").groups).host).toBe("box-7");

    const fewer = new Set([...known].slice(1));
    expect(only(logs(claudeLogs({ host: "box-new" }), { knownHosts: fewer }).groups).host).toBe("box-new");
  });

  test("a request of more than 50 machines and users carries only the first 50", () => {
    const [r] = hermesSpans();
    const many = Array.from({ length: 51 }, (_, i) => ({ ...r!, resource: { ...r!.resource, "host.name": `box-${i}` } }));
    const mapped = traces(many);
    expect(mapped.groups).toHaveLength(50);
    expect(mapped.groups.some((g) => g.host === "box-50")).toBe(false);
    expect(mapped.skipped).toBe(r!.records.length);
    expect(mapped.skippedFor).toEqual({ identities: r!.records.length });
  });
});

// ---- Copilot Chat fixtures ---------------------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures", "copilot-chat", "otlp");
const fixture = (file: string) => new Uint8Array(readFileSync(join(FIXTURES, file)));

/** A decoded batch's spans as the resources they came with: a fixture sent as protobuf. */
function resourcesOf(batch: OtlpBatch): ResourceIn<SpanIn>[] {
  const out = new Map<Attrs, ResourceIn<SpanIn>>();
  for (const s of batch.spans) {
    let r = out.get(s.resource);
    if (!r) {
      r = { resource: s.resource as Record<string, AttrIn>, scope: { name: s.scope ?? "" }, records: [] };
      out.set(s.resource, r);
    }

    const attrs = Object.fromEntries(Object.entries(s.attrs).filter(([, v]) => v != null)) as Record<string, AttrIn>;
    r.records.push({
      traceId: s.traceId,
      spanId: s.spanId,
      parentSpanId: s.parentSpanId ?? undefined,
      name: s.name,
      kind: s.kind,
      startMs: s.startMs!,
      endMs: s.endMs!,
      attrs,
      status: { code: s.status.code },
    });
  }
  return [...out.values()];
}

describe("mapBatch: Copilot Chat", () => {
  const LOCAL = { host: "devbox", user: "maciej" };
  const CHAT = "a3dd1178-eb84-45ab-8531-9af4c983e955";
  const MAIN = `copilot-chat:${CHAT}`;

  const asJson = () => decodeOtlp("traces", fixture("traces-8-rounds.json"), "json");
  const asProtobuf = () => decodeOtlp("traces", encodeTraces(resourcesOf(asJson())), "protobuf");
  const day = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const sum = (rows: UsageRecord[], key: "input" | "cacheRead" | "output" | "credits") => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

  for (const [format, batch] of [["OTLP/JSON", asJson], ["protobuf", asProtobuf]] as const) {
    describe(format, () => {
      test("this machine's: the eight main calls total the turn, ids and host are its own", () => {
        const g = only(mapBatch(batch(), { ...CTX, local: LOCAL }).groups);
        expect(g.local).toBe(true);
        expect(g.host).toBe("devbox");
        expect(g.user).toBe("maciej");

        const main = g.usage.filter((u) => u.sessionId === MAIN);
        expect(main).toHaveLength(8);
        expect(sum(main, "input")).toBe(307_973 - 260_382);
        expect(sum(main, "cacheRead")).toBe(260_382);
        expect(sum(main, "output")).toBe(1_148);
        expect(sum(main, "credits")).toBeCloseTo(0.82134855, 9);

        expect(new Set(main.map((u) => u.id)).size).toBe(8);
        for (const u of main) expect(u.id).toMatch(new RegExp(`^${MAIN}:o:[0-9a-f]{32}:[0-9a-f]{16}$`));
        expect(main[0]).toMatchObject({
          provider: "copilot-chat",
          promptId: null,
          model: "gpt-6-luna",
          agent: "main",
          isSubagent: false,
          input: 26_283,
          cacheRead: 0,
          output: 81,
          cacheWrite: 0,
          reasoning: 0,
          billing: "github-copilot",
          credits: 0.299322,
          partial: false,
          costUsd: null,
        });
        expect(main[1]).toMatchObject({ input: 27_669 - 26_280, cacheRead: 26_280, output: 146 });
      });

      test("helper calls with no conversation land in one session for each local day", () => {
        const g = only(mapBatch(batch(), { ...CTX, local: LOCAL }).groups);
        const helpers = g.usage.filter((u) => u.sessionId !== MAIN);
        expect(helpers).toHaveLength(7);
        expect(new Set(helpers.map((u) => u.agent))).toEqual(new Set(["title", "progressMessages", "copilotLanguageModelWrapper"]));
        for (const u of helpers) {
          expect(u.sessionId).toBe(`copilot-chat:background:${day(u.ts)}`);
          expect(u.isSubagent).toBe(false);
          expect(u.model).toBe("gpt-4o-mini-2024-07-18");
        }
      });

      test("response metadata: times, time to first token and stop reason", () => {
        const g = only(mapBatch(batch(), { ...CTX, local: LOCAL }).groups);
        expect(g.meta).toHaveLength(15);

        const first = g.meta.find((m) => m.usageId === g.usage.find((u) => u.sessionId === MAIN)!.id)!;
        expect(first.stopReason).toBe("stop");
        expect(first.ttftMs).toBeGreaterThan(0);
        expect(first.startTs).toBeLessThan(first.endTs!);
      });

      test("tool calls keep their call id, one without gets its span, outcomes come from the status", () => {
        const g = only(mapBatch(batch(), { ...CTX, local: LOCAL }).groups);
        expect(g.tools).toHaveLength(8);
        expect(g.tools.every((t) => t.sessionId === MAIN && t.usageId === null && t.provider === "copilot-chat" && t.agent === "main" && t.filePath === null)).toBe(true);
        expect(g.tools.map((t) => t.tool).sort()).toEqual(["apply_patch", "manage_todo_list", "read_file", "read_file", "read_file", "read_file", "run_in_terminal", "read_file"].sort());

        const ids = g.tools.map((t) => t.id);
        expect(ids).toContain(`${MAIN}:t:call_KfkfSL1XR4KygK1dBPCjktYK`);
        expect(ids).toContain(`${MAIN}:t:call_CnlndBOudeUmDQJXBkBigpY3`);
        expect(ids.filter((id) => id.startsWith(`${MAIN}:t:s:`))).toHaveLength(1);
        expect(g.tools.find((t) => t.tool === "manage_todo_list")!.id).toMatch(new RegExp(`^${MAIN}:t:s:[0-9a-f]{32}:[0-9a-f]{16}$`));

        expect(g.outcomes).toHaveLength(8);
        expect(g.outcomes.every((o) => o.kind === "tool_ok")).toBe(true);
        expect(new Set(g.outcomes.map((o) => o.id))).toEqual(new Set(ids));
      });

      test("invoke_agent adds no usage, it tells when the conversation ran", () => {
        const g = only(mapBatch(batch(), { ...CTX, local: LOCAL }).groups);
        // 8 main calls and 7 helpers: the turn's totals on the invoke_agent span are not a row.
        expect(g.usage).toHaveLength(15);

        const s = sessions(g).find((x) => x.id === MAIN)!;
        expect(s).toMatchObject({ provider: "copilot-chat", nativeId: CHAT, clientVersion: "0.66.0" });
        expect(s.startedAt as number).toBeLessThanOrEqual(Math.min(...g.usage.filter((u) => u.sessionId === MAIN).map((u) => u.ts)));
        expect(s.endedAt as number).toBeGreaterThanOrEqual(Math.max(...g.usage.filter((u) => u.sessionId === MAIN).map((u) => u.ts)));
      });

      test("from a remote sender the rows are a remote machine's: namespaced by the credential", () => {
        const g = only(mapBatch(batch(), CTX).groups);
        expect(g.local).toBe(false);
        expect(g.host).toBe("ci-token");
        expect(g.usage).toHaveLength(15);
        expect(g.usage.every((u) => u.id.startsWith(`${NS}copilot-chat:`) && u.sessionId.startsWith(`${NS}copilot-chat:`))).toBe(true);
        expect(g.tools.every((t) => t.id.startsWith(`${NS}copilot-chat:`))).toBe(true);
        expect(g.usage.filter((u) => u.sessionId === `${NS}${MAIN}`)).toHaveLength(8);
        expect(g.usage.filter((u) => u.sessionId.startsWith(`${NS}copilot-chat:background:`))).toHaveLength(7);
      });

      test("no content is read: not with text kept either", () => {
        const mapped = mapBatch(batch(), { ...CTX, storeText: true, local: LOCAL });
        expect(JSON.stringify(mapped.groups.map((g) => [g.prompts, g.usage, g.tools, g.outcomes, g.meta, sessions(g)]))).not.toContain("SENTINEL_");
      });
    });
  }

  test("its logs make no record, from this machine or another", () => {
    const logsBatch = decodeOtlp("logs", fixture("logs.json"), "json");
    expect(logsBatch.logs.length).toBeGreaterThan(0);
    for (const local of [LOCAL, null]) expect(mapBatch(logsBatch, { ...CTX, local })).toEqual({ groups: [], skipped: 0, skippedFor: {} });
  });

  describe("one call", () => {
    const chat = (attrs: Record<string, AttrIn>, over: Partial<SpanIn> = {}): SpanIn => ({
      traceId: HERMES_TRACE,
      spanId: "00f067aa0ba902b7",
      name: "chat gpt-6-luna",
      startMs: T0,
      endMs: T0 + 2_000,
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "github",
        "gen_ai.request.model": "gpt-6-luna",
        "gen_ai.conversation.id": "conv-1",
        "gen_ai.usage.input_tokens": 1_000,
        "gen_ai.usage.output_tokens": 50,
        "gen_ai.usage.cache_read.input_tokens": 600,
        ...attrs,
      },
      ...over,
    });
    const resource = { "service.name": "copilot-chat", "host.name": "somewhere-else", "service.version": "0.66.0" };
    const call = (s: SpanIn, ctx: Partial<MapContext> = { local: LOCAL }) => traces([{ resource, scope: { name: "copilot-chat" }, records: [s] }], ctx);
    const one = (s: SpanIn, ctx?: Partial<MapContext>) => only(call(s, ctx).groups).usage[0]!;

    test("this machine's identity wins over the resource's, and it is never told apart as remote", () => {
      const g = only(call(chat({})).groups);
      expect(g).toMatchObject({ host: "devbox", user: "maciej", local: true });
      expect(g.usage[0]!.id).toBe(`copilot-chat:conv-1:o:${HERMES_TRACE}:00f067aa0ba902b7`);
      expect(g.usage[0]!.sessionId).toBe("copilot-chat:conv-1");
    });

    test("conversation and call ids with colons can't pose as other ids: they are hashed, as the chat session file's are", () => {
      const conversation = "A:f:B";
      const g = only(call(chat({ "gen_ai.conversation.id": conversation })).groups);
      const session = chatSessionId(conversation);
      expect(session).toMatch(/^copilot-chat:h[0-9a-f]{32}$/);
      expect(g.usage[0]).toMatchObject({ sessionId: session, id: `${session}:o:${HERMES_TRACE}:00f067aa0ba902b7` });
      expect(sessions(g)[0]).toMatchObject({ id: session, nativeId: conversation });

      const tool: SpanIn = {
        traceId: HERMES_TRACE,
        spanId: "00f067aa0ba902b8",
        name: "execute_tool read_file",
        startMs: T0,
        endMs: T0 + 10,
        attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.call.id": "call:1:o", "gen_ai.conversation.id": conversation },
      };
      expect(only(call(tool).groups).tools[0]!.id).toBe(`${session}:t:${safePart("call:1:o")}`);
    });

    test("tokens: the cache reads come out of the input (never below 0), the reasoning from either attribute", () => {
      expect(one(chat({}))).toMatchObject({ input: 400, cacheRead: 600, output: 50, reasoning: 0, model: "gpt-6-luna" });
      expect(one(chat({ "gen_ai.usage.cache_read.input_tokens": 1_500 }))).toMatchObject({ input: 0, cacheRead: 1_500 });
      expect(one(chat({ "gen_ai.usage.reasoning.output_tokens": 30 })).reasoning).toBe(30);
      expect(one(chat({ "gen_ai.usage.reasoning_tokens": 20 })).reasoning).toBe(20);
      expect(one(chat({ "gen_ai.response.model": "gpt-6-luna-2026" })).model).toBe("gpt-6-luna-2026");
    });

    test("credits are the nano AI units over 1e9, and none when they are out of bounds", () => {
      expect(one(chat({ "copilot_chat.copilot_usage_nano_aiu": 2_500_000_000 })).credits).toBe(2.5);
      expect(one(chat({})).credits).toBe(0);
      expect(one(chat({ "copilot_chat.copilot_usage_nano_aiu": -5 })).credits).toBe(0);
      expect(one(chat({ "copilot_chat.copilot_usage_nano_aiu": 1e20 })).credits).toBe(0);
    });

    test("billing and agent: GitHub's own models bill through the plan, bring-your-own ones through their vendor", () => {
      expect(one(chat({})).billing).toBe("github-copilot");
      expect(one(chat({ "gen_ai.provider.name": "anthropic" })).billing).toBe("anthropic");
      expect(one(chat({ "gen_ai.agent.name": "panel/editAgent" })).agent).toBe("main");
      expect(one(chat({ "gen_ai.agent.name": "title" })).agent).toBe("title");
    });

    test("without a conversation the call goes to the background session of its local day", () => {
      const u = one(chat({ "gen_ai.conversation.id": "" }));
      expect(u.sessionId).toBe(`copilot-chat:background:${day(T0 + 2_000)}`);
      expect(u.id).toBe(`copilot-chat:background:${day(T0 + 2_000)}:o:${HERMES_TRACE}:00f067aa0ba902b7`);
    });

    test("stop reason from a list or a plain value, time to first token only when sane", () => {
      const meta = (attrs: Record<string, AttrIn>) => only(call(chat(attrs)).groups).meta[0]!;
      expect(meta({ "gen_ai.response.finish_reasons": ["length", "stop"], "copilot_chat.time_to_first_token": 380 })).toMatchObject({ stopReason: "length", ttftMs: 380, startTs: T0, endTs: T0 + 2_000 });
      expect(meta({ "gen_ai.response.finish_reasons": "stop" }).stopReason).toBe("stop");
      expect(meta({ "copilot_chat.time_to_first_token": -1 }).ttftMs).toBeNull();
    });

    test("a span of copilot-chat's scope counts whatever its service is called", () => {
      const g = only(traces([{ resource: { "service.name": "something" }, scope: { name: "copilot-chat" }, records: [chat({})] }], { local: LOCAL }).groups);
      expect(g.usage[0]!.provider).toBe("copilot-chat");
    });

    test("a call without tokens, or with no time, is no usage row", () => {
      expect(only(call(chat({ "gen_ai.usage.input_tokens": 0, "gen_ai.usage.output_tokens": 0, "gen_ai.usage.cache_read.input_tokens": 0 })).groups).usage).toEqual([]);
      expect(call(chat({}, { startMs: 1_000, endMs: 2_000 })).skippedFor).toEqual({ time: 1 });
    });

    test("tool outcome from the status code: 2 error, 1 ok, 0 none", () => {
      const tool = (code: number, call_id = "call_x"): SpanIn => ({
        traceId: HERMES_TRACE,
        spanId: "00f067aa0ba902b8",
        name: "execute_tool read_file",
        startMs: T0,
        endMs: T0 + 10,
        attrs: { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read_file", "gen_ai.tool.call.id": call_id, "gen_ai.conversation.id": "conv-1" },
        status: { code },
      });
      const outcomes = (code: number) => only(call(tool(code)).groups).outcomes.map((o) => o.kind);
      expect(outcomes(2)).toEqual(["tool_error"]);
      expect(outcomes(1)).toEqual(["tool_ok"]);
      expect(outcomes(0)).toEqual([]);
      expect(only(call(tool(1, "")).groups).tools[0]!.id).toBe(`copilot-chat:conv-1:t:s:${HERMES_TRACE}:00f067aa0ba902b8`);
    });

    test("content attributes, span events and the status message are never read", () => {
      const secret = chat({ "copilot_chat.reasoning_content": "SENTINEL_A", "gen_ai.input.messages": "SENTINEL_B", "copilot_chat.user_request": "SENTINEL_C" }, { status: { code: 2, message: "SENTINEL_D" } });
      const mapped = mapBatch(decodeOtlp("traces", encodeTraces([{ resource, scope: { name: "copilot-chat" }, records: [secret] }]), "protobuf"), { ...CTX, storeText: true, local: LOCAL });
      expect(JSON.stringify(mapped.groups.map((g) => [g.prompts, g.usage, g.tools, g.meta, sessions(g)]))).not.toContain("SENTINEL_");
    });
  });
});
