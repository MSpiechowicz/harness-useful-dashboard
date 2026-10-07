/**
 * How spend spreads across prompts: what the Prompts view draws, worked out on the server so the page gets a few
 * hundred numbers instead of every prompt in the range. Shared with the UI (band edges, the statistics' definitions).
 */

export type PromptMetric = "tokens" | "cost";

/** Band edges for the cost-per-prompt histogram: the bands below the first edge, between edges, and above the last. */
export const PROMPT_BANDS: Record<PromptMetric, number[]> = {
  cost: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  tokens: [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000],
};

export interface PromptStats {
  count: number;
  /** Prompts per band (see PROMPT_BANDS), one row per provider, the busiest first. */
  bands: { provider: string; counts: number[] }[];
  median: number;
  p90: number;
  /** The share of the total that the top 10% of prompts make up. */
  top10: number;
  /** The Pareto curve: % of prompts (largest first) against % of the total, at most ~200 points. */
  pareto: [number, number][];
}

export function bandOf(edges: number[], v: number): number {
  const i = edges.findIndex((e) => v < e);
  return i < 0 ? edges.length : i;
}

/** The value at a percentile (0–1) of values sorted ascending. */
export function percentileOf(ascending: number[], p: number): number {
  if (!ascending.length) return 0;
  return ascending[Math.min(ascending.length - 1, Math.floor(p * ascending.length))]!;
}

/** The share of the total that the largest `fraction` of values (sorted descending) make up. */
export function topShareOf(descending: number[], fraction: number): number {
  const total = descending.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const n = Math.max(1, Math.round(descending.length * fraction));
  let top = 0;
  for (let i = 0; i < n; i++) top += descending[i]!;
  return top / total;
}

/** At most ~200 points, always including the first and the last prompt. */
export function paretoPoints(descending: number[]): [number, number][] {
  const total = descending.reduce((a, b) => a + b, 0) || 1;
  const step = Math.max(1, Math.floor(descending.length / 200));
  const points: [number, number][] = [[0, 0]];
  let run = 0;
  descending.forEach((v, i) => {
    run += v;
    if ((i + 1) % step === 0 || i === descending.length - 1) points.push([((i + 1) / descending.length) * 100, (run / total) * 100]);
  });
  return points;
}

export function promptStats(rows: { value: number; provider: string }[], metric: PromptMetric): PromptStats {
  const edges = PROMPT_BANDS[metric];
  const byProvider = new Map<string, number[]>();
  for (const r of rows) {
    let counts = byProvider.get(r.provider);
    if (!counts) byProvider.set(r.provider, (counts = new Array(edges.length + 1).fill(0)));
    counts[bandOf(edges, r.value)]!++;
  }
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const bands = [...byProvider].map(([provider, counts]) => ({ provider, counts })).sort((a, b) => sum(b.counts) - sum(a.counts));
  const ascending = rows.map((r) => r.value).sort((a, b) => a - b);
  const descending = [...ascending].reverse();
  return {
    count: rows.length,
    bands,
    median: percentileOf(ascending, 0.5),
    p90: percentileOf(ascending, 0.9),
    top10: topShareOf(descending, 0.1),
    pareto: paretoPoints(descending),
  };
}
