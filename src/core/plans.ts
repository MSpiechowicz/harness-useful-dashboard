import type { Database, Statement } from "bun:sqlite";
import { type LimitReport, planFor } from "./limits.ts";
import { type Bucket, bucketExpr, fillBuckets, type Filters, whereClause } from "./queries.ts";

/** Readings closer together than this share a slot: the later one replaces the earlier. */
const SLOT_MS = 5 * 60_000;
const DAY = 86_400_000;
/** A window counts as run out once this much of it was used. */
const FULL = 0.995;

export interface LimitReading {
  reportKey: string;
  provider: string;
  plan: string | null;
  windowId: string;
  windowMs: number | null;
  scope?: string | null;
  label?: string | null;
  usedFraction: number;
  resetsAt: number | null;
  observedAt: number;
}

/** Prepares the statement that keeps a limit reading in the history, one per window and slot. */
export function readingStatement(db: Database): Statement {
  return db.prepare(`
    INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, scope, label, used_fraction, resets_at, observed_at)
    VALUES ($host, $reportKey, $windowId, $slot, $provider, $plan, $windowMs, $scope, $label, $usedFraction, $resetsAt, $observedAt)
    ON CONFLICT(host, report_key, window_id, slot) DO UPDATE SET
      provider = excluded.provider, plan = excluded.plan, window_ms = excluded.window_ms, scope = excluded.scope,
      label = excluded.label, used_fraction = excluded.used_fraction, resets_at = excluded.resets_at, observed_at = excluded.observed_at
    WHERE excluded.observed_at >= limit_readings.observed_at
  `);
}

export function readingParams(host: string, r: LimitReading) {
  return {
    host,
    reportKey: r.reportKey,
    windowId: r.windowId,
    slot: Math.floor(r.observedAt / SLOT_MS),
    provider: r.provider,
    plan: r.plan,
    windowMs: r.windowMs,
    scope: r.scope ?? null,
    label: r.label ?? null,
    usedFraction: r.usedFraction,
    resetsAt: r.resetsAt,
    observedAt: r.observedAt,
  };
}

/** Keeps the windows of fresh limit reports in the history. Windows that have reset since carry no reading. */
export function recordReports(db: Database, host: string, reports: LimitReport[]): void {
  const st = readingStatement(db);
  db.transaction(() => {
    for (const r of reports) {
      for (const w of r.windows) {
        if (w.reset) continue;
        st.run(readingParams(host, { reportKey: r.key, provider: r.provider, plan: r.plan, windowId: w.id, windowMs: w.windowMs, scope: w.scope, label: w.label, usedFraction: w.usedFraction, resetsAt: w.resetsAt, observedAt: r.observedAt }));
      }
    }
  })();
}

/**
 * The windows readings fall into, oldest first. A window ends when its reset time passes or its use drops back (it
 * reset early). Readings at 0% belong to no window: an idle Codex window reports its reset as a full length from now,
 * moving with every reading, so it only counts once something used it.
 */
export function cycles(readings: { used: number; resetsAt: number | null; ts: number }[]): PlanCycle[] {
  const out: PlanCycle[] = [];
  let cur: (PlanCycle & { last: number; resetsAt: number | null }) | null = null;
  for (const r of readings) {
    if (r.used <= 0) continue;
    const reset = cur && ((cur.resetsAt != null && r.ts >= cur.resetsAt) || r.used < cur.last - 0.05);
    if (!cur || reset) {
      if (cur) out.push({ end: cur.end, peak: cur.peak });
      cur = { end: r.resetsAt ?? r.ts, peak: 0, last: 0, resetsAt: r.resetsAt };
    }
    cur.peak = Math.max(cur.peak, r.used);
    cur.last = r.used;
    if (r.resetsAt != null) cur.resetsAt = r.resetsAt;
    cur.end = cur.resetsAt ?? r.ts;
  }
  if (cur) out.push({ end: cur.end, peak: cur.peak });
  return out;
}

export interface PlanCycle {
  /** When the cycle reset (or the last reading, when the reset isn't known), epoch ms. */
  end: number;
  peak: number;
}

export interface LimitHistory {
  key: string;
  reportKey: string;
  provider: string;
  plan: string | null;
  windowId: string;
  windowMs: number | null;
  scope: string | null;
  label: string | null;
  /** [observed at, used fraction], oldest first. */
  points: [number, number][];
  cycles: PlanCycle[];
  /** Cycles in which the window ran out. */
  hits: number;
}

/**
 * How full each limit window got in the range: every reading, and per cycle (one reset to the next) the highest
 * reading. Several machines on one shared database read the same account: per slot the highest reading counts.
 */
export function limitHistory(db: Database, f: Filters): LimitHistory[] {
  const rows = db
    .query<{ reportKey: string; provider: string; plan: string | null; windowId: string; windowMs: number | null; scope: string | null; label: string | null; slot: number; used: number; resetsAt: number | null; ts: number }, { from: number; to: number }>(
      `SELECT report_key AS reportKey, MAX(provider) AS provider, MAX(plan) AS plan, window_id AS windowId, MAX(window_ms) AS windowMs,
              MAX(scope) AS scope, MAX(label) AS label, slot, MAX(used_fraction) AS used, MAX(resets_at) AS resetsAt, MAX(observed_at) AS ts
       FROM limit_readings WHERE observed_at >= $from AND observed_at < $to
       GROUP BY report_key, window_id, slot ORDER BY report_key, window_id, slot`,
    )
    .all({ from: f.from ?? 0, to: f.to ?? Number.MAX_SAFE_INTEGER });
  const out = new Map<string, LimitHistory>();
  for (const r of rows) {
    const key = `${r.reportKey}|${r.windowId}`;
    let h = out.get(key);
    if (!h) {
      h = { key, reportKey: r.reportKey, provider: r.provider, plan: r.plan, windowId: r.windowId, windowMs: r.windowMs, scope: r.scope, label: r.label, points: [], cycles: [], hits: 0 };
      out.set(key, h);
    }
    h.plan = r.plan ?? h.plan;
    h.points.push([r.ts, r.used]);
  }
  for (const h of out.values()) {
    h.cycles = cycles(rows.filter((r) => `${r.reportKey}|${r.windowId}` === h.key));
    h.hits = h.cycles.filter((c) => c.peak >= FULL).length;
  }
  // Shortest window first within a plan, plans in a stable order.
  return [...out.values()].sort((a, b) => a.reportKey.localeCompare(b.reportKey) || (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity) || a.windowId.localeCompare(b.windowId));
}

export interface PlanValueRow {
  /** The plan: "claude", "codex", "copilot", or what else the usage was billed through. */
  key: string;
  /** The harnesses that used it. */
  providers: string[];
  calls: number;
  tokens: number;
  cost: number;
  premiumRequests: number;
  firstTs: number;
  lastTs: number;
  /** The monthly price set for it, if any. */
  price: number | null;
  /** Days of the range the plan was paid for: from its first use, or the range start, to the range end. */
  days: number;
  /** What the price comes to over those days. */
  paid: number | null;
}

/** The plan usage counts against, as the limits see it, so a ChatGPT plan used from Codex and from omp is one plan. */
function planKey(provider: string, billing: string | null): string {
  return planFor(provider, billing)?.provider ?? billing ?? provider;
}

/**
 * What each plan or account was worth: the API-equivalent cost of the usage that ran on it, against what it costs a
 * month (set by the user).
 */
export function planValue(db: Database, f: Filters, bucket: Bucket, prices: Record<string, number>, now = Date.now()) {
  const w = whereClause(f);
  const cells = db
    .query<{ bucket: string; provider: string; billing: string | null; calls: number; tokens: number; cost: number; premiumRequests: number; firstTs: number; lastTs: number }, Record<string, string | number>>(
      `SELECT ${bucketExpr(bucket)} AS bucket, u.provider, u.billing, COUNT(*) AS calls, COALESCE(SUM(u.total_tokens), 0) AS tokens,
              COALESCE(SUM(u.cost_usd), 0) AS cost, COALESCE(SUM(u.premium_requests), 0) AS premiumRequests, MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
       FROM usage u ${w.sql} GROUP BY bucket, u.provider, u.billing ORDER BY bucket`,
    )
    .all(w.params as Record<string, string | number>);
  const end = Math.min(f.to ?? now, now);
  const plans = new Map<string, PlanValueRow>();
  const at = new Map<string, number>();
  for (const c of cells) {
    const key = planKey(c.provider, c.billing);
    const p = plans.get(key) ?? { key, providers: [], calls: 0, tokens: 0, cost: 0, premiumRequests: 0, firstTs: c.firstTs, lastTs: c.lastTs, price: null, days: 0, paid: null };
    if (!p.providers.includes(c.provider)) p.providers.push(c.provider);
    p.calls += c.calls;
    p.tokens += c.tokens;
    p.cost += c.cost;
    p.premiumRequests += c.premiumRequests;
    p.firstTs = Math.min(p.firstTs, c.firstTs);
    p.lastTs = Math.max(p.lastTs, c.lastTs);
    plans.set(key, p);
    at.set(`${c.bucket}|${key}`, (at.get(`${c.bucket}|${key}`) ?? 0) + c.cost);
  }
  const rows = [...plans.values()]
    .map((p) => {
      const price = prices[p.key] ?? null;
      const days = Math.max(1, Math.ceil((end - Math.max(f.from ?? p.firstTs, p.firstTs)) / DAY));
      return { ...p, price, days, paid: price != null ? (price * days) / (365.25 / 12) : null };
    })
    .sort((a, b) => b.cost - a.cost);
  const buckets = fillBuckets(cells.map((c) => c.bucket), bucket, f);
  const series = rows.map((p) => ({ key: p.key, name: p.key, data: buckets.map((bk) => at.get(`${bk}|${p.key}`) ?? 0) }));
  return { plans: rows, buckets, series };
}
