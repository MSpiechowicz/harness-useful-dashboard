import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DbWriter, recomputeCosts } from "../src/core/ingest/writer.ts";
import { MAX_HOSTS, MAX_TOKENS } from "../src/core/otlp/map.ts";
import { decodeOtlp, remoteHosts, writeOtlp } from "../src/core/otlp/write.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";
import {
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
