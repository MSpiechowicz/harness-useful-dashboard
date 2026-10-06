import type { Database } from "bun:sqlite";
import { type Filters, whereClause } from "./queries.ts";

/**
 * Model drift: each model's recent behaviour against its own baseline. Every metric is measured per response, tool
 * call or prompt, so a change in how much was done does not read as a change in the model. A metric is flagged when
 * the recent window falls outside the range its days usually spread over in the baseline.
 */
export type DriftMetric = "speed" | "ttft" | "toolErrors" | "interrupts" | "steps" | "output";
export const DRIFT_METRICS: DriftMetric[] = ["speed", "ttft", "toolErrors", "interrupts", "steps", "output"];

const DAY = 86_400_000;
export const RECENT_DAYS = 7;
export const BASELINE_DAYS = 28;
/** Responses, tool calls or prompts each window needs before a metric is judged. */
export const MIN_SAMPLES = 50;
/** Baseline days with data needed to know a metric's usual spread. */
const MIN_BASELINE_DAYS = 7;
/** Samples a day needs to count toward the usual spread. */
const MIN_DAY_SAMPLES = 5;
/** The usual range is the baseline's median day ± this many (scaled) median absolute deviations. */
const BAND_MADS = 3;
/** Output a response needs for its speed to count, so the wait for the first token doesn't dominate. */
const MIN_SPEED_OUTPUT = 200;
/** Longer spans are a stalled or resumed session, not a response. */
const MAX_RESPONSE_MS = 15 * 60_000;

/** Which direction is better, or null when neither is. */
const HIGHER_IS_BETTER: Record<DriftMetric, boolean | null> = {
  speed: true,
  ttft: false,
  toolErrors: false,
  interrupts: false,
  steps: null,
  output: null,
};

export type DriftStatus = "stable" | "changed" | "insufficient";

export interface DriftComparison {
  recent: number | null;
  baseline: number | null;
  recentN: number;
  baselineN: number;
  /** Relative change of recent against baseline (0.1 = 10% higher). */
  change: number | null;
  status: DriftStatus;
  /** Whether the change is for the better, null when it isn't flagged or has no better direction. */
  better: boolean | null;
  band: { lo: number; mid: number; hi: number } | null;
}

export interface DriftSeries {
  key: DriftMetric;
  values: (number | null)[];
  counts: number[];
  comparison: DriftComparison;
  /** Providers whose logs feed this metric for the model. */
  providers: string[];
}

export interface DriftModelRow {
  model: string;
  provider: string;
  responses: number;
  metrics: Record<DriftMetric, DriftComparison>;
}

export interface Drift {
  window: { baselineFrom: number; recentFrom: number; to: number; recentDays: number; baselineDays: number; minSamples: number };
  models: DriftModelRow[];
  model: string | null;
  effort: string | null;
  efforts: string[];
  days: string[];
  series: DriftSeries[];
  versions: { day: string; label: string }[];
}

interface ResponseRow {
  ts: number;
  model: string;
  provider: string;
  prompt_id: string | null;
  agent: string;
  output_tokens: number;
  start_ts: number | null;
  end_ts: number | null;
  ttft_ms: number | null;
}

interface OutcomeRow {
  ts: number;
  model: string;
  provider: string;
  kind: string;
}

/** Samples of one metric, by local day: values for a median, or a numerator and denominator for a rate. */
type Samples = { kind: "median"; days: Map<string, number[]> } | { kind: "rate"; scale: number; days: Map<string, { num: number; den: number }> };

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median ± BAND_MADS scaled median absolute deviations, with a floor so a flat baseline still has some width. */
export function usualRange(daily: number[]): { lo: number; mid: number; hi: number } | null {
  const mid = median(daily);
  if (mid == null) return null;
  const mad = median(daily.map((v) => Math.abs(v - mid)))! * 1.4826;
  const half = Math.max(BAND_MADS * mad, Math.abs(mid) * 0.05);
  return { lo: Math.max(0, mid - half), mid, hi: mid + half };
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayList(from: number, to: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  const last = dayKey(to - 1);
  for (let i = 0; i < 4000; i++) {
    const k = dayKey(d.getTime());
    out.push(k);
    if (k >= last) break;
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function windowValue(s: Samples, inWindow: (day: string) => boolean): { value: number | null; n: number } {
  if (s.kind === "median") {
    const all: number[] = [];
    for (const [day, v] of s.days) if (inWindow(day)) all.push(...v);
    return { value: median(all), n: all.length };
  }
  let num = 0;
  let den = 0;
  for (const [day, v] of s.days) {
    if (!inWindow(day)) continue;
    num += v.num;
    den += v.den;
  }
  return { value: den ? (num / den) * s.scale : null, n: den };
}

function dayValue(s: Samples, day: string): { value: number | null; n: number } {
  if (s.kind === "median") {
    const v = s.days.get(day) ?? [];
    return { value: median(v), n: v.length };
  }
  const v = s.days.get(day);
  return { value: v?.den ? (v.num / v.den) * s.scale : null, n: v?.den ?? 0 };
}

export function compare(s: Samples, metric: DriftMetric, recentDays: Set<string>, baselineDays: Set<string>): DriftComparison {
  const recent = windowValue(s, (d) => recentDays.has(d));
  const baseline = windowValue(s, (d) => baselineDays.has(d));
  const daily = [...baselineDays].map((d) => dayValue(s, d)).filter((d) => d.value != null && d.n >= MIN_DAY_SAMPLES).map((d) => d.value!);
  const band = daily.length >= MIN_BASELINE_DAYS ? usualRange(daily) : null;
  const enough = recent.n >= MIN_SAMPLES && baseline.n >= MIN_SAMPLES && band != null && recent.value != null;
  const changed = enough && (recent.value! < band!.lo || recent.value! > band!.hi);
  const change = recent.value != null && baseline.value ? (recent.value - baseline.value) / baseline.value : null;
  const dir = HIGHER_IS_BETTER[metric];
  return {
    recent: recent.value,
    baseline: baseline.value,
    recentN: recent.n,
    baselineN: baseline.n,
    change,
    status: !enough ? "insufficient" : changed ? "changed" : "stable",
    better: changed && dir != null && baseline.value != null ? recent.value! > baseline.value === dir : null,
    band,
  };
}

function pushTo(days: Map<string, number[]>, day: string, v: number): void {
  const arr = days.get(day);
  if (arr) arr.push(v);
  else days.set(day, [v]);
}

function addRate(days: Map<string, { num: number; den: number }>, day: string, num: number, den: number): void {
  const cur = days.get(day) ?? { num: 0, den: 0 };
  cur.num += num;
  cur.den += den;
  days.set(day, cur);
}

/** Every metric's samples for one model, and the providers behind each. */
function samplesFor(responses: ResponseRow[], outcomes: OutcomeRow[]): { samples: Record<DriftMetric, Samples>; providers: Record<DriftMetric, Set<string>> } {
  const median = (): Samples => ({ kind: "median", days: new Map() });
  const samples: Record<DriftMetric, Samples> = {
    speed: median(),
    ttft: median(),
    output: median(),
    steps: median(),
    toolErrors: { kind: "rate", scale: 100, days: new Map() },
    interrupts: { kind: "rate", scale: 100, days: new Map() },
  };
  const providers = Object.fromEntries(DRIFT_METRICS.map((m) => [m, new Set<string>()])) as Record<DriftMetric, Set<string>>;
  const values = (m: DriftMetric) => (samples[m] as { days: Map<string, number[]> }).days;
  const rates = (m: DriftMetric) => (samples[m] as { days: Map<string, { num: number; den: number }> }).days;

  const prompts = new Map<string, { day: string; steps: number; provider: string }>();
  for (const r of responses) {
    const day = dayKey(r.ts);
    if (r.output_tokens > 0) {
      pushTo(values("output"), day, r.output_tokens);
      providers.output.add(r.provider);
    }
    const span = r.start_ts != null && r.end_ts != null ? r.end_ts - r.start_ts : null;
    if (span != null && span > 0 && span <= MAX_RESPONSE_MS && r.output_tokens >= MIN_SPEED_OUTPUT) {
      pushTo(values("speed"), day, r.output_tokens / (span / 1000));
      providers.speed.add(r.provider);
    }
    if (r.ttft_ms != null && r.ttft_ms > 0) {
      pushTo(values("ttft"), day, r.ttft_ms / 1000);
      providers.ttft.add(r.provider);
    }
    if (r.agent === "main" && r.prompt_id) {
      const p = prompts.get(r.prompt_id);
      if (p) p.steps++;
      else prompts.set(r.prompt_id, { day, steps: 1, provider: r.provider });
    }
  }
  for (const p of prompts.values()) {
    pushTo(values("steps"), p.day, p.steps);
    providers.steps.add(p.provider);
    addRate(rates("interrupts"), p.day, 0, 1);
  }
  for (const o of outcomes) {
    const day = dayKey(o.ts);
    if (o.kind === "interrupt") {
      addRate(rates("interrupts"), day, 1, 0);
      providers.interrupts.add(o.provider);
    } else if (o.kind === "tool_ok" || o.kind === "tool_error") {
      addRate(rates("toolErrors"), day, o.kind === "tool_error" ? 1 : 0, 1);
      providers.toolErrors.add(o.provider);
    }
  }
  return { samples, providers };
}

function groupBy<T extends { model: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const arr = out.get(r.model);
    if (arr) arr.push(r);
    else out.set(r.model, [r]);
  }
  return out;
}

export function drift(db: Database, f: Filters, opts: { model?: string | null; effort?: string | null; now?: number } = {}): Drift {
  const to = f.to ?? opts.now ?? Date.now();
  // Whole local days: the recent window ends with the range's last day, the baseline is the days before it.
  const dayStart = (daysBack: number) => {
    const d = new Date(to - 1);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysBack);
    return d.getTime();
  };
  const recentFrom = dayStart(RECENT_DAYS - 1);
  const baselineFrom = dayStart(RECENT_DAYS + BASELINE_DAYS - 1);
  const chartFrom = Math.max(f.from ?? baselineFrom, to - 400 * DAY);
  const from = Math.min(chartFrom, baselineFrom);
  const effort = opts.effort || null;

  // The model is chosen on this page. Outcomes carry no skill, so that filter applies to responses only.
  const scope: Filters = { ...f, from, to, model: undefined };
  const u = whereClause(scope, "u");
  const uWhere = `${u.sql ? `${u.sql} AND` : "WHERE"} u.model IS NOT NULL${effort ? " AND m.effort = $effort" : ""}`;
  const responses = db
    .query<ResponseRow, any>(
      `SELECT u.ts, u.model, u.provider, u.prompt_id, u.agent, u.output_tokens, m.start_ts, m.end_ts, m.ttft_ms
       FROM usage u LEFT JOIN response_meta m ON m.usage_id = u.id ${uWhere}`,
    )
    .all({ ...u.params, ...(effort ? { effort } : {}) });
  const o = whereClause({ ...scope, skill: undefined }, "o");
  const oWhere = `${o.sql ? `${o.sql} AND` : "WHERE"} o.model IS NOT NULL${effort ? " AND o.effort = $effort" : ""}`;
  const outcomes = db
    .query<OutcomeRow, any>(`SELECT o.ts, o.model, o.provider, o.kind FROM outcomes o ${oWhere}`)
    .all({ ...o.params, ...(effort ? { effort } : {}) });

  const recentDays = new Set(dayList(recentFrom, to));
  const baselineDays = new Set(dayList(baselineFrom, recentFrom));
  const inWindow = (ts: number) => ts >= baselineFrom;
  const byModel = groupBy(responses.filter((r) => inWindow(r.ts)));
  const outcomesByModel = groupBy(outcomes.filter((r) => inWindow(r.ts)));

  const models: DriftModelRow[] = [];
  for (const [model, rows] of byModel) {
    if (rows.length < MIN_SAMPLES) continue;
    const { samples } = samplesFor(rows, outcomesByModel.get(model) ?? []);
    const providerCount = new Map<string, number>();
    for (const r of rows) providerCount.set(r.provider, (providerCount.get(r.provider) ?? 0) + 1);
    models.push({
      model,
      provider: [...providerCount].sort((a, b) => b[1] - a[1])[0]![0],
      responses: rows.length,
      metrics: Object.fromEntries(DRIFT_METRICS.map((m) => [m, compare(samples[m], m, recentDays, baselineDays)])) as Record<DriftMetric, DriftComparison>,
    });
  }
  models.sort((a, b) => b.responses - a.responses);

  const model = opts.model || f.model || models[0]?.model || null;
  const days = dayList(chartFrom, to);
  let series: DriftSeries[] = [];
  let efforts: string[] = [];
  let versions: Drift["versions"] = [];
  if (model) {
    const mine = responses.filter((r) => r.model === model);
    const { samples, providers } = samplesFor(mine, outcomes.filter((r) => r.model === model));
    series = DRIFT_METRICS.map((key) => ({
      key,
      values: days.map((d) => dayValue(samples[key], d).value),
      counts: days.map((d) => dayValue(samples[key], d).n),
      comparison: compare(samples[key], key, recentDays, baselineDays),
      providers: [...providers[key]].sort(),
    }));
    const uAll = whereClause({ ...scope, from: baselineFrom }, "u");
    efforts = db
      .query<{ effort: string }, any>(
        `SELECT DISTINCT m.effort FROM usage u JOIN response_meta m ON m.usage_id = u.id ${uAll.sql ? `${uAll.sql} AND` : "WHERE"} u.model = $model AND m.effort IS NOT NULL ORDER BY 1`,
      )
      .all({ ...uAll.params, model })
      .map((r) => r.effort);
    // The first day each client version answered with this model: harness updates, marked on the charts.
    const firstDay = new Set(days);
    versions = db
      .query<{ client: string | null; version: string; first: number }, [string]>(
        `SELECT s.client, s.client_version AS version, MIN(u.ts) AS first FROM usage u JOIN sessions s ON s.id = u.session_id
         WHERE u.model = ? AND s.client_version IS NOT NULL GROUP BY s.client, s.client_version ORDER BY first`,
      )
      .all(model)
      .map((v) => ({ day: dayKey(v.first), label: `${v.client ?? ""} ${v.version}`.trim() }))
      .filter((v) => firstDay.has(v.day) && v.day !== days[0])
      .slice(-15);
  }

  return {
    window: { baselineFrom, recentFrom, to, recentDays: RECENT_DAYS, baselineDays: BASELINE_DAYS, minSamples: MIN_SAMPLES },
    models,
    model,
    effort,
    efforts,
    days,
    series,
    versions,
  };
}
