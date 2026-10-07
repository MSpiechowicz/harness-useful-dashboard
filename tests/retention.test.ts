import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetStatus, DEFAULT_BUDGETS } from "../src/core/budgets.ts";
import { parseSettings, retentionMonths } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import type { OutcomeRecord, ToolRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries, sessionTitle } from "../src/core/queries.ts";
import { compact, dbSize, detailCutoff, trimDetail, trimDue } from "../src/core/retention.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { memDb, tempDir } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 1, 12).getTime(); // Oct 1 2026
const OLD = new Date(2026, 4, 1, 12).getTime(); // May 1: older than 3 months
const NEW = new Date(2026, 8, 15, 12).getTime(); // Sep 15
const ME = { user: "ada", host: "laptop" };
const OTHER = { user: "bob", host: "desktop" };
const LONG = "x".repeat(500);

function usage(id: string, sessionId: string, ts: number, over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id, provider: "claude", sessionId, promptId: `${sessionId}:p1`, ts, project: "/work/alpha", model: "claude-sonnet-4-5", skill: null, agent: "main",
    isSubagent: false, input: 100, output: 200, cacheRead: 800, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, ...over,
  };
}

/** One session of `n` responses at `ts` for a host: prompts, tool calls with paths, failures with messages, timings. */
function session(w: DbWriter, sid: string, ts: number, n = 3) {
  w.session({ id: sid, provider: "claude", nativeId: sid, project: "/work/alpha", startedAt: ts, endedAt: ts + n * 1000, brief: "Find the login handlers" });
  w.prompt({ id: `${sid}:p1`, sessionId: sid, provider: "claude", ts, text: `first ${LONG}`, skill: null, isCommand: false });
  w.prompt({ id: `${sid}:p2`, sessionId: sid, provider: "claude", ts: ts + 500, text: "second prompt", skill: null, isCommand: false });
  for (let i = 0; i < n; i++) {
    const t = ts + i * 1000;
    w.usage(usage(`${sid}:u${i}`, sid, t, { model: i % 2 ? "claude-haiku-4-5" : "claude-sonnet-4-5" }));
    w.responseMeta({ usageId: `${sid}:u${i}`, startTs: t - 900, endTs: t, effort: "high", stopReason: "end_turn" });
    const tool: ToolRecord = { id: `${sid}:t${i}`, usageId: `${sid}:u${i}`, sessionId: sid, promptId: `${sid}:p1`, provider: "claude", ts: t, project: "/work/alpha", tool: "Edit", filePath: `/work/alpha/f${i}.ts`, skill: null, agent: "main", brief: "Look around" };
    w.tool(tool);
    const out: OutcomeRecord = { id: `${sid}:t${i}`, provider: "claude", sessionId: sid, ts: t, project: "/work/alpha", model: "claude-sonnet-4-5", agent: "main", kind: "tool_error", tool: "Edit", reason: "not_found", detail: "No such file", input: "/work/alpha/f.ts" };
    w.outcome(out);
  }
}

function seed() {
  const db = memDb();
  const prices = new PriceBook();
  const me = new DbWriter(db, prices, ME);
  const other = new DbWriter(db, prices, OTHER);
  session(me, "claude:old", OLD, 7);
  session(me, "claude:new", NEW);
  session(other, "claude:theirs", OLD);
  return { db, prices, q: new Queries(db, () => prices) };
}

/** Everything the totals, trends and breakdowns show, as one string. */
function totals(db: Database, q: Queries): string {
  const all = { from: OLD - 30 * DAY, to: NOW };
  return JSON.stringify([
    q.summary({}),
    q.summary(all),
    q.timeseries(all, "day", "model", "cost", 5),
    q.timeseries(all, "month", "type", "tokens", 5),
    ...(["project", "model", "user", "host", "session", "prompt"] as const).map((d) => q.breakdown(all, d, 500, "cost")),
    q.calendar(all),
    q.heatmap(all, "tokens"),
    q.tools(all),
    db.query("SELECT COUNT(*) AS n, SUM(cost_usd) AS c, SUM(total_tokens) AS t FROM usage").get(),
    db.query("SELECT kind, COUNT(*) AS n FROM outcomes GROUP BY kind").all(),
    budgetStatus(db, { ...DEFAULT_BUDGETS, daily: 1, monthly: 10, projects: { "/work/alpha": 5 } }, "ada"),
  ]);
}

const col = (db: Database, sql: string) => db.query(sql).all();

describe("detail retention", () => {
  test("trims old detail of this host, keeps every usage row and every total", async () => {
    const { db, q } = seed();
    const before = totals(db, q);
    const r = await trimDetail(db, ME.host, 3, { now: NOW });
    expect(r.done).toBe(true);
    expect(totals(db, q)).toBe(before);

    // Old: no text but the start of the first prompt, no paths, briefs, messages or response times.
    expect(col(db, "SELECT id, text FROM prompts WHERE session_id = 'claude:old' ORDER BY id")).toEqual([
      { id: "claude:old:p1", text: `first ${LONG}`.slice(0, 300) },
      { id: "claude:old:p2", text: null },
    ]);
    expect(col(db, "SELECT DISTINCT file_path, brief FROM tool_calls WHERE session_id = 'claude:old'")).toEqual([{ file_path: null, brief: null }]);
    expect(col(db, "SELECT DISTINCT detail, input, reason FROM outcomes WHERE session_id = 'claude:old'")).toEqual([{ detail: null, input: null, reason: "not_found" }]);
    expect(col(db, "SELECT brief FROM sessions WHERE id = 'claude:old'")).toEqual([{ brief: null }]);
    expect(col(db, "SELECT COUNT(*) AS n FROM response_meta WHERE usage_id LIKE 'claude:old:%'")).toEqual([{ n: 0 }]);
    expect(r).toMatchObject({ prompts: 2, toolCalls: 7, outcomes: 7, sessions: 1, responseMeta: 7 });

    // Recent rows and another machine's rows keep everything.
    for (const sid of ["claude:new", "claude:theirs"]) {
      expect(col(db, `SELECT COUNT(*) AS n FROM prompts WHERE session_id = '${sid}' AND text IS NOT NULL`)).toEqual([{ n: 2 }]);
      expect(col(db, `SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = '${sid}' AND file_path IS NOT NULL AND brief IS NOT NULL`)).toEqual([{ n: 3 }]);
      expect(col(db, `SELECT COUNT(*) AS n FROM outcomes WHERE session_id = '${sid}' AND detail IS NOT NULL`)).toEqual([{ n: 3 }]);
      expect(col(db, `SELECT COUNT(*) AS n FROM response_meta WHERE usage_id LIKE '${sid}:%'`)).toEqual([{ n: 3 }]);
      expect(col(db, `SELECT brief FROM sessions WHERE id = '${sid}'`)).toEqual([{ brief: "Find the login handlers" }]);
    }
    // The session keeps its title from the first prompt.
    expect(col(db, `SELECT ${sessionTitle("s")} AS title FROM sessions s WHERE s.id = 'claude:old'`)).toEqual([{ title: `first ${LONG}`.slice(0, 160) }]);
  });

  test("is idempotent and runs once a day per setting", async () => {
    const { db } = seed();
    expect(trimDue(db, ME.host, 0, NOW)).toBe(false);
    expect(trimDue(db, ME.host, 3, NOW)).toBe(true);
    await trimDetail(db, ME.host, 3, { now: NOW });
    expect(trimDue(db, ME.host, 3, NOW + 1000)).toBe(false);
    expect(trimDue(db, ME.host, 3, NOW + DAY)).toBe(true);
    expect(trimDue(db, ME.host, 6, NOW + 1000)).toBe(true);
    const again = await trimDetail(db, ME.host, 3, { now: NOW + DAY });
    expect(again.prompts + again.toolCalls + again.outcomes + again.sessions + again.responseMeta).toBe(0);
    expect(again.batches).toBe(0);
    // Off: nothing is trimmed, and the note goes, so turning it on again goes over all history once more.
    const off = await trimDetail(db, ME.host, 0, { now: NOW });
    expect(off.batches).toBe(0);
    expect(trimDue(db, ME.host, 0, NOW)).toBe(false);
    expect(trimDue(db, ME.host, 3, NOW)).toBe(true);
  });

  test("commits at most a batch of rows per transaction", async () => {
    const { db } = seed();
    const r = await trimDetail(db, ME.host, 3, { now: NOW, batch: 2 });
    // 7 old tool calls, outcomes and response times: 4 batches each, prompts 1, the session brief 1.
    expect(r).toMatchObject({ toolCalls: 7, outcomes: 7, responseMeta: 7, batches: 4 * 3 + 1 + 1 });
  });

  test("stops between batches when asked", async () => {
    const { db } = seed();
    let calls = 0;
    const r = await trimDetail(db, ME.host, 3, { now: NOW, batch: 2, stop: () => ++calls > 3 });
    expect(r.done).toBe(false);
    expect(trimDue(db, ME.host, 3, NOW)).toBe(true);
  });

  test("reading old logs again doesn't bring trimmed detail back", async () => {
    const { db, prices } = seed();
    await trimDetail(db, ME.host, 3, { now: NOW });
    const rows = () => JSON.stringify(["prompts", "tool_calls", "outcomes", "sessions", "usage"].map((t) => col(db, `SELECT * FROM ${t} ORDER BY id`)).concat([col(db, "SELECT * FROM response_meta ORDER BY usage_id")]));
    const trimmed = rows();
    // A full rescan: the same records once more, through a writer that leaves out detail older than the cutoff.
    session(new DbWriter(db, prices, ME, detailCutoff(3, NOW)!), "claude:old", OLD, 7);
    session(new DbWriter(db, prices, ME, detailCutoff(3, NOW)!), "claude:new", NEW);
    expect(rows()).toBe(trimmed);
  });

  test("a cutoff is whole calendar months back", () => {
    expect(detailCutoff(0, NOW)).toBeNull();
    expect(detailCutoff(3, NOW)).toBe(new Date(2026, 6, 1, 12).getTime());
  });

  test("the setting is off or at least two months", () => {
    expect([0, -1, Number.NaN, 1, 2.4, 3, 24, 1000].map(retentionMonths)).toEqual([0, 0, 0, 2, 2, 3, 24, 120]);
    expect(parseSettings({ detailRetentionMonths: 6 })).toEqual({ patch: { detailRetentionMonths: 6 } });
    expect(parseSettings({ detailRetentionMonths: 1 })).toEqual({ patch: { detailRetentionMonths: 2 } });
    expect(parseSettings({ detailRetentionMonths: 0 })).toEqual({ patch: { detailRetentionMonths: 0 } });
    for (const v of ["6", null, true, Number.POSITIVE_INFINITY]) expect("error" in parseSettings({ detailRetentionMonths: v }), String(v)).toBe(true);
  });
});

describe("database size", () => {
  test("a new database gives freed pages back a step at a time, an older one after Compact", async () => {
    const dir = tempDir();
    const fresh = openDb(join(dir, "new.db"), { isDefaultPath: true });
    expect(dbSize(fresh).incremental).toBe(true);
    fresh.close();

    // A database from before: no auto-vacuum.
    const path = join(dir, "old.db");
    const raw = new Database(path, { create: true });
    raw.exec("CREATE TABLE filler (x)");
    raw.close();
    const db = openDb(path, { journalMode: "delete", isDefaultPath: false });
    expect(dbSize(db).incremental).toBe(false);
    const prices = new PriceBook();
    const w = new DbWriter(db, prices, ME);
    db.transaction(() => {
      for (let i = 0; i < 40; i++) session(w, `claude:s${i}`, OLD + i * DAY, 20);
    })();
    const size = compact(db);
    expect(size.incremental).toBe(true);
    expect(size.freeBytes).toBe(0);
    const r = await trimDetail(db, ME.host, 3, { now: NOW });
    expect(r.freedPages).toBeGreaterThan(0);
    expect(dbSize(db).bytes).toBeLessThan(size.bytes);
    expect(dbSize(db).freeBytes).toBe(0);
    db.close();
  });
});

describe("compact route", () => {
  const token = "c".repeat(64);
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;

  beforeAll(() => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false } } }));
    app = new App(join(root, "test.db"));
    handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token, port: 4317 });
  });
  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
  });

  const req = (path: string, headers: Record<string, string>, method = "POST", body?: string) =>
    handle(new Request(`http://localhost:4317${path}`, { method, headers: { host: "localhost:4317", ...headers }, body }));

  test("needs the sign-in and the custom header like every other change", async () => {
    expect((await req("/api/db/compact", { "x-harness-dashboard": "1" })).status).toBe(401);
    expect((await req("/api/db/compact", { cookie: `hd_auth_4317=${token}` })).status).toBe(403);
    expect((await req("/api/db/compact", { cookie: `hd_auth_4317=${token}`, "x-harness-dashboard": "1", "sec-fetch-site": "cross-site" })).status).toBe(403);
    const ok = await req("/api/db/compact", { cookie: `hd_auth_4317=${token}`, "x-harness-dashboard": "1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ freeBytes: 0, incremental: true });
    const size = await req("/api/db/size", { cookie: `hd_auth_4317=${token}` }, "GET");
    expect(((await size.json()) as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  test("a retention setting saved through the API trims in the background", async () => {
    const body = JSON.stringify({ detailRetentionMonths: 3 });
    const res = await req("/api/settings", { cookie: `hd_auth_4317=${token}`, "x-harness-dashboard": "1", "content-type": "application/json" }, "POST", body);
    expect(res.status).toBe(200);
    expect(app.cfg.detailRetentionMonths).toBe(3);
    // Nothing of this host to trim: the trim only notes that it ran.
    await Bun.sleep(20);
    expect(trimDue(app.db, app.identity.host, 3)).toBe(false);
  });
});
