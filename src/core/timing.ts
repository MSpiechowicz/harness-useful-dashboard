import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { median } from "./drift.ts";
import { type Bucket, fillBuckets, type Filters, projectLabel, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/** A response that took longer than this was not timed reliably (a log written long after): it is left out. */
const MAX_RESPONSE_MS = 30 * 60_000;

interface Response {
  root: string;
  project: string | null;
  model: string | null;
  effort: string | null;
  start: number;
  end: number;
  ttft: number | null;
  cost: number;
}

/** Joins overlapping spans. `spans` must be sorted by start. */
export function mergeSpans(spans: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const length = (spans: [number, number][]) => spans.reduce((a, [s, e]) => a + e - s, 0);

/** The most spans open at once, and when that first happened. */
export function peakOverlap(spans: readonly (readonly [number, number])[]): { peak: number; at: number | null } {
  const events: [number, number][] = [];
  for (const [s, e] of spans) events.push([s, 1], [e, -1]);
  // Ends before starts at the same moment: back-to-back spans don't overlap.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let peak = 0;
  let at: number | null = null;
  for (const [ts, d] of events) {
    open += d;
    if (open > peak) {
      peak = open;
      at = ts;
    }
  }
  return { peak, at };
}

/** The bucket a moment falls in, keyed like the SQL buckets (local time, weeks starting on Monday). */
export function bucketKey(ts: number, bucket: Bucket): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (bucket === "week") d.setDate(d.getDate() + ((7 - d.getDay()) % 7) - 6);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (bucket === "hour") return `${day} ${pad(d.getHours())}:00`;
  if (bucket === "month") return day.slice(0, 7);
  return day;
}

/** Time with 1, 2, or 3 and more of the spans open at once, per bucket of where each stretch starts. */
export function overlapByBucket(spans: readonly (readonly [number, number])[], keyOf: (ts: number) => string): Map<string, [number, number, number]> {
  const events: [number, number][] = [];
  for (const [s, e] of spans) events.push([s, 1], [e, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = new Map<string, [number, number, number]>();
  let open = 0;
  for (let i = 0; i < events.length; i++) {
    open += events[i]![1];
    const next = events[i + 1];
    if (!next || open <= 0 || next[0] === events[i]![0]) continue;
    const key = keyOf(events[i]![0]);
    const parts = out.get(key) ?? [0, 0, 0];
    parts[Math.min(open, 3) - 1]! += next[0] - events[i]![0];
    out.set(key, parts);
  }
  return out;
}

/** Groups items by a key and merges each group's spans. */
function spansBy(rows: Response[], key: (r: Response) => string): Map<string, [number, number][]> {
  const groups = new Map<string, [number, number][]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k) ?? [];
    g.push([r.start, r.end]);
    groups.set(k, g);
  }
  for (const [k, g] of groups) groups.set(k, mergeSpans(g));
  return groups;
}

/**
 * How long the agents worked for you: the hours at least one session was working (agent time), how much of it several
 * sessions ran at once, and per model, project and effort level how long the responses took. Only responses whose
 * harness logs when they started and ended count.
 */
export function timing(db: Database, f: Filters, bucket: Bucket) {
  // Every timed response in the range is read: kept until the data changes.
  return memo(db, `timing:${bucket}:${JSON.stringify(f)}`, () => computeTiming(db, f, bucket));
}

function computeTiming(db: Database, f: Filters, bucket: Bucket) {
  const w = whereClause(f);
  const cond = `m.start_ts IS NOT NULL AND m.end_ts > m.start_ts AND m.end_ts - m.start_ts <= ${MAX_RESPONSE_MS}`;
  const rows = db
    .query<Response, Params>(
      `SELECT COALESCE(s.parent_session_id, u.session_id) AS root, u.project, u.model, m.effort,
              m.start_ts AS start, m.end_ts AS end, m.ttft_ms AS ttft, u.cost_usd AS cost
       FROM usage u JOIN response_meta m ON m.usage_id = u.id LEFT JOIN sessions s ON s.id = u.session_id
       ${w.sql ? `${w.sql} AND` : "WHERE"} ${cond}
       ORDER BY m.start_ts`,
    )
    .all(w.params);
  const responses = db.query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM usage u ${w.sql}`).get(w.params)!.n;

  const active = mergeSpans(rows.map((r) => [r.start, r.end]));
  const activeMs = length(active);
  const sessions = spansBy(rows, (r) => r.root);
  const peak = peakOverlap([...sessions.values()].flat());
  const cost = rows.reduce((a, r) => a + r.cost, 0);

  // A session's own spans are merged first: its subagents working beside it are not a second session.
  const overlap = overlapByBucket([...sessions.values()].flat(), (ts) => bucketKey(ts, bucket));
  const buckets = fillBuckets([...overlap.keys()], bucket, f);
  const series = buckets.map((b) => {
    const [one, two, more] = overlap.get(b) ?? [0, 0, 0];
    return { bucket: b, one, two, more };
  });
  const parallelMs = series.reduce((a, x) => a + x.two + x.more, 0);

  const models = new Map<string, { durations: number[]; ttfts: number[]; modelMs: number; cost: number }>();
  for (const r of rows) {
    const k = r.model ?? "(none)";
    const m = models.get(k) ?? { durations: [], ttfts: [], modelMs: 0, cost: 0 };
    m.durations.push(r.end - r.start);
    if (r.ttft != null) m.ttfts.push(r.ttft);
    m.modelMs += r.end - r.start;
    m.cost += r.cost;
    models.set(k, m);
  }

  const projectSpans = spansBy(rows, (r) => r.project ?? "(none)");
  const projects = new Map<string, { cost: number; sessions: Set<string> }>();
  for (const r of rows) {
    const k = r.project ?? "(none)";
    const p = projects.get(k) ?? { cost: 0, sessions: new Set() };
    p.cost += r.cost;
    p.sessions.add(r.root);
    projects.set(k, p);
  }

  const efforts = new Map<string, number>();
  for (const r of rows) efforts.set(r.effort ?? "(none)", (efforts.get(r.effort ?? "(none)") ?? 0) + r.end - r.start);

  return {
    totals: {
      activeMs,
      /** Agent time with two or more sessions working at once. */
      parallelMs,
      peakSessions: peak.peak,
      peakAt: peak.at,
      timed: rows.length,
      responses,
      cost,
      costPerHour: activeMs ? cost / (activeMs / 3_600_000) : null,
      activeBuckets: series.filter((x) => x.one + x.two + x.more > 0).length,
    },
    buckets,
    series,
    models: [...models]
      .map(([key, m]) => ({ key, responses: m.durations.length, modelMs: m.modelMs, cost: m.cost, medianMs: median(m.durations), medianTtftMs: median(m.ttfts) }))
      .sort((a, b) => b.modelMs - a.modelMs),
    projects: [...projects]
      .map(([key, p]) => ({ key, label: projectLabel(key === "(none)" ? null : key), activeMs: length(projectSpans.get(key)!), cost: p.cost, sessions: p.sessions.size }))
      .sort((a, b) => b.activeMs - a.activeMs),
    efforts: [...efforts].map(([key, ms]) => ({ key, ms })).sort((a, b) => b.ms - a.ms),
  };
}
