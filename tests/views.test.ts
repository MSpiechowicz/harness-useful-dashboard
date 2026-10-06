import { describe, expect, test } from "bun:test";
import { branchDetail, branches, branchId, parseBranchId } from "../src/core/branches.ts";
import { friction } from "../src/core/friction.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import type { LimitReport } from "../src/core/limits.ts";
import { cycles, limitHistory, planValue, recordReports } from "../src/core/plans.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { bucketKey, mergeSpans, overlapByBucket, peakOverlap, timing } from "../src/core/timing.ts";
import { bucketExpr, liveStatus, Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = new Date(2026, 8, 1, 12, 0, 0).getTime(); // local noon, Sep 1 2026

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: "claude:s1:p1", ts: T0, project: "/work/alpha", model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: 1,
    ...over,
  };
}

function seed() {
  const db = memDb();
  const w = new DbWriter(db, new PriceBook(), ID);
  w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: "/work/alpha", title: "Feature", gitBranch: "feat/login" });
  // A subagent logs no branch: it works on its parent's.
  w.session({ id: "claude:a1", provider: "claude", nativeId: "a1", project: "/work/alpha", parentSessionId: "claude:s1", agent: "Explore" });
  w.session({ id: "claude:s2", provider: "claude", nativeId: "s2", project: "/work/alpha", title: "Trunk", gitBranch: "main" });
  w.session({ id: "omp:s3", provider: "omp", nativeId: "s3", project: "/work/beta", title: "No git" });
  w.usage(usage({ id: "u1" }));
  w.usage(usage({ id: "u2", ts: T0 + DAY, costUsd: 2 }));
  w.usage(usage({ id: "u3", sessionId: "claude:a1", agent: "Explore", isSubagent: true, ts: T0 + 5 * MIN, costUsd: 0.5 }));
  w.usage(usage({ id: "u4", sessionId: "claude:s2", promptId: "claude:s2:p1", costUsd: 4 }));
  w.usage(usage({ id: "u5", provider: "omp", sessionId: "omp:s3", promptId: "omp:s3:p1", project: "/work/beta", model: "gpt-6", billing: "openai-codex", costUsd: 3 }));
  w.tool({ id: "t1", usageId: "u1", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0, project: "/work/alpha", tool: "Edit", filePath: "/work/alpha/login.ts", skill: null, agent: "main" });
  w.tool({ id: "t2", usageId: "u1", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0, project: "/work/alpha", tool: "Bash", filePath: null, skill: null, agent: "main" });
  return { db, w };
}

describe("branches", () => {
  test("ids keep the branch first, so project paths with colons survive", () => {
    expect(parseBranchId(branchId("feat/x", "C:\\work\\a"))).toEqual({ branch: "feat/x", project: "C:\\work\\a" });
    expect(parseBranchId(branchId("(none)", null))).toEqual({ branch: "(none)", project: null });
  });

  test("groups usage by branch per project, with subagents on their parent's branch", () => {
    const { db } = seed();
    const r = branches(db, {});
    const feat = r.rows.find((x) => x.branch === "feat/login")!;
    expect(feat.cost).toBeCloseTo(3.5);
    expect(feat.sessions).toBe(1);
    expect(feat.days).toBe(2);
    expect(feat.longLived).toBe(false);
    expect(r.rows.find((x) => x.branch === "main")!.longLived).toBe(true);
    expect(r.rows.find((x) => x.branch === "(none)")!.project).toBe("/work/beta");
    expect(r.total.cost).toBeCloseTo(10.5);
  });

  test("a branch in detail: days, sessions and the files it changed", () => {
    const { db } = seed();
    const d = branchDetail(db, branchId("feat/login", "/work/alpha"));
    expect(d.totals.cost).toBeCloseTo(3.5);
    expect(d.days.buckets).toHaveLength(2);
    expect(d.sessions.map((s) => [s.id, s.subagents])).toEqual([["claude:s1", 1]]);
    expect(d.files).toEqual([{ key: "/work/alpha/login.ts", edits: 1 }]);
    expect(branchDetail(db, branchId("(none)", "/work/beta")).totals.cost).toBeCloseTo(3);
  });
});

describe("friction", () => {
  test("rates leave declined calls out of the error rate, and outcomes join their tool", () => {
    const { db, w } = seed();
    const base = { provider: "claude" as const, sessionId: "claude:s1", ts: T0, project: "/work/alpha", model: "claude-sonnet-4-5", agent: "main" };
    w.outcome({ ...base, id: "t1", kind: "tool_ok" });
    w.outcome({ ...base, id: "t2", kind: "tool_error" });
    w.outcome({ ...base, id: "x1", kind: "tool_rejected" });
    w.outcome({ ...base, id: "x2", sessionId: "claude:a1", kind: "interrupt" });
    const f = friction(db, { skill: "ignored" }, "day");
    expect(f.totals.errorRate).toBe(0.5);
    expect(f.totals.rejectRate).toBeCloseTo(1 / 3);
    expect(f.totals.interrupts).toBe(1);
    expect(f.tools.find((t) => t.key === "Bash")!.errors).toBe(1);
    expect(f.tools.find((t) => t.key === "(none)")!.rejected).toBe(1);
    // The subagent's interrupt counts toward the session that started it.
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]!).toMatchObject({ id: "claude:s1", errors: 1, rejected: 1, interrupts: 1 });
  });
});

describe("time", () => {
  test("spans merge and overlap is counted", () => {
    expect(mergeSpans([[0, 10], [5, 20], [30, 40]])).toEqual([[0, 20], [30, 40]]);
    expect(peakOverlap([[0, 10], [5, 20], [10, 15]])).toEqual({ peak: 2, at: 5 });
  });

  // bun test runs JavaScript dates in UTC while SQLite keeps the system's local time: compare only when they agree.
  const sqliteOffset = memDb().query<{ m: number }, { s: number }>("SELECT (strftime('%s', $s, 'unixepoch', 'localtime') - $s) / 60 AS m").get({ s: T0 / 1000 })!.m;
  test.if(sqliteOffset === -new Date(T0).getTimezoneOffset())("buckets match the SQL ones, weeks starting on Monday", () => {
    const db = memDb();
    for (const ts of [T0, T0 + 3 * DAY, T0 + 5 * DAY + 11 * 3_600_000, T0 - 40 * DAY]) {
      for (const b of ["hour", "day", "week", "month"] as const) {
        const sql = db.query<{ k: string }, { ts: number }>(`SELECT ${bucketExpr(b, "$ts")} AS k`).get({ ts })!.k;
        expect(bucketKey(ts, b)).toBe(sql);
      }
    }
  });

  test("time is split by how many spans overlap", () => {
    const parts = overlapByBucket([[0, 10], [5, 20], [6, 8]], () => "b");
    // 0-5 one, 5-6 two, 6-8 three, 8-10 two, 10-20 one
    expect(parts.get("b")).toEqual([15, 3, 2]);
  });

  test("active time is the union, model time the sum, and parallel sessions are counted", () => {
    const { db, w } = seed();
    // Two sessions working at once for a minute, then one alone for another.
    w.responseMeta({ usageId: "u1", startTs: T0 - 2 * MIN, endTs: T0 });
    w.responseMeta({ usageId: "u4", startTs: T0 - MIN, endTs: T0 });
    // Longer than a response can be timed: left out.
    w.responseMeta({ usageId: "u5", startTs: T0 - 2 * 3_600_000, endTs: T0 });
    const r = timing(db, {}, "day");
    expect(r.totals.activeMs).toBe(2 * MIN);
    expect(r.models[0]!.modelMs).toBe(3 * MIN);
    expect(r.totals.peakSessions).toBe(2);
    expect(r.totals.parallelMs).toBe(MIN);
    expect(r.series.find((x) => x.one + x.two)).toMatchObject({ one: MIN, two: MIN, more: 0 });
    expect(r.totals.timed).toBe(2);
    expect(r.totals.responses).toBe(5);
  });
});

describe("plans", () => {
  test("usage groups by plan, so Codex and omp on one ChatGPT login are one plan", () => {
    const { db, w } = seed();
    w.usage(usage({ id: "c1", provider: "codex", sessionId: "codex:s9", promptId: null, costUsd: 5 }));
    const r = planValue(db, { from: T0 - 29 * DAY, to: T0 + DAY }, "day", { codex: 20 }, T0 + DAY);
    const codex = r.plans.find((p) => p.key === "codex")!;
    expect(codex.providers.sort()).toEqual(["codex", "omp"]);
    expect(codex.cost).toBeCloseTo(8);
    // Paid from the first use in the range, not the range start.
    expect(codex.days).toBe(1);
    expect(codex.paid).toBeCloseTo(20 / (365.25 / 12));
    expect(r.plans.find((p) => p.key === "claude")!.paid).toBeNull();
  });

  test("readings keep one per window and five minutes, and cycles that ran out are counted", () => {
    const db = memDb();
    const report = (ts: number, used: number, resetsAt: number): LimitReport => ({
      key: "claude:login", provider: "claude", plan: "max", account: null, source: "claude", observedAt: ts,
      windows: [{ id: "five_hour", windowMs: 5 * 3_600_000, scope: null, label: null, usedFraction: used, resetsAt }],
    });
    const reset1 = T0 + 3_600_000;
    recordReports(db, ID.host, [report(T0, 0.4, reset1)]);
    recordReports(db, ID.host, [report(T0 + MIN, 0.5, reset1 + 5_000)]); // same slot: replaces
    recordReports(db, ID.host, [report(T0 + 10 * MIN, 1, reset1)]);
    recordReports(db, ID.host, [report(T0 + 2 * 3_600_000, 0.2, T0 + 6 * 3_600_000)]);
    const [h] = limitHistory(db, {});
    expect(h!.points.map((p) => p[1])).toEqual([0.5, 1, 0.2]);
    expect(h!.cycles.map((c) => c.peak)).toEqual([1, 0.2]);
    expect(h!.hits).toBe(1);
  });

  test("an idle window whose reset keeps moving is no window, and a drop starts a new one", () => {
    const H = 3_600_000;
    const r = (h: number, used: number, resetH: number | null) => ({ ts: T0 + h * H, used, resetsAt: resetH == null ? null : T0 + resetH * H });
    const c = cycles([
      r(0, 0, 168), r(1, 0, 169), r(2, 0, 170), // idle: the reset moves with every reading
      r(3, 0.2, 171), r(4, 0.5, 171), r(5, 0.9, 171.01),
      r(172, 0.1, 340), r(173, 1, 340), // after the reset passed
      r(180, 0.3, null), // dropped back without a reset time: a new window
    ]);
    expect(c.map((x) => x.peak)).toEqual([0.9, 1, 0.3]);
  });

  test("Codex readings from its logs go into the history", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.limit({ provider: "codex", windowId: "primary", windowMinutes: 300, usedPercent: 42, resetsAt: T0 + 3_600_000, plan: "pro", ts: T0 });
    const [h] = limitHistory(db, {});
    expect(h).toMatchObject({ reportKey: "codex:logs", windowMs: 5 * 3_600_000, plan: "pro" });
    expect(h!.points).toEqual([[T0, 0.42]]);
  });
});

describe("live", () => {
  test("a session's status follows its main agent's last response and how long ago it was", () => {
    const now = T0;
    expect(liveStatus(now - 30_000, "end_turn", now)).toBe("working"); // calls still coming in
    expect(liveStatus(now - 5 * MIN, "end_turn", now)).toBe("idle"); // the turn finished: waiting for a prompt
    expect(liveStatus(now - 5 * MIN, "stop", now)).toBe("idle");
    expect(liveStatus(now - 5 * MIN, "tool_use", now)).toBe("working"); // a long tool run
    expect(liveStatus(now - 5 * MIN, "error", now)).toBe("error");
    expect(liveStatus(now - 30 * MIN, "tool_use", now)).toBe("idle");
    expect(liveStatus(now - 5 * MIN, null, now)).toBe("idle");
  });

  test("sessions carry their status, last tool and errors, and the feed lists prompts and failures", () => {
    const { db, w } = seed();
    const now = T0 + DAY + 2 * MIN;
    w.prompt({ id: "claude:s1:p9", sessionId: "claude:s1", provider: "claude", ts: T0 + DAY, text: "ship   it\nnow", skill: null, isCommand: false });
    w.responseMeta({ usageId: "u2", startTs: T0 + DAY - 1000, endTs: T0 + DAY, stopReason: "end_turn" });
    w.tool({ id: "t9", usageId: "u2", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0 + DAY, project: "/work/alpha", tool: "Edit", filePath: "/work/alpha/src/a.ts", skill: null, agent: "main" });
    w.outcome({ id: "t9", provider: "claude", sessionId: "claude:s1", ts: T0 + DAY, project: "/work/alpha", model: null, agent: "main", kind: "tool_error" });
    const q = new Queries(db, () => new PriceBook());
    const live = q.live({}, 60, now);
    const s1 = live.sessions.find((s) => s.id === "claude:s1")!;
    expect(s1).toMatchObject({ status: "idle", lastTool: "Edit", lastFile: "src/a.ts", errors: 1 });
    expect(live.feed.map((e) => [e.kind, e.text ?? e.tool])).toEqual([
      ["prompt", "ship it now"],
      ["tool_error", "Edit"],
    ]);
    expect(live.costSeries.length).toBe(live.series.length);
  });
});
