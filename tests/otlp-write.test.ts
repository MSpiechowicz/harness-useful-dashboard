import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestCopilotChatFile } from "../src/core/ingest/copilotChat.ts";
import { fileUsageId, filePromptId } from "../src/core/ingest/copilotChatIds.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter, recomputeCosts } from "../src/core/ingest/writer.ts";
import { MAX_HOSTS, MAX_TOKENS } from "../src/core/otlp/map.ts";
import type { Attrs, OtlpBatch } from "../src/core/otlp/model.ts";
import { decodeOtlp, OtlpDecodeError, REPLACE_SLACK_MS, remoteHosts, writeOtlp } from "../src/core/otlp/write.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";
import {
  type AttrIn,
  CLAUDE_SESSION,
  claudeLogs,
  dbl,
  encodeLogs,
  encodeTraces,
  HERMES_CHILD,
  HERMES_SESSION,
  HERMES_TRACE,
  hermesChildSpans,
  hermesSpans,
  logsJson,
  type ResourceIn,
  type SpanIn,
  T0,
} from "./otlpEncode.ts";

const TOKEN = { kind: "token" as const, label: "ci-token", key: "tci" };
/** What every id of TOKEN is namespaced with. */
const NS = "otlp:tci:";
const OPTS = { storeText: false, promptTextLimit: 2000, detailBefore: 0, localHost: "devbox" };
const prices = new PriceBook();

const writeTraces = (db: Database, r: ResourceIn<SpanIn>[], opts: Partial<typeof OPTS> = {}) =>
  writeOtlp(db, prices, decodeOtlp("traces", encodeTraces(r), "protobuf"), TOKEN, { ...OPTS, ...opts });
const writeLogs = (db: Database, r: ReturnType<typeof claudeLogs>, opts: Partial<typeof OPTS> = {}) =>
  writeOtlp(db, prices, decodeOtlp("logs", logsJson(r), "json"), TOKEN, { ...OPTS, ...opts });

const TABLES = ["sessions", "prompts", "usage", "tool_calls", "outcomes", "response_meta"];
const counts = (db: Database) => Object.fromEntries(TABLES.map((t) => [t, db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n]));
/** Every stored row, as text: what the database would give away. */
const dump = (db: Database) => JSON.stringify(TABLES.map((t) => db.query(`SELECT * FROM ${t}`).all()));

describe("writeOtlp", () => {
  test("writes Hermes calls, tool calls and sessions, stamped with the remote host", () => {
    const db = memDb();
    const r = writeTraces(db, hermesSpans({ host: "build-box" }));
    expect(r).toEqual({ usage: 2, tools: 1, prompts: 0, sessions: 2, skipped: 0, skippedFor: {}, hosts: ["build-box"] });

    const rows = db.query<Record<string, unknown>, []>("SELECT id, provider, host, user, model, input_tokens, cache_read_tokens, cost_usd, cost_estimated FROM usage ORDER BY ts").all();
    expect(rows[0]).toEqual({
      id: `${NS}hermes:${HERMES_TRACE}:1000000000000003`,
      provider: "hermes",
      host: "build-box",
      user: "ci-token",
      model: "anthropic/claude-sonnet-4.5",
      input_tokens: 1_000,
      cache_read_tokens: 9_000,
      cost_usd: 0.0123,
      cost_estimated: 0,
    });
    expect(db.query("SELECT host, user FROM sessions GROUP BY host, user").all()).toEqual([{ host: "build-box", user: "ci-token" }]);
    expect(db.query("SELECT tool, user FROM tool_calls").all()).toEqual([{ tool: "read_file", user: "ci-token" }]);
    expect(db.query("SELECT kind, host FROM outcomes").all()).toEqual([{ kind: "tool_ok", host: "build-box" }]);
    expect(db.query("SELECT start_ts, end_ts FROM response_meta WHERE usage_id = ?").get(rows[0]!.id as string)).toEqual({ start_ts: T0 + 1_000, end_ts: T0 + 6_000 });

    // Hermes's own cost survives a re-pricing.
    recomputeCosts(db, prices);
    expect(db.query<{ cost_usd: number }, [string]>("SELECT cost_usd FROM usage WHERE id = ?").get(rows[0]!.id as string)!.cost_usd).toBe(0.0123);
  });

  test("a replayed export changes nothing", () => {
    const db = memDb();
    const first = writeTraces(db, hermesSpans({ host: "build-box" }));
    const second = writeLogs(db, claudeLogs({ host: "laptop-2" }));
    const before = counts(db);
    const totals = db.query("SELECT SUM(total_tokens) AS t, SUM(cost_usd) AS c FROM usage").get();

    expect(writeTraces(db, hermesSpans({ host: "build-box" }))).toEqual(first);
    expect(writeLogs(db, claudeLogs({ host: "laptop-2" }))).toEqual(second);
    expect(counts(db)).toEqual(before);
    expect(db.query("SELECT SUM(total_tokens) AS t, SUM(cost_usd) AS c FROM usage").get()).toEqual(totals);
  });

  test("Claude Code calls are priced by the book, not by the cost they report", () => {
    const db = memDb();
    expect(writeLogs(db, claudeLogs({ host: "laptop-2" }))).toEqual({ usage: 1, tools: 2, prompts: 1, sessions: 1, skipped: 0, skippedFor: {}, hosts: ["laptop-2"] });

    const u = db.query<{ cost_usd: number; project: string; session_id: string }, []>("SELECT cost_usd, project, session_id FROM usage").get()!;
    const book = prices.cost("claude-opus-5-5", { input: 12, output: 450, cacheRead: 30_000, cacheWrite: 1_500, cacheWrite1h: 0 }, "normal").usd;
    expect(u.cost_usd).toBeCloseTo(book, 10);
    expect(u.cost_usd).not.toBe(9.99);
    expect(u).toMatchObject({ project: "payments-api", session_id: `${NS}claude:${CLAUDE_SESSION}` });
    expect(db.query("SELECT id, kind FROM outcomes ORDER BY id").all()).toEqual([
      { id: `${NS}claude:toolu_01ABC`, kind: "tool_ok" },
      { id: `${NS}claude:toolu_01DEF`, kind: "tool_error" },
    ]);
  });

  test("Claude Code logs from this machine are dropped", () => {
    const db = memDb();
    expect(writeLogs(db, claudeLogs({ host: "DEVBOX" }))).toEqual({ usage: 0, tools: 0, prompts: 0, sessions: 0, skipped: 4, skippedFor: { other: 4 }, hosts: [] });
    expect(counts(db).usage).toBe(0);
    expect(remoteHosts(db)).toEqual([]);
  });

  test("other agents on a host named like this machine are kept apart from it", () => {
    const db = memDb();
    expect(writeTraces(db, hermesSpans({ host: "DevBox" })).hosts).toEqual(["DevBox (remote)"]);
    expect(db.query("SELECT DISTINCT host FROM usage").all()).toEqual([{ host: "DevBox (remote)" }]);
  });

  test("a subagent's calls take its agent, whichever request names it first", () => {
    const childUsage = (db: Database) => db.query("SELECT agent, is_subagent FROM usage WHERE session_id = ?").get(`${NS}hermes:${HERMES_CHILD}`);

    const callsFirst = memDb();
    writeTraces(callsFirst, hermesChildSpans());
    expect(childUsage(callsFirst)).toEqual({ agent: "main", is_subagent: 0 });
    writeTraces(callsFirst, hermesSpans());
    expect(childUsage(callsFirst)).toEqual({ agent: "researcher", is_subagent: 1 });

    const spanFirst = memDb();
    writeTraces(spanFirst, hermesSpans());
    writeTraces(spanFirst, hermesChildSpans());
    expect(childUsage(spanFirst)).toEqual({ agent: "researcher", is_subagent: 1 });
    expect(spanFirst.query("SELECT parent_session_id FROM sessions WHERE id = ?").get(`${NS}hermes:${HERMES_CHILD}`)).toEqual({
      parent_session_id: `${NS}hermes:${HERMES_SESSION}`,
    });
    // The parent's own calls stay the main agent's.
    expect(spanFirst.query("SELECT DISTINCT agent, is_subagent FROM usage WHERE session_id = ?").all(`${NS}hermes:${HERMES_SESSION}`)).toEqual([{ agent: "main", is_subagent: 0 }]);
  });

  test("no text is stored unless the user keeps it, and message content never is", () => {
    const off = memDb();
    writeTraces(off, hermesSpans());
    writeLogs(off, claudeLogs({ host: "laptop-2" }));
    const stored = dump(off);
    for (const secret of ["add retries", "find every caller", "/srv/app/parser.py", "refactor the parser", "You are Hermes", "webhook.ts", "def parse"]) {
      expect(stored).not.toContain(secret);
    }

    const on = memDb();
    writeTraces(on, hermesSpans(), { storeText: true });
    writeLogs(on, claudeLogs({ host: "laptop-2" }), { storeText: true });
    expect(on.query("SELECT text FROM prompts").get()).toEqual({ text: "add retries to the stripe webhook handler" });
    expect(on.query("SELECT brief FROM sessions WHERE id = ?").get(`${NS}hermes:${HERMES_CHILD}`)).toEqual({ brief: "find every caller of parse()" });
    expect(on.query("SELECT file_path FROM tool_calls WHERE provider = 'hermes'").get()).toEqual({ file_path: "/srv/app/parser.py" });
    const kept = dump(on);
    for (const content of ["refactor the parser", "You are Hermes", "webhook.ts", "def parse"]) expect(kept).not.toContain(content);
  });

  test("a long prompt that almost holds a JWT is stored, redacted, as fast as any other", () => {
    const db = memDb();
    const [r] = claudeLogs({ host: "laptop-2" });
    const prompt = "eyJ-".repeat(25_000);
    const records = r!.records.map((l) => (l.attrs?.prompt ? { ...l, attrs: { ...l.attrs, prompt } } : l));

    const started = performance.now();
    writeLogs(db, [{ ...r!, records }], { storeText: true, promptTextLimit: 100_000 });
    expect(performance.now() - started).toBeLessThan(200);
    expect(db.query<{ n: number }, []>("SELECT length(text) AS n FROM prompts").get()).toEqual({ n: 100_000 });
  });

  test("a remote project is stored as named, never resolved on this machine", () => {
    const db = memDb();
    const [r] = hermesSpans({ host: "build-box" });
    writeTraces(db, [{ ...r!, resource: { ...r!.resource, "harness.project": "/tmp/remote-repo" } }]);
    expect(db.query("SELECT DISTINCT project FROM usage").all()).toEqual([{ project: "/tmp/remote-repo" }]);
  });

  test("remoteHosts lists each host OTLP data came from once, never a host that writes rows of its own", () => {
    const db = memDb();
    writeTraces(db, hermesSpans({ host: "build-box" }));
    writeLogs(db, claudeLogs({ host: "laptop-2" }));
    writeTraces(db, hermesSpans({ host: "build-box" }));
    new DbWriter(db, prices, ID).session({ id: "codex:s1", provider: "codex", nativeId: "s1", project: null });
    expect(remoteHosts(db)).toEqual(["build-box", "laptop-2"]);

    // A request without host.name is stamped with its credential's label.
    writeOtlp(db, prices, decodeOtlp("logs", encodeLogs(claudeLogs()), "protobuf"), { kind: "basic", label: "ana@laptop", key: "b:ana@laptop" }, OPTS);
    expect(remoteHosts(db)).toEqual(["ana@laptop", "build-box", "laptop-2"]);
  });

  test("a request naming many hosts writes the first 50 and can't push a known host out", () => {
    const db = memDb();
    writeTraces(db, hermesSpans({ host: "build-box" }));

    const [r] = claudeLogs();
    const flood = Array.from({ length: 60 }, (_, i) => ({
      ...r!,
      resource: { ...r!.resource, "host.name": `flood-${i}` },
      records: r!.records.map((l) => ({ ...l, attrs: { ...l.attrs, "session.id": `s${i}`, request_id: `req-${i}`, tool_use_id: `${l.attrs?.tool_use_id}-${i}` } })),
    }));
    const result = writeLogs(db, flood);
    expect(result.hosts).toHaveLength(50);
    expect(result.skipped).toBe(10 * r!.records.length);
    expect(remoteHosts(db)).toHaveLength(51);
    expect(remoteHosts(db)).toContain("build-box");
  });

  test("two senders with the same ids never overwrite each other's rows", () => {
    const db = memDb();
    const other = { kind: "token" as const, label: "other", key: "tother" };
    writeLogs(db, claudeLogs({ host: "laptop-2" }));
    const [r] = claudeLogs({ host: "attacker-box" });
    const inflated = { ...r!, records: r!.records.map((l) => ({ ...l, attrs: { ...l.attrs, input_tokens: "999999999" } })) };
    writeOtlp(db, prices, decodeOtlp("logs", logsJson([inflated]), "json"), other, OPTS);

    expect(db.query("SELECT host, user, input_tokens FROM usage WHERE id = ?").get(`${NS}claude:req_011CXabc`)).toEqual({ host: "laptop-2", user: "ci-token", input_tokens: 12 });
    expect(db.query("SELECT host, input_tokens FROM usage WHERE id = ?").get("otlp:tother:claude:req_011CXabc")).toEqual({ host: "attacker-box", input_tokens: 999_999_999 });
    expect(db.query("SELECT COUNT(*) AS n FROM sessions WHERE native_id = ?").get(CLAUDE_SESSION)).toEqual({ n: 2 });
  });

  test("calls with counts past any real one are stored capped, and every total over them still adds up", () => {
    const db = memDb();
    const [r] = claudeLogs({ host: "remote1" });
    const api = r!.records[1]!;
    const records = Array.from({ length: 1100 }, (_, i) => ({ ...api, attrs: { ...api.attrs, request_id: `r${i}`, input_tokens: "9007199254740991", output_tokens: "1e308" } }));
    expect(writeLogs(db, [{ ...r!, records }]).usage).toBe(1100);

    const q = new Queries(db, () => prices);
    expect(q.summary({}).messages).toBe(1100);
    expect(q.breakdown({}, "host").rows[0]).toMatchObject({ key: "remote1" });
    expect(q.timeseries({}, "day", "none", "tokens").buckets.length).toBeGreaterThan(0);
    expect(q.timeseries({}, "day", "type", "tokens").buckets.length).toBeGreaterThan(0);
    expect(db.query("SELECT MAX(input_tokens) AS i, MAX(output_tokens) AS o, typeof(SUM(total_tokens)) AS t FROM usage").get()).toEqual({ i: MAX_TOKENS, o: MAX_TOKENS, t: "integer" });
  });

  test("a reported cost below zero or past any real one is not taken: the price book prices the call", () => {
    const db = memDb();
    const [r] = hermesSpans({ host: "build-box" });
    const costly = (cost: number) => [{ ...r!, records: r!.records.map((s) => (s.spanId === "1000000000000003" ? { ...s, attrs: { ...s.attrs, "hermes.cost.usage": dbl(cost) } } : s)) }];
    const callCost = () => db.query<{ cost_usd: number; cost_estimated: number }, [string]>("SELECT cost_usd, cost_estimated FROM usage WHERE id = ?").get(`${NS}hermes:${HERMES_TRACE}:1000000000000003`)!;

    writeTraces(db, costly(0.5));
    expect(callCost().cost_usd).toBe(0.5);
    for (const cost of [-1000, 1e308]) {
      writeTraces(db, costly(cost));
      expect(callCost().cost_usd, String(cost)).toBeGreaterThanOrEqual(0);
      expect(callCost().cost_usd, String(cost)).toBeLessThan(1);
    }
  });

  test("a credential's 201st host is skipped, its known hosts and other credentials' new ones are not", () => {
    const db = memDb();
    const [r] = claudeLogs();
    const fromHosts = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => {
        const i = from + k;
        return {
          ...r!,
          resource: { ...r!.resource, "host.name": `box-${i}` },
          records: r!.records.map((l) => ({ ...l, attrs: { ...l.attrs, "session.id": `s${i}`, request_id: `req-${i}`, tool_use_id: `${l.attrs?.tool_use_id}-${i}` } })),
        };
      });
    for (let from = 0; from < MAX_HOSTS; from += 50) expect(writeLogs(db, fromHosts(from, 50)).hosts).toHaveLength(50);

    const past = writeLogs(db, fromHosts(MAX_HOSTS, 1));
    expect(past).toMatchObject({ usage: 0, hosts: [], skipped: r!.records.length, skippedFor: { hosts: r!.records.length } });
    expect(writeLogs(db, fromHosts(7, 1)).hosts).toEqual(["box-7"]);

    const other = { kind: "token" as const, label: "other", key: "tother" };
    expect(writeOtlp(db, prices, decodeOtlp("logs", logsJson(fromHosts(MAX_HOSTS, 1)), "json"), other, OPTS).hosts).toEqual([`box-${MAX_HOSTS}`]);
    expect(remoteHosts(db)).toHaveLength(MAX_HOSTS + 1);
  });

  test("new hosts reusing one session's id count toward the 200, also once the hosts are read again", () => {
    const db = memDb();
    const [r] = claudeLogs();
    const fromHosts = (from: number, n: number) =>
      Array.from({ length: n }, (_, k) => {
        const i = from + k;
        return {
          ...r!,
          resource: { ...r!.resource, "host.name": `box-${i}` },
          records: r!.records.map((l) => ({ ...l, attrs: { ...l.attrs, request_id: `req-${i}`, tool_use_id: `${l.attrs?.tool_use_id}-${i}` } })),
        };
      });
    // Every request names the same session, which keeps the host it was first stored with.
    let now = Date.now();
    const write = (from: number, n: number) => writeOtlp(db, prices, decodeOtlp("logs", logsJson(fromHosts(from, n)), "json"), TOKEN, { ...OPTS, now });

    write(0, 1);
    for (let from = 1; from < MAX_HOSTS + 100; from += 50) {
      now += 61_000;
      write(from, 50);
    }

    const hosts = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM (SELECT host FROM usage UNION SELECT host FROM outcomes UNION SELECT host FROM sessions)`).get()!.n;
    expect(hosts).toBe(MAX_HOSTS);
    expect(db.query("SELECT DISTINCT host FROM sessions").all()).toEqual([{ host: "box-0" }]);
    now += 61_000;
    expect(write(MAX_HOSTS + 100, 1)).toMatchObject({ usage: 0, hosts: [], skippedFor: { hosts: r!.records.length } });
  });

  test("a remote host named like one with rows of its own is told apart from it", () => {
    const db = memDb();
    new DbWriter(db, prices, { user: "bob", host: "their-box" }).session({ id: "claude:theirs", provider: "claude", nativeId: "theirs", project: null });
    db.query("INSERT INTO meta (key, value) VALUES ('last_scan:scanner.lan', '1')").run();

    expect(writeLogs(db, claudeLogs({ host: "THEIR-BOX" })).hosts).toEqual(["THEIR-BOX (remote)"]);
    expect(writeLogs(db, claudeLogs({ host: "scanner" })).hosts).toEqual(["scanner (remote)"]);
    expect(writeLogs(db, claudeLogs({ host: "laptop-2" })).hosts).toEqual(["laptop-2"]);
  });
});

describe("host filter", () => {
  test("narrows usage, tool calls and the filter values to one host", () => {
    const db = memDb();
    new DbWriter(db, prices, ID).usage({
      id: "local-1", provider: "codex", sessionId: "codex:s1", promptId: null, ts: T0, project: null, model: "gpt-5", skill: null, agent: "main",
      isSubagent: false, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    });
    writeTraces(db, hermesSpans({ host: "build-box" }));
    writeLogs(db, claudeLogs({ host: "laptop-2" }));
    const q = new Queries(db, () => prices);

    expect(q.summary({}).messages).toBe(4);
    expect(q.summary({ host: "build-box" }).messages).toBe(2);
    expect(q.summary({ host: "laptop-2" }).messages).toBe(1);
    expect(q.summary({ host: ID.host }).messages).toBe(1);
    expect(q.breakdown({ host: "build-box" }, "provider").rows.map((r) => r.key)).toEqual(["hermes"]);
    expect(q.tools({ host: "laptop-2" }).totals.calls).toBe(2);
    expect(q.tools({ host: "build-box" }).totals.calls).toBe(1);
    expect(q.filters().host.map((h) => h.value).sort()).toEqual(["build-box", "laptop-2", ID.host].sort());
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

describe("writeOtlp: Copilot Chat", () => {
  const LOCAL = { host: "devbox", user: "maciej" };
  const CHAT = "a3dd1178-eb84-45ab-8531-9af4c983e955";
  const MAIN = `copilot-chat:${CHAT}`;

  const asJson = () => decodeOtlp("traces", fixture("traces-8-rounds.json"), "json");
  const asProtobuf = () => decodeOtlp("traces", encodeTraces(resourcesOf(asJson())), "protobuf");
  const write = (db: Database, batch: OtlpBatch, opts: Partial<typeof OPTS> & { local?: typeof LOCAL | null } = { local: LOCAL }) => writeOtlp(db, prices, batch, TOKEN, { ...OPTS, ...opts });
  const rows = <T>(db: Database, sql: string) => db.query<T, []>(sql).all();
  const mainTotals = (db: Database) =>
    db
      .query<{ n: number; input: number; cache: number; output: number; credits: number }, [string]>(
        "SELECT COUNT(*) AS n, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache, SUM(output_tokens) AS output, SUM(credits) AS credits FROM usage WHERE session_id = ? AND partial = 0",
      )
      .get(MAIN)!;

  /** The main agent's chat spans, oldest first. */
  const rounds = (batch: OtlpBatch) => batch.spans.filter((s) => s.name.startsWith("chat ") && s.attrs["gen_ai.agent.name"] === "panel/editAgent").sort((a, b) => a.endMs! - b.endMs!);

  /** The request of the fixture as its chat session file dates it: it started at REQUEST and took totalElapsed. */
  const REQUEST = 1_792_745_056_581;
  const ELAPSED = 31_830;

  /** A request as the chat session file keeps it: one partial row with the interval of the request, the input of its last call only. */
  function fileRequest(db: Database, requestId: string, start: number, end: number | null, input = 47_570): string {
    const w = new DbWriter(db, prices, { user: LOCAL.user, host: LOCAL.host });
    w.session({ id: MAIN, provider: "copilot-chat", nativeId: CHAT, project: null });
    w.prompt({ id: filePromptId(CHAT, requestId), sessionId: MAIN, provider: "copilot-chat", ts: start, text: null, skill: null, isCommand: false });

    const u: UsageRecord = {
      id: fileUsageId(CHAT, requestId),
      provider: "copilot-chat",
      sessionId: MAIN,
      promptId: filePromptId(CHAT, requestId),
      ts: start,
      project: null,
      model: "gpt-6-luna",
      skill: null,
      agent: "main",
      isSubagent: false,
      input,
      output: 1_148,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      billing: "github-copilot",
      partial: true,
    };
    w.usage(u);
    w.responseMeta({ usageId: u.id, startTs: start, endTs: end });
    return u.id;
  }

  const partialIds = (db: Database) => rows<{ id: string }>(db, "SELECT id FROM usage WHERE partial = 1 ORDER BY ts").map((r) => r.id);

  for (const [format, batch] of [["OTLP/JSON", asJson], ["protobuf", asProtobuf]] as const) {
    test(`${format}: this machine's calls are written under its own host and user, with ids a chat session file shares`, () => {
      const db = memDb();
      const r = write(db, batch());
      expect(r).toMatchObject({ usage: 15, tools: 8, skipped: 0, hosts: ["devbox"] });

      const t = mainTotals(db);
      expect(t).toMatchObject({ n: 8, input: 307_973 - 260_382, cache: 260_382, output: 1_148 });
      expect(t.credits).toBeCloseTo(0.82134855, 9);

      expect(rows(db, "SELECT DISTINCT host, user, provider, billing FROM usage")).toEqual([{ host: "devbox", user: "maciej", provider: "copilot-chat", billing: "github-copilot" }]);
      expect(rows(db, "SELECT DISTINCT host, user FROM sessions")).toEqual([{ host: "devbox", user: "maciej" }]);
      expect(rows<{ id: string }>(db, "SELECT id FROM usage").every((u) => u.id.startsWith("copilot-chat:"))).toBe(true);
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'copilot-chat:background:%'")).toEqual([{ n: 1 }]);
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM usage WHERE host LIKE '%(remote)%'")).toEqual([{ n: 0 }]);
      expect(remoteHosts(db)).toEqual([]);

      expect(rows(db, "SELECT kind, COUNT(*) AS n FROM outcomes GROUP BY kind")).toEqual([{ kind: "tool_ok", n: 8 }]);
      expect(rows(db, "SELECT tool, COUNT(*) AS n FROM tool_calls GROUP BY tool ORDER BY tool")).toEqual([
        { tool: "apply_patch", n: 1 },
        { tool: "manage_todo_list", n: 1 },
        { tool: "read_file", n: 5 },
        { tool: "run_in_terminal", n: 1 },
      ]);
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM response_meta")).toEqual([{ n: 15 }]);
    });
  }

  test("a replay changes nothing", () => {
    const db = memDb();
    write(db, asJson());
    const before = dump(db);
    write(db, asProtobuf());
    expect(dump(db)).toBe(before);
  });

  test("from a remote sender the rows are namespaced and keep the sender's identity", () => {
    const db = memDb();
    expect(write(db, asJson(), { local: null }).hosts).toEqual(["ci-token"]);
    expect(rows<{ id: string }>(db, "SELECT id FROM usage").every((u) => u.id.startsWith(`${NS}copilot-chat:`))).toBe(true);
    expect(rows(db, "SELECT DISTINCT host FROM usage")).toEqual([{ host: "ci-token" }]);
    expect(mainTotals(db)).toMatchObject({ n: 0 });
    expect(remoteHosts(db)).toEqual(["ci-token"]);
  });

  test("its logs write nothing", () => {
    const db = memDb();
    const r = writeOtlp(db, prices, decodeOtlp("logs", fixture("logs.json"), "json"), TOKEN, { ...OPTS, local: LOCAL });
    expect(r).toEqual({ usage: 0, tools: 0, prompts: 0, sessions: 0, skipped: 0, skippedFor: {}, hosts: [] });
    expect(Object.values(counts(db)).every((n) => n === 0)).toBe(true);
  });

  test("no content is stored, with text kept or not, from this machine or another", () => {
    for (const storeText of [false, true]) {
      for (const local of [LOCAL, null]) {
        const db = memDb();
        write(db, asJson(), { storeText, local });
        expect(dump(db)).not.toContain("SENTINEL_");
      }
    }
  });

  describe("a request replaces the partial row of the chat session file", () => {
    const FIXTURE_FILE = join(import.meta.dir, "fixtures", "copilot-chat", "User", "workspaceStorage", "aaaa1111", "chatSessions", `${CHAT}.jsonl`);
    const readFile = (db: Database) => ingestCopilotChatFile({ path: FIXTURE_FILE, project: "/home/dev/projects/demo" }, new DbWriter(db, prices, { user: LOCAL.user, host: LOCAL.host }), { promptTextLimit: 2000 });

    test("the fixture's calls fall in its request's interval, the last one ends just past it", () => {
      const calls = rounds(asJson());
      expect(calls[0]!.startMs!).toBeGreaterThanOrEqual(REQUEST);
      expect(calls.at(-1)!.endMs!).toBeGreaterThan(REQUEST + ELAPSED);
      expect(calls.at(-1)!.endMs!).toBeLessThanOrEqual(REQUEST + ELAPSED + REPLACE_SLACK_MS);
    });

    test("file first: the row of the request goes, with its response metadata and the links to it", () => {
      const db = memDb();
      const b = asJson();

      // An older request that finished before and one after stay, whatever their rows say.
      const older = fileRequest(db, "r0", REQUEST - 300_000, REQUEST - 290_000, 20_000);
      const justBefore = fileRequest(db, "r0b", REQUEST - 20_000, REQUEST - 10, 21_000);
      const request = fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);
      const later = fileRequest(db, "r2", REQUEST + ELAPSED + 60_000, REQUEST + ELAPSED + 90_000, 9_000);
      new DbWriter(db, prices, { user: LOCAL.user, host: LOCAL.host }).tool({
        id: `${MAIN}:t:call_KfkfSL1XR4KygK1dBPCjktYK`, usageId: request, sessionId: MAIN, promptId: null, provider: "copilot-chat", ts: REQUEST + 4_000, project: null, tool: "read_file", filePath: null, skill: null, agent: "main",
      });
      expect(partialIds(db)).toEqual([older, justBefore, request, later]);

      write(db, b);

      expect(partialIds(db)).toEqual([older, justBefore, later]);
      // Its interval stays, without a usage row: later calls of the request find the request by it.
      expect(rows(db, `SELECT usage_id FROM response_meta WHERE usage_id = '${request}'`)).toEqual([{ usage_id: request }]);
      expect(rows<{ usage_id: string }>(db, "SELECT usage_id FROM response_meta").map((m) => m.usage_id)).toContain(older);
      expect(rows(db, "SELECT COUNT(*) AS n FROM tool_calls WHERE usage_id IS NOT NULL AND usage_id NOT IN (SELECT id FROM usage)")).toEqual([{ n: 0 }]);

      // The totals of the complete rows are the telemetry's.
      expect(mainTotals(db)).toMatchObject({ n: 8, input: 47_591, cache: 260_382, output: 1_148 });
    });

    test("file first, read by the reader: the fixture's session file and its telemetry give the telemetry's totals", () => {
      const db = memDb();
      readFile(db);
      expect(partialIds(db)).toEqual([fileUsageId(CHAT, "request_11111111-1111-4111-8111-111111111111")]);

      write(db, asJson());
      expect(partialIds(db)).toEqual([]);
      expect(mainTotals(db)).toMatchObject({ n: 8, input: 47_591, cache: 260_382, output: 1_148 });
      expect(rows(db, "SELECT COUNT(*) AS n FROM usage WHERE id LIKE '%:f:%'")).toEqual([{ n: 0 }]);
    });

    test("telemetry first: the reader skips the request it covers, and its tool calls, and the rows share the session's project", () => {
      const db = memDb();
      write(db, asJson());
      expect(rows<{ project: string | null }>(db, "SELECT DISTINCT project FROM usage")).toEqual([{ project: null }]);

      readFile(db);
      expect(partialIds(db)).toEqual([]);
      expect(rows(db, "SELECT COUNT(*) AS n FROM usage")).toEqual([{ n: 15 }]);
      // The reader's tool calls share their ids with the telemetry's: still 8.
      expect(rows(db, "SELECT COUNT(*) AS n FROM tool_calls")).toEqual([{ n: 8 }]);

      // The main session's rows took the project of the window, the background session's have none.
      expect(rows(db, "SELECT session_id LIKE 'copilot-chat:background:%' AS background, project, COUNT(*) AS n FROM usage GROUP BY background, project ORDER BY background")).toEqual([
        { background: 0, project: "/home/dev/projects/demo", n: 8 },
        { background: 1, project: null, n: 7 },
      ]);
      expect(rows(db, "SELECT DISTINCT project FROM tool_calls")).toEqual([{ project: "/home/dev/projects/demo" }]);
      expect(rows(db, "SELECT DISTINCT project FROM outcomes")).toEqual([{ project: "/home/dev/projects/demo" }]);
    });

    test("file first: telemetry written after takes the project its session already has", () => {
      const db = memDb();
      readFile(db);
      write(db, asJson());

      expect(rows(db, "SELECT session_id LIKE 'copilot-chat:background:%' AS background, project, COUNT(*) AS n FROM usage GROUP BY background, project ORDER BY background")).toEqual([
        { background: 0, project: "/home/dev/projects/demo", n: 8 },
        { background: 1, project: null, n: 7 },
      ]);
      expect(rows(db, "SELECT DISTINCT project FROM tool_calls")).toEqual([{ project: "/home/dev/projects/demo" }]);
    });

    const promptsOfMain = (db: Database) =>
      rows<{ prompt_id: string | null; n: number }>(db, `SELECT prompt_id, COUNT(*) AS n FROM usage WHERE session_id = '${MAIN}' AND partial = 0 GROUP BY prompt_id`);

    test("file first: the calls of the request take its prompt, in one batch or one at a time, the other requests' calls none", () => {
      const prompt = filePromptId(CHAT, "r1");

      const oneBatch = memDb();
      fileRequest(oneBatch, "r1", REQUEST, REQUEST + ELAPSED);
      write(oneBatch, asJson());
      expect(promptsOfMain(oneBatch)).toEqual([{ prompt_id: prompt, n: 8 }]);
      expect(rows(oneBatch, "SELECT DISTINCT prompt_id FROM tool_calls")).toEqual([{ prompt_id: prompt }]);

      const eachCall = memDb();
      fileRequest(eachCall, "r1", REQUEST, REQUEST + ELAPSED);
      for (const s of rounds(asJson())) write(eachCall, { spans: [s], logs: [] });
      expect(promptsOfMain(eachCall)).toEqual([{ prompt_id: prompt, n: 8 }]);

      // The helper calls belong to no request.
      expect(rows(oneBatch, "SELECT DISTINCT prompt_id FROM usage WHERE session_id LIKE 'copilot-chat:background:%'")).toEqual([{ prompt_id: null }]);
    });

    test("a call that follows a finished request is not given its prompt", () => {
      const db = memDb();
      fileRequest(db, "r0", REQUEST - 120_000, REQUEST - 60_000, 20_000);
      write(db, asJson());
      expect(promptsOfMain(db)).toEqual([{ prompt_id: null, n: 8 }]);
    });

    test("telemetry first: the reader links the prompt of the request to its calls", () => {
      const db = memDb();
      write(db, asJson());
      expect(promptsOfMain(db)).toEqual([{ prompt_id: null, n: 8 }]);

      readFile(db);
      const prompt = `${MAIN}:request_11111111-1111-4111-8111-111111111111`;
      expect(promptsOfMain(db)).toEqual([{ prompt_id: prompt, n: 8 }]);
      expect(rows(db, "SELECT DISTINCT prompt_id FROM tool_calls")).toEqual([{ prompt_id: prompt }]);
      expect(rows(db, "SELECT COUNT(*) AS n FROM prompts")).toEqual([{ n: 1 }]);
    });

    test("a scan in the middle of the request, then the telemetry, then the final scan: exactly the telemetry's rows remain, with the prompt", () => {
      const db = memDb();
      const b = asJson();
      const calls = rounds(b);
      const dir = mkdtempSync(join(tmpdir(), "hd-chat-"));
      const path = join(dir, `${CHAT}.jsonl`);
      const request = (extra: Record<string, unknown>) => ({
        requestId: "r1",
        timestamp: REQUEST,
        promptTokens: 40_000,
        completionTokens: 400,
        message: { text: "go" },
        ...extra,
      });
      const scanFile = (r: Record<string, unknown>) => {
        writeFileSync(path, JSON.stringify({ kind: 0, v: { sessionId: CHAT, requests: [r] } }) + "\n");
        ingestCopilotChatFile({ path, project: "/work/p" }, new DbWriter(db, prices, { user: LOCAL.user, host: LOCAL.host }), { promptTextLimit: 100 });
      };

      // Mid-request: three rounds so far, no total time.
      scanFile(request({ result: { metadata: { toolCallRounds: calls.slice(0, 3).map((s) => ({ timestamp: s.endMs, toolCalls: [] })) } } }));
      expect(partialIds(db)).toEqual([fileUsageId(CHAT, "r1")]);
      expect(rows(db, "SELECT end_ts FROM response_meta")).toEqual([{ end_ts: calls[2]!.endMs }]);

      // The telemetry arrives, the first calls in the interval of the partial row and the later ones past it.
      write(db, b);
      expect(partialIds(db)).toEqual([]);
      expect(mainTotals(db)).toMatchObject({ n: 8, input: 47_591, cache: 260_382, output: 1_148 });

      // The final scan: the request is done and covered.
      scanFile(request({ result: { timings: { totalElapsed: ELAPSED }, metadata: { toolCallRounds: calls.map((s) => ({ timestamp: s.endMs, toolCalls: [] })) } } }));
      expect(partialIds(db)).toEqual([]);
      expect(mainTotals(db)).toMatchObject({ n: 8, input: 47_591, cache: 260_382, output: 1_148 });
      expect(promptsOfMain(db)).toEqual([{ prompt_id: filePromptId(CHAT, "r1"), n: 8 }]);
      expect(rows(db, "SELECT DISTINCT project FROM usage WHERE session_id = '" + MAIN + "'")).toEqual([{ project: "/work/p" }]);
    });

    test("a partial row of a scan in the middle that the telemetry did not reach goes at the final scan", () => {
      const db = memDb();
      const calls = rounds(asJson());
      const same = "request_11111111-1111-4111-8111-111111111111";
      fileRequest(db, same, REQUEST, calls[0]!.endMs! - 10_000);

      // A call past the interval's end plus the slack does not take the partial row, the next reading does.
      write(db, { spans: [calls.at(-1)!], logs: [] });
      expect(partialIds(db)).toEqual([fileUsageId(CHAT, same)]);
      expect(mainTotals(db)).toMatchObject({ n: 1 });

      readFile(db);
      expect(partialIds(db)).toEqual([]);
      expect(mainTotals(db)).toMatchObject({ n: 1 });
    });

    test("a conversation id longer than the id limit names the same session in the telemetry and in the chat session file", () => {
      const long = `${"c".repeat(150)}:${"d".repeat(150)}`;
      const db = memDb();
      const span: SpanIn = {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        name: "chat gpt-6-luna",
        startMs: REQUEST + 1_000,
        endMs: REQUEST + 3_000,
        attrs: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "github", "gen_ai.request.model": "gpt-6-luna", "gen_ai.conversation.id": long, "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10 },
      };
      write(db, decodeOtlp("traces", encodeTraces([{ resource: { "service.name": "copilot-chat" }, scope: { name: "copilot-chat" }, records: [span] }]), "protobuf"));

      const path = join(mkdtempSync(join(tmpdir(), "hd-chat-")), "s.jsonl");
      const request = { requestId: "r1", timestamp: REQUEST, promptTokens: 100, completionTokens: 10, message: { text: "go" }, result: { timings: { totalElapsed: 10_000 } } };
      writeFileSync(path, JSON.stringify({ kind: 0, v: { sessionId: long, requests: [request] } }) + "\n");
      ingestCopilotChatFile({ path, project: null }, new DbWriter(db, prices, { user: LOCAL.user, host: LOCAL.host }), { promptTextLimit: 100 });

      expect(rows(db, "SELECT COUNT(*) AS n FROM sessions")).toEqual([{ n: 1 }]);
      // The request was matched to the call: the partial row went, the prompt is the call's.
      expect(partialIds(db)).toEqual([]);
      expect(rows(db, "SELECT prompt_id FROM usage")).toEqual([{ prompt_id: filePromptId(long, "r1") }]);
      expect(rows<{ session_id: string }>(db, "SELECT session_id FROM usage")[0]!.session_id).toBe(rows<{ id: string }>(db, "SELECT id FROM sessions")[0]!.id);
    });

    test("a replay deletes nothing more, and neither do the rounds that follow the first", () => {
      const db = memDb();
      const b = asJson();
      const older = fileRequest(db, "r0", REQUEST - 300_000, REQUEST - 290_000, 20_000);
      fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);

      write(db, b);
      const after = dump(db);
      write(db, b);
      write(db, asProtobuf());
      expect(dump(db)).toBe(after);
      expect(partialIds(db)).toEqual([older]);
    });

    test("calls that arrive one at a time replace it at the first, then leave older requests alone", () => {
      const db = memDb();
      const b = asJson();
      const older = fileRequest(db, "r0", REQUEST - 300_000, REQUEST - 290_000, 20_000);
      fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);

      const each = () => rounds(b).map((s) => ({ spans: [s], logs: [] }));
      write(db, each()[0]!);
      expect(partialIds(db)).toEqual([older]);

      for (const one of each()) write(db, one);
      for (const one of each()) write(db, one);
      expect(partialIds(db)).toEqual([older]);
      expect(mainTotals(db)).toMatchObject({ n: 8, input: 47_591 });
    });

    test("the call that ends just past the request's end still belongs to it", () => {
      const db = memDb();
      const b = asJson();
      fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);

      write(db, { spans: [rounds(b).at(-1)!], logs: [] });
      expect(partialIds(db)).toEqual([]);
    });

    test("a finished older request never matches, even when it is the only partial row", () => {
      const db = memDb();
      const finished = fileRequest(db, "r0", REQUEST - 120_000, REQUEST - 60_000, 20_000);

      write(db, asJson());
      expect(partialIds(db)).toEqual([finished]);
    });

    test("a partial row without an interval is never replaced", () => {
      const db = memDb();
      const noEnd = fileRequest(db, "r1", REQUEST, null);
      expect(rows(db, "SELECT COUNT(*) AS n FROM response_meta")).toEqual([{ n: 1 }]);
      write(db, asJson());
      expect(partialIds(db)).toEqual([noEnd]);

      const db2 = memDb();
      const noMeta = fileRequest(db2, "r1", REQUEST, REQUEST + ELAPSED);
      db2.run("DELETE FROM response_meta");
      write(db2, asJson());
      expect(partialIds(db2)).toEqual([noMeta]);
    });

    test("a request in progress has no file row yet: its calls are written and nothing else is touched", () => {
      const db = memDb();
      const older = fileRequest(db, "r0", REQUEST - 300_000, REQUEST - 290_000, 20_000);
      write(db, asJson());
      expect(partialIds(db)).toEqual([older]);
      expect(mainTotals(db)).toMatchObject({ n: 8 });
    });

    test("a remote sender's rows touch no partial row", () => {
      const db = memDb();
      const request = fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);

      write(db, asJson(), { local: null });
      expect(partialIds(db)).toEqual([request]);
    });

    test("a batch that is no valid export, or a write that fails, leaves the partial row", () => {
      const db = memDb();
      const b = asJson();
      const request = fileRequest(db, "r1", REQUEST, REQUEST + ELAPSED);
      const before = dump(db);

      const body = encodeTraces(resourcesOf(b));
      expect(() => decodeOtlp("traces", body.slice(0, body.length - 7), "protobuf")).toThrow(OtlpDecodeError);
      expect(dump(db)).toBe(before);

      // The second call fails after the first one replaced the row: all of it is rolled back.
      db.run("CREATE TRIGGER boom BEFORE INSERT ON usage WHEN NEW.id LIKE '%:o:%' AND NEW.output_tokens = 146 BEGIN SELECT RAISE(ABORT, 'boom'); END");
      expect(() => write(db, b)).toThrow("boom");
      expect(partialIds(db)).toEqual([request]);
      expect(dump(db)).toBe(before);

      db.run("DROP TRIGGER boom");
      write(db, b);
      expect(partialIds(db)).toEqual([]);
    });
  });
});
