import { describe, expect, test } from "bun:test";
import type { ToolRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";

const MIN = 60_000;
const NOW = new Date(2026, 8, 1, 12, 0, 0).getTime();

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:p", promptId: null, ts: NOW - 10 * MIN, project: "/work/alpha", model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: 1,
    ...over,
  };
}
function tool(over: Partial<ToolRecord> & { id: string; tool: string }): ToolRecord {
  return {
    usageId: null, sessionId: "claude:p", promptId: null, provider: "claude", ts: NOW - 10 * MIN, project: "/work/alpha", filePath: null,
    skill: null, agent: "main", ...over,
  };
}

function seed() {
  const db = memDb();
  const w = new DbWriter(db, new PriceBook(), ID);
  // Claude Code: two subagents in the parent's own log, each started by an Agent call that says what it is for.
  w.session({ id: "claude:p", provider: "claude", nativeId: "p", project: "/work/alpha", title: "Parent" });
  w.usage(usage({ id: "m1", costUsd: 2 }));
  w.tool(tool({ id: "claude:tA", tool: "Agent", brief: "Find the login handlers" }));
  w.tool(tool({ id: "claude:tB", tool: "Agent", brief: "Review the diff" }));
  const sub = (id: string, ref: string, agent: string, ts: number) =>
    w.usage(usage({ id, agent, isSubagent: true, spawnRef: ref, ts, costUsd: 0.5 }));
  sub("a1", "claude:tA", "Explore", NOW - 5 * MIN);
  sub("a2", "claude:tA", "Explore", NOW - 30_000);
  sub("b1", "claude:tB", "general-purpose", NOW - 8 * MIN);
  w.responseMeta({ usageId: "b1", startTs: null, endTs: NOW - 8 * MIN, stopReason: "end_turn" });
  // A run that ended before the window: not listed.
  w.tool(tool({ id: "claude:tC", tool: "Agent", brief: "Old work", ts: NOW - 5 * 60 * MIN }));
  sub("c1", "claude:tC", "Explore", NOW - 5 * 60 * MIN);
  w.tool(tool({ id: "claude:x1", tool: "Read", filePath: "/work/alpha/src/login.ts", agent: "Explore", spawnRef: "claude:tA", ts: NOW - 40_000 }));
  w.tool(tool({ id: "claude:x2", tool: "Bash", agent: "Explore", spawnRef: "claude:tA", ts: NOW - 4 * MIN }));
  w.outcome({ id: "claude:x2", provider: "claude", sessionId: "claude:p", ts: NOW - 4 * MIN, project: "/work/alpha", model: null, agent: "Explore", kind: "tool_error" });
  // omp: a subagent is a session of its own, with its brief.
  w.session({ id: "omp:p", provider: "omp", nativeId: "p", project: "/work/beta", title: "Omp parent" });
  w.session({ id: "omp:c", provider: "omp", nativeId: "c", project: "/work/beta", parentSessionId: "omp:p", agent: "Scout", brief: "Map the API" });
  w.usage(usage({ id: "o1", provider: "omp", sessionId: "omp:p", project: "/work/beta", ts: NOW - 20 * MIN }));
  w.usage(usage({ id: "o2", provider: "omp", sessionId: "omp:c", project: "/work/beta", agent: "Scout", isSubagent: true, ts: NOW - 15 * MIN, costUsd: 3 }));
  w.responseMeta({ usageId: "o2", startTs: null, endTs: NOW - 15 * MIN, stopReason: "stop" });
  return db;
}

describe("live subagent runs", () => {
  test("Claude Code runs are keyed by the call that started them, named by its brief, newest first", () => {
    const live = new Queries(seed(), () => new PriceBook()).live({}, 60, NOW);
    const p = live.sessions.find((s) => s.id === "claude:p")!;
    // The parent's totals still hold its subagents, and its own share is apart.
    expect(p.cost).toBeCloseTo(4);
    expect(p.ownCost).toBeCloseTo(2);
    expect(p.runCount).toBe(2);
    expect(p.runs.map((r) => [r.key, r.agent, r.brief, r.status])).toEqual([
      ["claude:tA", "Explore", "Find the login handlers", "working"],
      ["claude:tB", "general-purpose", "Review the diff", "idle"],
    ]);
    expect(p.runs[0]).toMatchObject({ sessionId: null, cost: 1, messages: 2, lastTool: "Read", lastFile: "src/login.ts", errors: 1 });
    expect(p.runs[1]).toMatchObject({ lastTool: null, errors: 0 });
  });

  test("a child session is a run of its own, with its page to open", () => {
    const live = new Queries(seed(), () => new PriceBook()).live({}, 60, NOW);
    const p = live.sessions.find((s) => s.id === "omp:p")!;
    expect(p.ownCost).toBeCloseTo(1);
    expect(p.runs).toEqual([
      expect.objectContaining({ key: "omp:c", sessionId: "omp:c", agent: "Scout", brief: "Map the API", cost: 3, status: "idle" }),
    ]);
  });

  test("lists the newest runs and counts the rest", () => {
    const db = seed();
    const w = new DbWriter(db, new PriceBook(), ID);
    for (let i = 0; i < 12; i++) w.usage(usage({ id: `n${i}`, agent: "Explore", isSubagent: true, spawnRef: `claude:n${i}`, ts: NOW - (20 + i) * MIN }));
    const p = new Queries(db, () => new PriceBook()).live({}, 60, NOW).sessions.find((s) => s.id === "claude:p")!;
    expect(p.runCount).toBe(14);
    expect(p.runs.length).toBe(8);
    expect(p.runs.slice(0, 3).map((r) => r.key)).toEqual(["claude:tA", "claude:tB", "claude:n0"]);
  });
});
