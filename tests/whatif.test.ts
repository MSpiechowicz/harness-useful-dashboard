import { describe, expect, test } from "bun:test";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { pricedModels, whatIf } from "../src/core/whatif.ts";
import { ID, memDb } from "./helpers.ts";

const T0 = new Date(2026, 8, 1, 12).getTime();
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-4-5";
const TOKENS = { input: 1000, output: 2000, cacheRead: 50_000, cacheWrite: 3000, cacheWrite1h: 500 };

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: null, ts: T0, project: "/work/alpha", model: SONNET,
    skill: null, agent: "main", isSubagent: false, reasoning: 0, ...TOKENS,
    ...over,
  };
}

function seed(rows: (Partial<UsageRecord> & { id: string })[], prices = new PriceBook()) {
  const db = memDb();
  const w = new DbWriter(db, prices, ID);
  for (const r of rows) w.usage(usage(r));
  return { db, prices };
}

const tokens = TOKENS.input + TOKENS.output + TOKENS.cacheRead + TOKENS.cacheWrite + TOKENS.cacheWrite1h;

describe("what-if pricing", () => {
  test("the current model as the candidate costs what the range cost, fast mode included", () => {
    const { db, prices } = seed([{ id: "a" }, { id: "b", speed: "fast" }, { id: "c", model: OPUS }]);

    const r = whatIf(db, prices, { model: SONNET }, SONNET);
    expect(r.actual).toBeGreaterThan(0);
    expect(r.whatIf).toBeCloseTo(r.actual, 10);
    expect(r.change).toBeCloseTo(0, 10);
    expect(r.reported).toBe(false);
    expect(r.estimated).toBe(false);
    expect(r.rows).toEqual([{ model: SONNET, tokens: 2 * tokens, actual: r.actual, whatIf: r.whatIf }]);
  });

  test("another model re-prices every token, its fast mode not carried over", () => {
    const { db, prices } = seed([{ id: "a" }, { id: "b", model: OPUS, speed: "fast" }]);
    const opus = prices.cost(OPUS, TOKENS).usd;
    const sonnet = prices.cost(SONNET, TOKENS).usd;

    const r = whatIf(db, prices, {}, SONNET);
    const opusRow = r.rows.find((x) => x.model === OPUS)!;
    expect(opusRow.actual).toBeCloseTo(2 * opus, 10);
    expect(opusRow.whatIf).toBeCloseTo(sonnet, 10);
    expect(r.whatIf).toBeCloseTo(2 * sonnet, 10);
    expect(r.change).toBeCloseTo((2 * sonnet) / (sonnet + 2 * opus) - 1, 10);

    const back = whatIf(db, prices, {}, OPUS);
    expect(back.rows.find((x) => x.model === OPUS)!.whatIf).toBeCloseTo(2 * opus, 10);
    expect(back.rows.find((x) => x.model === SONNET)!.whatIf).toBeCloseTo(opus, 10);
  });

  test("a model with a dated or routed id counts as the candidate's own", () => {
    const { db, prices } = seed([{ id: "a", model: `anthropic/${OPUS}-20260101`, speed: "fast" }]);
    const r = whatIf(db, prices, {}, OPUS);
    expect(r.whatIf).toBeCloseTo(r.actual, 10);
    expect(r.candidates.inUse).toEqual([OPUS]);
  });

  test("costs the provider reported are flagged", () => {
    const { db, prices } = seed([{ id: "a" }, { id: "cur", provider: "cursor", sessionId: "cursor:s", costUsd: 0.5 }]);
    const r = whatIf(db, prices, {}, SONNET);
    expect(r.reported).toBe(true);
    expect(r.actual).toBeCloseTo(prices.cost(SONNET, TOKENS).usd + 0.5, 10);

    expect(whatIf(db, prices, { provider: "claude" }, SONNET).reported).toBe(false);
  });

  test("a candidate without a list price is estimated", () => {
    const { db, prices } = seed([{ id: "a" }]);
    const r = whatIf(db, prices, {}, "mystery-model-9");
    expect(r.estimated).toBe(true);
    expect(r.candidate).toBe("mystery-model-9");
  });

  test("the filters apply", () => {
    const { db, prices } = seed([{ id: "a" }, { id: "b", project: "/work/beta", model: OPUS }]);
    const r = whatIf(db, prices, { project: "/work/beta" }, null);
    expect(r.rows.map((x) => x.model)).toEqual([OPUS]);
    expect(r.candidates.inUse).toEqual([OPUS]);
  });
});

describe("what-if candidates", () => {
  test("models in use, costliest first and without synthetic messages, the default being the first", () => {
    const { db, prices } = seed([
      { id: "a" },
      { id: "b", model: OPUS, output: 50_000 },
      { id: "c", model: `${OPUS}[1m]` },
      { id: "syn", model: "<synthetic>" },
    ]);
    const r = whatIf(db, prices, {}, null);
    expect(r.candidates.inUse).toEqual([OPUS, SONNET]);
    expect(r.candidate).toBe(OPUS);
    expect(r.rows.map((x) => x.model)).not.toContain("<synthetic>");
  });

  test("priced names come from the price rules, wildcards and trailing separators cut", () => {
    const prices = new PriceBook([{ pattern: "my-model-*", input: 1, output: 2 }, { pattern: "claude-opus-5*", input: 5, output: 25 }]);
    const names = pricedModels(prices);
    expect(names).toContain("claude-opus-5");
    expect(names).toContain("gpt-5");
    expect(names).toContain("my-model");
    expect(names.some((n) => n.includes("*") || /[-.]$/.test(n))).toBe(false);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    expect(pricedModels(prices)).toBe(names);
  });

  test("an empty range has no change to show", () => {
    const db = memDb();
    const prices = new PriceBook();
    const r = whatIf(db, prices, {}, null);
    expect(r).toMatchObject({ actual: 0, whatIf: 0, change: null, reported: false, rows: [], candidates: { inUse: [] } });
    expect(r.candidate).toBe(r.candidates.priced[0]!);
  });
});
