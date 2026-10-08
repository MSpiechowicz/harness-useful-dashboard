import { describe, expect, test } from "bun:test";
import { drift, median, rateZ, usualRange } from "../src/core/drift.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { ID, memDb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 6, 18, 0, 0).getTime();

/**
 * 35 days of one model at a steady pace, 20 responses and 20 tool calls a day. From `slowFrom` days ago on, it
 * answers at half the speed and fails a tool call in four.
 */
function seed(opts: { slowFrom?: number; model?: string; effort?: string; apiErrors?: (d: number) => number } = {}) {
  const db = memDb();
  const w = new DbWriter(db, new PriceBook(), ID);
  const model = opts.model ?? "gpt-6";
  w.session({ id: "omp:s1", provider: "omp", nativeId: "s1", project: "/work/alpha", clientVersion: "1.0" });
  for (let d = 34; d >= 0; d--) {
    const slow = opts.slowFrom != null && d < opts.slowFrom;
    const dayStart = NOW - d * DAY - 6 * 3_600_000;
    for (let i = 0; i < 20; i++) {
      const ts = dayStart + i * 60_000;
      const id = `${model}:${d}:${i}`;
      const promptId = `omp:s1:p${d}:${Math.floor(i / 2)}`;
      // Speeds wobble a little from day to day so the baseline has a spread.
      const secs = (slow ? 20 : 10) * (1 + ((d * 7 + i) % 5) / 50);
      w.usage({ id, provider: "omp", sessionId: "omp:s1", promptId, ts, project: "/work/alpha", model, skill: null, agent: "main", isSubagent: false, input: 100, output: 500, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 });
      w.responseMeta({ usageId: id, startTs: ts - secs * 1000, endTs: ts, ttftMs: 1000, effort: opts.effort ?? "high" });
      const failed = slow ? i % 4 === 0 : i % 20 === 0;
      w.outcome({ id: `${id}:tool`, provider: "omp", sessionId: "omp:s1", ts, project: "/work/alpha", model, agent: "main", effort: opts.effort ?? "high", kind: failed ? "tool_error" : "tool_ok" });
    }
    for (let i = 0; i < (opts.apiErrors?.(d) ?? 0); i++) {
      w.outcome({ id: `${model}:${d}:api${i}`, provider: "omp", sessionId: "omp:s1", ts: dayStart + i * 1000, project: "/work/alpha", model, agent: "main", effort: opts.effort ?? "high", kind: "api_error", reason: "overloaded" });
    }
  }
  return db;
}

describe("drift statistics", () => {
  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  test("rates are compared on their counts", () => {
    expect(rateZ({ num: 2, den: 100 }, { num: 6, den: 400 })).toBeLessThan(1); // a couple of interrupts more is noise
    expect(rateZ({ num: 25, den: 100 }, { num: 20, den: 400 })).toBeGreaterThan(3);
    expect(rateZ({ num: 0, den: 0 }, { num: 5, den: 100 })).toBe(0);
  });

  test("the usual range has a floor when the baseline is flat", () => {
    expect(usualRange([10, 10, 10])).toEqual({ lo: 9.5, mid: 10, hi: 10.5 });
    const r = usualRange([10, 11, 9, 10, 30])!;
    expect(r.mid).toBe(10);
    expect(r.hi).toBeLessThan(30); // one odd day doesn't stretch the range
  });
});

describe("drift", () => {
  test("a steady model is stable", () => {
    const d = drift(seed(), {}, { now: NOW });
    expect(d.model).toBe("gpt-6");
    const speed = d.series.find((s) => s.key === "speed")!;
    expect(speed.comparison.status).toBe("stable");
    expect(speed.providers).toEqual(["omp"]);
    expect(d.models[0]!.metrics.toolErrors.status).toBe("stable");
  });

  test("a slowdown and more tool errors in the last week are flagged, for the worse", () => {
    const d = drift(seed({ slowFrom: 7 }), {}, { now: NOW });
    const m = d.models[0]!.metrics;
    expect(m.speed).toMatchObject({ status: "changed", better: false });
    expect(m.speed.change!).toBeLessThan(-0.4);
    expect(m.toolErrors).toMatchObject({ status: "changed", better: false });
    expect(m.ttft.status).toBe("stable");
    expect(m.output.status).toBe("stable");
    expect(m.steps.status).toBe("stable");
    expect(m.toolErrors.recent).toBeCloseTo(25, 5);
  });

  test("failed model requests are a rate of their own: out of responses plus failures", () => {
    const steady = drift(seed({ apiErrors: () => 1 }), {}, { now: NOW }).models[0]!.metrics.apiErrors;
    expect(steady.status).toBe("stable");
    expect(steady.baseline).toBeCloseTo((1 / 21) * 100, 5);

    // One failure a day, then five a day in the last week: far outside the spread, and more than 20% up.
    const d = drift(seed({ apiErrors: (day) => (day < 7 ? 5 : 1) }), {}, { now: NOW });
    const m = d.models[0]!.metrics;
    expect(m.apiErrors).toMatchObject({ status: "changed", better: false, recentN: 7 * 25 });
    expect(m.apiErrors.recent).toBeCloseTo((5 / 25) * 100, 5);
    expect(m.toolErrors.status).toBe("stable");
    const series = d.series.find((s) => s.key === "apiErrors")!;
    expect(series.providers).toEqual(["omp"]);
    expect(series.counts.at(-1)).toBe(25);
  });

  test("a small move in the API error rate is not flagged", () => {
    // Two failures more over a week of 140 responses: within what chance gives.
    const d = drift(seed({ apiErrors: (day) => (day === 0 || day === 3 ? 2 : 1) }), {}, { now: NOW });
    expect(d.models[0]!.metrics.apiErrors.status).toBe("stable");
  });

  test("Claude Code's own <synthetic> messages are no model", () => {
    const db = seed();
    const w = new DbWriter(db, new PriceBook(), ID);
    for (let i = 0; i < 100; i++) {
      const ts = NOW - (i % 30) * DAY - 3_600_000;
      w.usage({ id: `syn:${i}`, provider: "claude", sessionId: "claude:s9", promptId: null, ts, project: "/work/alpha", model: "<synthetic>", skill: null, agent: "main", isSubagent: false, input: 0, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 });
    }
    const d = drift(db, {}, { now: NOW });
    expect(d.models.map((m) => m.model)).toEqual(["gpt-6"]);
    expect(drift(db, {}, { now: NOW, model: "<synthetic>" }).series.every((s) => s.counts.every((n) => n === 0))).toBe(true);
  });

  test("too little data is not judged", () => {
    const db = seed({ slowFrom: 7 });
    const d = drift(db, {}, { now: NOW + 30 * DAY }); // nothing recent
    expect(Object.values(d.models[0]!.metrics).every((c) => c.status === "insufficient")).toBe(true);
    const s = drift(db, {}, { now: NOW + 30 * DAY, model: "gpt-6" }).series.find((x) => x.key === "speed")!;
    expect(s.comparison.status).toBe("insufficient");
  });

  test("the effort filter applies to responses and outcomes, and lists the levels seen", () => {
    const db = seed({ effort: "high" });
    expect(drift(db, {}, { now: NOW }).efforts).toEqual(["high"]);
    const none = drift(db, {}, { now: NOW, model: "gpt-6", effort: "low" });
    expect(none.models).toEqual([]);
    expect(none.series.every((s) => s.counts.every((n) => n === 0))).toBe(true);
  });

  test("the charts cover the two compared windows, whatever the range's start", () => {
    const d = drift(seed(), { from: NOW - 10 * DAY, to: NOW }, { now: NOW });
    expect(d.days).toHaveLength(35);
    expect(d.days[0]! < d.days[28]!).toBe(true);
    const speed = d.series.find((s) => s.key === "speed")!;
    expect(speed.values.every((v) => v != null && v > 40 && v < 55)).toBe(true);
    expect(speed.counts.every((n) => n === 20)).toBe(true);
  });
});
