import { describe, expect, test } from "bun:test";
import { PROMPT_BANDS, promptStats } from "../src/core/promptStats.ts";

// What the Prompts view computed from every prompt before the server summed them, for comparison.
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))]!;
function topShare(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  return sorted.slice(0, Math.max(1, Math.round(sorted.length * fraction))).reduce((a, b) => a + b, 0) / total;
}

describe("prompt stats", () => {
  // Deterministic, spread over every band, two providers.
  const rows = Array.from({ length: 1234 }, (_, i) => ({ value: ((i * 7919) % 1000) / 60, provider: i % 3 ? "claude" : "codex" }));
  const s = promptStats(rows, "cost");
  const values = rows.map((r) => r.value);

  test("the same median, p90 and top-10% share as before", () => {
    expect(s.count).toBe(1234);
    expect(s.median).toBe(percentile(values, 0.5));
    expect(s.p90).toBe(percentile(values, 0.9));
    expect(s.top10).toBeCloseTo(topShare(values, 0.1), 12);
  });

  test("band counts per provider add up, busiest provider first", () => {
    expect(s.bands.map((b) => b.provider)).toEqual(["claude", "codex"]);
    for (const b of s.bands) expect(b.counts).toHaveLength(PROMPT_BANDS.cost.length + 1);
    expect(s.bands.flatMap((b) => b.counts).reduce((a, b) => a + b, 0)).toBe(1234);
    const over10 = rows.filter((r) => r.value >= 10).length;
    expect(s.bands.reduce((a, b) => a + b.counts.at(-1)!, 0)).toBe(over10);
  });

  test("a Pareto curve of about 200 points from (0, 0) to (100, 100)", () => {
    expect(s.pareto[0]).toEqual([0, 0]);
    expect(s.pareto.at(-1)![0]).toBeCloseTo(100);
    expect(s.pareto.at(-1)![1]).toBeCloseTo(100);
    expect(s.pareto.length).toBeLessThanOrEqual(210);
    for (let i = 1; i < s.pareto.length; i++) expect(s.pareto[i]![1]).toBeGreaterThanOrEqual(s.pareto[i - 1]![1]);
  });

  test("no prompts", () => {
    expect(promptStats([], "tokens")).toEqual({ count: 0, bands: [], median: 0, p90: 0, top10: 0, pareto: [[0, 0]] });
  });
});
