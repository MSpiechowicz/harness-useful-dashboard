import { describe, expect, test } from "bun:test";
import { cleanName, identityOf, MAX_COST, MAX_HOSTS, MAX_TOKENS, type MapContext, type MappedGroup, mapBatch } from "../src/core/otlp/map.ts";
import type { OtlpSpan } from "../src/core/otlp/model.ts";
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
