import { describe, expect, test } from "bun:test";
import { digestName } from "../src/core/digestText.ts";
import type { CompactionRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { generateTips } from "../src/core/tips.ts";
import { ID, memDb } from "./helpers.ts";

const T0 = new Date(2026, 8, 1, 12).getTime();
const DAY = 86_400_000;

/** Ten days of usage, then `count` compactions costing `each`, the first `auto` of them automatic, all but two in claude:s2. */
function seed(count: number, each: number, opts: { auto?: number } = {}) {
  const db = memDb();
  const prices = new PriceBook();
  const w = new DbWriter(db, prices, ID);
  for (let d = 0; d < 10; d++) {
    w.usage({
      id: `u${d}`, provider: "claude", sessionId: "claude:s1", promptId: null, ts: T0 + d * DAY, project: "/work/alpha", model: "claude-sonnet-4-5",
      skill: "review", agent: "main", isSubagent: false, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    });
  }
  for (let i = 0; i < count; i++) {
    const sessionId = i < 2 ? "claude:s1" : "claude:s2";
    const c: CompactionRecord = {
      id: `${sessionId}:c${i}:compact`, provider: "claude", sessionId, ts: T0 + i * 3_600_000, project: "/work/alpha", model: "claude-sonnet-4-5",
      agent: "main", trigger: i < (opts.auto ?? count) ? "auto" : "manual", preTokens: 150_000, postTokens: 5000, durationMs: null, costUsd: each,
    };
    w.compaction(c);
  }
  return { db, prices };
}

type Db = ReturnType<typeof memDb>;

const tip = (db: Db, prices: PriceBook, f = {}) => generateTips(db, f, prices).find((t) => t.id === "frequent-compactions");

describe("frequent compactions tip", () => {
  test("five compactions costing a dollar or more fire, linked to the session with the most", () => {
    const { db, prices } = seed(5, 0.25, { auto: 4 });
    expect(tip(db, prices)).toMatchObject({
      category: "context",
      params: { count: 5, cost: 1.25, share: 80 },
      link: "#/sessions/claude%3As2",
      key: "frequent-compactions:sessions/claude%3As2",
    });
    expect(tip(db, prices)!.impact).toBeGreaterThan(0);
  });

  test("weighed against the spend in range: a large share warns, none to compare against stays informational", () => {
    const { db, prices } = seed(5, 1);
    expect(tip(db, prices)?.severity).toBe("warn");

    db.exec("UPDATE usage SET cost_usd = 0");
    expect(tip(db, prices)).toMatchObject({ severity: "info", params: { count: 5, cost: 5 } });
  });

  test("four compactions, or five costing under a dollar, don't", () => {
    const four = seed(4, 1);
    expect(tip(four.db, four.prices)).toBeUndefined();

    const cheap = seed(5, 0.19);
    expect(tip(cheap.db, cheap.prices)).toBeUndefined();
  });

  test("the range and filters apply, the skill filter is ignored", () => {
    const { db, prices } = seed(6, 0.5);
    expect(tip(db, prices, { from: T0 + 3 * 3_600_000 })).toBeUndefined();
    expect(tip(db, prices, { project: "/work/beta" })).toBeUndefined();
    expect(tip(db, prices, { project: "/work/alpha" })?.params.count).toBe(6);
    expect(tip(db, prices, { skill: "review" })?.params.count).toBe(6);
  });

  test("a database without compactions gives no tip and no error", () => {
    const { db, prices } = seed(0, 0);
    db.exec("DROP TABLE compactions");
    expect(generateTips(db, {}, prices).some((t) => t.id === "frequent-compactions")).toBe(false);
  });

  test("the digest names it in every language", () => {
    for (const lang of ["en", "de", "es", "fr", "pl"] as const) {
      expect(digestName(lang, "tip:frequent-compactions")).toContain("{count}");
    }
    expect(digestName("pl", "tip:frequent-compactions")).not.toBe(digestName("en", "tip:frequent-compactions"));
  });
});
