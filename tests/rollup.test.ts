import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { DEFAULT_BUDGETS } from "../src/core/budgets.ts";
import { drift } from "../src/core/drift.ts";
import { friction, frictionTotals } from "../src/core/friction.ts";
import type { OutcomeRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { metricsText } from "../src/core/metrics.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { type Filters, Queries } from "../src/core/queries.ts";
import { localDayStart, rollupCutoff, rollupDue, rollupOutcomes } from "../src/core/rollup.ts";
import { memDb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 10, 15).getTime(); // Nov 10 2026: the 40 days before cross a daylight saving change in many zones
const CUTOFF = rollupCutoff(NOW);
const ME = { user: "ada", host: "laptop" };
const OTHER = { user: "bob", host: "desktop" };
const MODELS = ["claude-opus-5-5", "claude-sonnet-4-5"];
const TOOLS = ["Bash", "Edit", "Read"];

/** Local 9:00 of the day `d` days before NOW. */
function dayAt(d: number, hour = 9): number {
  const t = new Date(NOW);
  t.setDate(t.getDate() - d);
  t.setHours(hour, 0, 0, 0);
  return t.getTime();
}

/**
 * 40 days of two sessions a day on this host (one model each, three tools, some failures, rejections and interrupts,
 * a subagent, an API error) with calls right before and at local midnight, and one session a day on another host.
 */
function write(me: DbWriter, other: DbWriter) {
  for (let d = 0; d < 40; d++) {
    for (let s = 0; s < 2; s++) {
      const sid = `claude:me-${d}-${s}`;
      const model = MODELS[s]!;
      me.session({ id: sid, provider: "claude", nativeId: sid, project: "/work/alpha", startedAt: dayAt(d) });
      for (let i = 0; i < 12; i++) {
        const ts = dayAt(d) + s * 3 * 3_600_000 + i * 7 * 60_000;
        const id = `${sid}:${i}`;
        me.usage({ id, provider: "claude", sessionId: sid, promptId: `${sid}:p${i >> 2}`, ts, project: "/work/alpha", model, skill: null, agent: "main", isSubagent: false, input: 100, output: 300, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 });
        me.responseMeta({ usageId: id, startTs: ts - 10_000, endTs: ts, effort: s ? "low" : "high" });
        const kind = i % 6 === 5 ? "tool_error" : i % 11 === 10 ? "tool_rejected" : "tool_ok";
        me.outcome(outcome({ id: `${id}:o`, sessionId: sid, ts, model, effort: s ? "low" : "high", kind, tool: TOOLS[i % 3]!, reason: kind === "tool_error" ? "exit_code" : null }));
      }
      if ((d + s) % 2) me.outcome(outcome({ id: `${sid}:int`, sessionId: sid, ts: dayAt(d, 20), model, kind: "interrupt" }));
    }
    // A subagent of the first session, and calls on both sides of midnight.
    const sub = `claude:me-${d}-sub`;
    me.session({ id: sub, provider: "claude", nativeId: sub, project: "/work/alpha", parentSessionId: `claude:me-${d}-0`, agent: "Explore" });
    me.outcome(outcome({ id: `${sub}:late`, sessionId: sub, ts: localDayStart(dayAt(d)) + DAY - 1, model: MODELS[0]!, agent: "Explore", kind: "tool_ok", tool: "Read" }));
    me.outcome(outcome({ id: `${sub}:early`, sessionId: sub, ts: localDayStart(dayAt(d)), model: MODELS[0]!, agent: "Explore", kind: "tool_ok", tool: "Read" }));
    me.outcome(outcome({ id: `claude:me-${d}-0:api`, sessionId: `claude:me-${d}-0`, ts: dayAt(d, 11), model: MODELS[0]!, kind: "api_error", reason: "overloaded" }));

    const theirs = `codex:other-${d}`;
    other.session({ id: theirs, provider: "codex", nativeId: theirs, project: "/work/beta" });
    for (let i = 0; i < 5; i++) other.outcome(outcome({ id: `${theirs}:${i}`, provider: "codex", sessionId: theirs, ts: dayAt(d, 14) + i * 1000, project: "/work/beta", model: "gpt-6", kind: "tool_ok", tool: "shell" }));
  }
}

function outcome(o: Partial<OutcomeRecord> & Pick<OutcomeRecord, "id" | "sessionId" | "ts" | "kind">): OutcomeRecord {
  return { provider: "claude", project: "/work/alpha", model: null, agent: "main", effort: null, tool: null, ...o };
}

/** A writer that leaves out successful calls of rolled session-days, as a scan does (or one that doesn't: an older app). */
function writers(db: Database, rollupBefore = CUTOFF) {
  const prices = new PriceBook();
  return [new DbWriter(db, prices, ME, 0, rollupBefore), new DbWriter(db, prices, OTHER, 0, rollupBefore)] as const;
}

function seed() {
  const db = memDb();
  write(...writers(db));
  return db;
}

const FILTERS: Filters[] = [
  {},
  { from: localDayStart(dayAt(30)), to: localDayStart(dayAt(5)) },
  { model: MODELS[1] },
  { provider: "claude", agent: "main", project: "/work/alpha" },
  { user: OTHER.user },
];

/** Everything the rollup must leave as it was: friction, its totals, drift and the metrics text. */
function snapshot(db: Database): string {
  const q = new Queries(db, () => new PriceBook());
  const views = FILTERS.flatMap((f) => (["day", "week", "month"] as const).map((bucket) => {
    const { sessions, tools, models, ...rest } = friction(db, f, bucket);
    // Rows that tie keep no particular order: compared by key. A session's last outcome may be a rolled call, its time
    // is then that day's midnight (checked apart).
    const byKey = <T extends { key: string }>(r: T[]) => [...r].sort((a, b) => a.key.localeCompare(b.key));
    return {
      ...rest,
      tools: byKey(tools),
      models: byKey(models),
      sessions: sessions.map(({ lastTs: _lastTs, ...s }) => ({ ...s, key: s.id })).sort((a, b) => a.key.localeCompare(b.key)),
      totals: frictionTotals(db, f),
    };
  }));
  const drifts = MODELS.map((model) => drift(db, {}, { now: NOW, model }));
  const metrics = metricsText({ db, queries: q, budgets: DEFAULT_BUDGETS, projectLabels: true, user: ME.user, host: ME.host, version: "test", lastScanAt: NOW, now: NOW });
  return JSON.stringify({ views, drifts, metrics });
}

const rows = (db: Database, sql: string) => db.query(sql).all();
const okRows = (db: Database, host: string) => db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM outcomes WHERE kind = 'tool_ok' AND host = ?").get(host)!.n;

describe("outcome rollup", () => {
  test("rolls this host's old successful calls into daily counts, every total unchanged", async () => {
    const db = seed();
    const before = snapshot(db);
    const lastTs = new Map(friction(db, {}, "day").sessions.map((s) => [s.id, s.lastTs]));
    const otherRows = okRows(db, OTHER.host);

    const r = await rollupOutcomes(db, ME.host, { now: NOW });
    expect(r.done).toBe(true);
    expect(r.days).toBe(32); // days 8 to 39 back: the 7 before today and today stay
    expect(r.counted).toBe(r.deleted);
    expect(r.groups).toBeLessThan(r.counted);
    expect(snapshot(db)).toBe(before);

    // Each session-day is a few rows, one per tool and dimension, at local midnight.
    expect(rows(db, "SELECT DISTINCT host FROM outcome_days")).toEqual([{ host: ME.host }]);
    expect(rows(db, `SELECT tool, model, effort, agent, n FROM outcome_days WHERE session_id = 'claude:me-20-0' ORDER BY tool`)).toEqual([
      { tool: "Bash", model: MODELS[0], effort: "high", agent: "main", n: 4 },
      { tool: "Edit", model: MODELS[0], effort: "high", agent: "main", n: 3 },
      { tool: "Read", model: MODELS[0], effort: "high", agent: "main", n: 2 },
    ]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM outcome_days WHERE session_id = 'claude:me-20-sub'")).toEqual([{ n: 1 }]);
    for (const { ts } of db.query<{ ts: number }, []>("SELECT DISTINCT ts FROM outcome_days").all()) expect(localDayStart(ts)).toBe(ts);
    // Newer calls, failures and the other host's rows stay rows.
    expect(rows(db, `SELECT COUNT(*) AS n FROM outcomes WHERE kind = 'tool_ok' AND host = '${ME.host}' AND ts < ${CUTOFF}`)).toEqual([{ n: 0 }]);
    expect(rows(db, `SELECT COUNT(*) > 0 AS some FROM outcomes WHERE kind = 'tool_ok' AND host = '${ME.host}' AND ts >= ${CUTOFF}`)).toEqual([{ some: 1 }]);
    expect(okRows(db, OTHER.host)).toBe(otherRows);

    // A session's last time moves at most to the start of its day.
    for (const s of friction(db, {}, "day").sessions) {
      expect(s.lastTs).toBeLessThanOrEqual(lastTs.get(s.id)!);
      expect(localDayStart(s.lastTs)).toBe(localDayStart(lastTs.get(s.id)!));
    }
  });

  test("runs once a day, and a second run finds nothing to do", async () => {
    const db = seed();
    expect(rollupDue(db, ME.host, NOW)).toBe(true);
    await rollupOutcomes(db, ME.host, { now: NOW });
    expect(rollupDue(db, ME.host, NOW + 1000)).toBe(false);
    expect(rollupDue(db, ME.host, NOW + DAY)).toBe(true);
    expect(rollupDue(db, OTHER.host, NOW)).toBe(true);
    const days = rows(db, "SELECT * FROM outcome_days ORDER BY rowid");
    const again = await rollupOutcomes(db, ME.host, { now: NOW });
    expect(again).toMatchObject({ days: 0, groups: 0, deleted: 0, done: true });
    expect(rows(db, "SELECT * FROM outcome_days ORDER BY rowid")).toEqual(days);
  });

  test("reading the logs again after a rollup counts nothing twice", async () => {
    const db = seed();
    await rollupOutcomes(db, ME.host, { now: NOW });
    const rolled = snapshot(db);
    const ok = okRows(db, ME.host);
    write(...writers(db));
    expect(okRows(db, ME.host)).toBe(ok);
    expect(snapshot(db)).toBe(rolled);
  });

  test("an older app's copies of a rolled session-day are deleted on the next run, uncounted", async () => {
    const db = seed();
    const before = snapshot(db);
    await rollupOutcomes(db, ME.host, { now: NOW });
    // An app without the rollup writes every row again.
    write(...writers(db, 0));
    expect(frictionTotals(db, {}).ok).toBeGreaterThan(JSON.parse(before).views[0].totals.ok);

    const r = await rollupOutcomes(db, ME.host, { now: NOW });
    expect(r.counted).toBe(0);
    expect(r.deleted).toBeGreaterThan(0);
    expect(snapshot(db)).toBe(before);
  });

  test("a session-day read only after the rollup is counted on the next run", async () => {
    const db = seed();
    await rollupOutcomes(db, ME.host, { now: NOW });
    const ok = frictionTotals(db, {}).ok;
    const [me] = writers(db);
    for (let i = 0; i < 4; i++) me.outcome(outcome({ id: `claude:late:${i}`, sessionId: "claude:late", ts: dayAt(25) + i * 1000, model: MODELS[0]!, kind: "tool_ok", tool: "Bash" }));
    expect(frictionTotals(db, {}).ok).toBe(ok + 4);

    const r = await rollupOutcomes(db, ME.host, { now: NOW });
    expect(r).toMatchObject({ counted: 4, deleted: 4, groups: 1 });
    expect(frictionTotals(db, {}).ok).toBe(ok + 4);
    expect(rows(db, "SELECT n FROM outcome_days WHERE session_id = 'claude:late'")).toEqual([{ n: 4 }]);
  });

  test("a run stopped halfway resumes where it left off, with the same result", async () => {
    const whole = seed();
    await rollupOutcomes(whole, ME.host, { now: NOW });

    const db = seed();
    let asked = 0;
    const first = await rollupOutcomes(db, ME.host, { now: NOW, stop: () => ++asked > 10 });
    expect(first.done).toBe(false);
    expect(first.days).toBe(10);
    expect(rollupDue(db, ME.host, NOW + 1000)).toBe(true);
    expect(snapshot(db)).toBe(snapshot(whole));

    const rest = await rollupOutcomes(db, ME.host, { now: NOW });
    expect(rest).toMatchObject({ days: 22, done: true });
    const table = (d: Database, t: string) => rows(d, `SELECT * FROM ${t} ORDER BY session_id, ts, tool, kind`);
    expect(table(db, "outcome_days")).toEqual(table(whole, "outcome_days"));
    expect(table(db, "outcomes")).toEqual(table(whole, "outcomes"));
  });

  test("a database without the rollup table is read from its rows alone", async () => {
    const db = seed();
    const fresh = seed();
    // As an app older than the table finds it: the reader opens it read-only and never migrates.
    db.exec("DROP VIEW outcome_counts; DROP TABLE outcome_days");
    expect(snapshot(db)).toBe(snapshot(fresh));
    expect(await rollupOutcomes(db, ME.host, { now: NOW })).toMatchObject({ days: 0, deleted: 0 });
  });
});
