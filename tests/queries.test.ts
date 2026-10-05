import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { fillBuckets, projectLabel, Queries, relativeTo, whereClause } from "../src/core/queries.ts";
import { generateTips } from "../src/core/tips.ts";
import { ID, memDb } from "./helpers.ts";

const DAY = 86_400_000;
const T0 = new Date(2026, 8, 1, 12, 0, 0).getTime(); // local noon, Sep 1 2026

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: "claude:s1:p1", ts: T0, project: "/work/alpha", model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 100, output: 100, cacheRead: 800, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    ...over,
  };
}

function seed() {
  const db = memDb();
  const prices = new PriceBook();
  const w = new DbWriter(db, prices, ID);
  w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: "/work/alpha", title: "Alpha work" });
  w.session({ id: "codex:s2", provider: "codex", nativeId: "s2", project: "/work/beta", title: "Beta work" });
  w.prompt({ id: "claude:s1:p1", sessionId: "claude:s1", provider: "claude", ts: T0, text: "make it fast", skill: null, isCommand: false });
  w.prompt({ id: "codex:s2:p2", sessionId: "codex:s2", provider: "codex", ts: T0 + DAY, text: "add docs", skill: "docs", isCommand: false });
  w.usage(usage({ id: "u1" }));
  w.usage(usage({ id: "u2", ts: T0 + 60_000, output: 1000 }));
  w.usage(usage({ id: "u3", provider: "codex", sessionId: "codex:s2", promptId: "codex:s2:p2", ts: T0 + DAY, project: "/work/beta", model: "gpt-5", skill: "docs", input: 5000, cacheRead: 0 }));
  w.usage(usage({ id: "u4", ts: T0 + 3 * DAY, agent: "Explore", isSubagent: true, model: "claude-haiku-4-5" }));
  w.tool({ id: "t1", usageId: "u1", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0, project: "/work/alpha", tool: "Read", filePath: "/work/alpha/a.ts", skill: null, agent: "main" });
  w.tool({ id: "t2", usageId: "u2", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0, project: "/work/alpha", tool: "Edit", filePath: "/work/alpha/a.ts", skill: null, agent: "main" });
  return { db, prices, q: new Queries(db, () => prices) };
}

describe("whereClause", () => {
  test("builds parameterised filters, including the (none) sentinel", () => {
    const w = whereClause({ from: 1, to: 2, provider: "claude", skill: "(none)" });
    expect(w.sql).toBe("WHERE u.ts >= $from AND u.ts < $to AND u.provider = $provider AND u.skill IS NULL");
    expect(w.params).toEqual({ from: 1, to: 2, provider: "claude" });
  });
  test("empty filters produce no clause", () => {
    expect(whereClause({}).sql).toBe("");
  });
});

describe("Queries", () => {
  test("summary totals, cache hit rate and previous period", () => {
    const { q } = seed();
    const s = q.summary({});
    expect(s.messages).toBe(4);
    expect(s.sessions).toBe(2);
    expect(s.prompts).toBe(2);
    expect(s.tokens).toBe(1000 + 1900 + 5100 + 1000);
    expect(s.cacheHitRate).toBeCloseTo(2400 / (2400 + 5300), 6);
    const later = q.summary({ from: T0 + 2 * DAY, to: T0 + 4 * DAY });
    expect(later.messages).toBe(1);
    expect(later.previous?.messages).toBe(3);
  });

  test("filters narrow every query", () => {
    const { q } = seed();
    expect(q.summary({ provider: "codex" }).messages).toBe(1);
    expect(q.summary({ project: "/work/alpha" }).messages).toBe(3);
    expect(q.summary({ skill: "(none)" }).messages).toBe(3);
    expect(q.summary({ agent: "Explore" }).messages).toBe(1);
  });

  test("breakdown shares add up and labels use the project basename", () => {
    const { q } = seed();
    const b = q.breakdown({}, "project");
    expect(b.rows.map((r) => r.label).sort()).toEqual(["alpha", "beta"]);
    expect(b.rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 6);
    expect(b.rows.reduce((a, r) => a + r.tokenShare, 0)).toBeCloseTo(1, 6);
  });

  test("timeseries zero-fills idle days and groups the tail into 'other'", () => {
    const { q } = seed();
    const ts = q.timeseries({ from: T0 - (T0 % 1) }, "day", "provider", "tokens");
    expect(ts.buckets.length).toBeGreaterThanOrEqual(4);
    const sum = ts.series.flatMap((s) => s.data).reduce((a, b) => a + b, 0);
    expect(sum).toBe(1000 + 1900 + 5100 + 1000);
    const top1 = q.timeseries({}, "day", "model", "tokens", 1);
    expect(top1.series.map((s) => s.key)).toEqual(["gpt-5", "__other__"]);
    const types = q.timeseries({}, "week", "type", "tokens");
    expect(types.series.map((s) => s.key)).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
  });

  test("sessions and prompts listings with search", () => {
    const { q } = seed();
    expect(q.sessions({}, { sort: "cost" }).total).toBe(2);
    expect(q.sessions({}, { q: "Beta" }).rows.map((r) => r.id)).toEqual(["codex:s2"]);
    const prompts = q.prompts({}, { sort: "tokens" });
    expect(prompts.rows[0]!.id).toBe("codex:s2:p2");
    expect(q.prompts({}, { q: "fast" }).total).toBe(1);
  });

  test("prompt listing counts tool calls per prompt and keeps the sort across pages", () => {
    const { q } = seed();
    const byCost = q.prompts({}, { sort: "cost" }).rows as Record<string, unknown>[];
    expect(Object.fromEntries(byCost.map((r) => [r.id, r.toolCalls]))).toEqual({ "claude:s1:p1": 2, "codex:s2:p2": 0 });
    const costs = byCost.map((r) => r.cost as number);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    const page2 = q.prompts({}, { sort: "recent", limit: 1, offset: 1 });
    expect(page2.rows.map((r) => r.id)).toEqual(["claude:s1:p1"]);
    expect(page2.total).toBe(2);
  });

  test("session and prompt details", () => {
    const { q } = seed();
    const d = q.sessionDetail("claude:s1");
    expect(d.totals?.messages).toBe(3);
    expect(d.prompts.length).toBe(1);
    expect(d.files[0]).toEqual({ key: "/work/alpha/a.ts", calls: 2 });
    const p = q.promptDetail("claude:s1:p1");
    expect(p.tools.map((t: any) => t.key).sort()).toEqual(["Edit", "Read"]);
  });

  test("heatmap, calendar, tools, cache and filters", () => {
    const { q } = seed();
    expect(q.heatmap({}, "tokens").cells.length).toBeGreaterThan(0);
    expect(q.calendar({}).length).toBe(3);
    const tools = q.tools({});
    expect(tools.totals).toEqual({ calls: 2, tools: 2, mcpTools: 0, mcpCalls: 0, prompts: 2 });
    expect(tools.tools.find((x) => x.key === "Read")?.byProject).toEqual({ "/work/alpha": 1 });
    expect(tools.sources).toEqual([{ key: "builtin", calls: 2 }]);
    const files = q.files({});
    expect(files.totals).toMatchObject({ files: 1, calls: 2, reads: 1, edits: 1 });
    const list = q.fileList({}, {});
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({ key: "/work/alpha/a.ts", path: "a.ts", reads: 1, edits: 1, projectLabel: "alpha" });
    expect(q.fileList({}, { q: "nothing-like-this" }).rows).toEqual([]);
    expect(files.projects).toEqual([{ key: "/work/alpha", label: "alpha", files: 1, calls: 2 }]);
    const hot = q.hotspots({ project: "/work/alpha" });
    expect(hot.folders).toEqual([{ path: ".", files: 1, calls: 2, reads: 1, edits: 1 }]);
    expect(hot.files.map((x) => x.path)).toEqual(["a.ts"]);
    // A file the project's session read outside its root folds into one bucket and leaves the file list.
    const { db: db2, q: q2 } = seed();
    new DbWriter(db2, new PriceBook(), ID).tool({ id: "t9", usageId: "u1", sessionId: "claude:s1", promptId: "claude:s1:p1", provider: "claude", ts: T0, project: "/work/alpha", tool: "Read", filePath: "/tmp/scratch/x.png", skill: null, agent: "main" });
    const hot2 = q2.hotspots({ project: "/work/alpha" });
    expect(hot2.folders.map((g) => g.path).sort()).toEqual([".", "__outside__"]);
    expect(hot2.files.map((x) => x.path)).toEqual(["a.ts"]);
    const cache = q.cache({}, "day");
    expect(cache.totals.savings).toBeGreaterThan(0);
    const f = q.filters();
    expect(f.provider.map((p) => p.value).sort()).toEqual(["claude", "codex"]);
    expect(f.skill.map((s) => s.value)).toEqual(["docs"]);
  });
});

describe("helpers", () => {
  test("relativeTo strips the project root only for files inside it", () => {
    expect(relativeTo("/work/alpha/src/a.ts", "/work/alpha")).toBe("src/a.ts");
    expect(relativeTo("/work/alpha-two/a.ts", "/work/alpha")).toBe("/work/alpha-two/a.ts");
    expect(relativeTo("/tmp/x.ts", "/work/alpha", "/home/me")).toBe("/tmp/x.ts");
    expect(relativeTo("/work/alpha/a.ts", null, "/home/me")).toBe("/work/alpha/a.ts");
    expect(relativeTo("/home/me/other/b.ts", "/work/alpha", "/home/me")).toBe("~/other/b.ts");
  });
  test("projectLabel", () => {
    expect(projectLabel("/home/me/code/app")).toBe("app");
    expect(projectLabel("C:\\Users\\me\\app")).toBe("app");
    expect(projectLabel(null)).toBe("(none)");
  });
  test("fillBuckets fills daily gaps only", () => {
    const from = new Date(2026, 8, 1).getTime();
    const to = new Date(2026, 8, 5).getTime();
    expect(fillBuckets(["2026-09-01", "2026-09-04"], "day", { from, to })).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
    expect(fillBuckets(["2026-09", "2026-07"], "month", {})).toEqual(["2026-07", "2026-09"]);
  });
});

describe("tips", () => {
  test("returns no tips for an empty database", () => {
    const db = memDb();
    expect(generateTips(db, {}, new PriceBook())).toEqual([]);
  });

  test("flags low cache hit rate, subagent share and estimated pricing", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    for (let i = 0; i < 30; i++) {
      w.usage(usage({ id: `m${i}`, ts: T0 + i * 3600_000, input: 200_000, cacheRead: 10_000, output: 2_000, model: i % 2 ? "mystery-model" : "claude-opus-5", agent: i % 3 ? "main" : "worker", isSubagent: i % 3 === 0 }));
    }
    const ids = generateTips(db, {}, new PriceBook()).map((t) => t.id);
    expect(ids).toContain("low-cache-hit");
    expect(ids).toContain("context-bloat");
    expect(ids).toContain("subagent-share");
    expect(ids).toContain("estimated-pricing");
  });
});
