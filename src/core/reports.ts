import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type BudgetConfig, budgetStatus } from "./budgets.ts";
import { openDb } from "./db.ts";
import { codexLimits } from "./limits.ts";
import { PriceBook } from "./pricing.ts";
import { type Dimension, type Filters, Queries } from "./queries.ts";
import { tagUsage } from "./tagUsage.ts";
import { LIMIT_FRESH_MS, type LimitInfo, storedFiveHour } from "./statusline.ts";

/**
 * Read-only usage reports shared by the MCP tools and the `today`, `report` and `limits` commands: time ranges and
 * filters as both take them, the latest plan-limit readings and how the budgets stand. Times are ISO 8601, money is
 * USD at API-equivalent list prices.
 */

/** A request that can't be answered as asked: a bad range or filter, or no database. Shown as it is. */
export class InputError extends Error {}

const DAY = 86_400_000;

export const iso = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
export const usd = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10_000) / 10_000);
export const ratio = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);

/** The database opened read-only, with its prices and queries. Nothing is created when it is missing. */
export function openReadOnly(path: string): { db: Database; queries: Queries; prices: PriceBook } {
  // openDb would create the folder: a missing database is reported instead, and nothing is written.
  if (!existsSync(path)) throw new InputError(`No usage database at ${path}. Run harness-dashboard once to scan the local logs, or pass --db <path>.`);
  let db: Database;
  try {
    db = openDb(path, { readonly: true });
    db.exec("PRAGMA busy_timeout = 3000");
  } catch (e) {
    throw new InputError(`Could not open the usage database at ${path}: ${(e as Error).message}`);
  }
  const prices = PriceBook.fromDb(db);
  return { db, queries: new Queries(db, () => prices), prices };
}

// ---------------------------------------------------------------------------------------------------------------
// Ranges and filters

export const RANGES = ["today", "7d", "30d", "month", "all", "custom"] as const;
export type Range = (typeof RANGES)[number];

export interface ResolvedRange {
  name: Range;
  from?: number;
  to?: number;
}

/** Local midnight `daysBack` days before the day `t` falls in. */
export const dayStart = (t: number, daysBack = 0) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
};

function parseTime(v: unknown, name: string, end: boolean): number | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return new Date(y, m - 1, d + (end ? 1 : 0)).getTime();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new InputError(`${name} must be a date (YYYY-MM-DD) or an ISO 8601 time, got "${s}"`);
  return t;
}

/** `range`, `from` and `to` as the MCP tools and the commands take them, in local time. */
export function resolveRange(args: Record<string, unknown>, fallback: Range, now: number): ResolvedRange {
  const name = (args.range as Range | undefined) ?? fallback;
  switch (name) {
    case "today":
      return { name, from: dayStart(now) };
    case "7d":
      return { name, from: dayStart(now, 6) };
    case "30d":
      return { name, from: dayStart(now, 29) };
    case "month": {
      const d = new Date(now);
      return { name, from: new Date(d.getFullYear(), d.getMonth(), 1).getTime() };
    }
    case "all":
      return { name };
    case "custom": {
      const from = parseTime(args.from, "from", false);
      const to = parseTime(args.to, "to", true);
      if (from == null && to == null) throw new InputError("range custom needs from, to or both");
      if (from != null && to != null && to <= from) throw new InputError("to must be after from");
      return { name, from, to };
    }
    default:
      throw new InputError(`range must be one of ${RANGES.join(", ")}, got "${String(name)}"`);
  }
}

export const rangeOut = (r: ResolvedRange, now: number) => ({ name: r.name, from: iso(r.from), to: iso(r.to ?? now) });

/** A project named by its folder is looked up among the projects with usage. A path is taken as it is. */
export function resolveProject(q: Queries, value: string): string {
  if (/[\\/]/.test(value) || value === "(none)") return value.replace(/[\\/]+$/, "") || value;
  const all = q.filters({}).project;
  const hits = all.filter((p) => p.label.toLowerCase() === value.toLowerCase());
  if (hits.length === 1) return hits[0]!.value;
  if (hits.length > 1) throw new InputError(`Several projects are named ${value}: ${hits.map((h) => h.value).join(", ")}. Pass the path.`);
  const known = all.slice(0, 15).map((p) => p.label).join(", ");
  throw new InputError(`No project named ${value}. Projects by cost: ${known || "none yet"}.`);
}

export function filtersOf(q: Queries, args: Record<string, unknown>, range: ResolvedRange): Filters {
  const f: Filters = { from: range.from, to: range.to };
  if (typeof args.provider === "string" && args.provider) f.provider = args.provider;
  if (typeof args.model === "string" && args.model) f.model = args.model;
  if (typeof args.user === "string" && args.user) f.user = args.user;
  if (typeof args.project === "string" && args.project) f.project = resolveProject(q, args.project);
  if (typeof args.tag === "string" && args.tag.trim()) f.tag = args.tag.trim().toLowerCase();
  return f;
}

export const filtersOut = (f: Filters) => {
  const out: Record<string, string> = {};
  for (const k of ["provider", "project", "model", "user", "tag"] as const) if (f[k]) out[k] = f[k]!;
  return Object.keys(out).length ? out : undefined;
};

// ---------------------------------------------------------------------------------------------------------------
// Plan limits and budgets

export interface LimitWindow {
  provider: string;
  plan?: string;
  /** "5h", "7d", or the provider's own name for the window. */
  window: string;
  scope?: string;
  /** Null when the window reset after the reading: its use since is unknown. */
  usedPercent: number | null;
  resetsAt: string | null;
  observedAt: string | null;
  ageMinutes: number;
  status: "fresh" | "stale" | "reset since reading";
  /** Another machine's reading, from a shared database. */
  host?: string;
}

/** The latest stored reading of each plan-limit window from the last 30 days. Providers are never asked. */
export function limitWindows(db: Database, host: string, t: number): LimitWindow[] {
  type Reading = {
    host: string; reportKey: string; windowId: string; provider: string; plan: string | null; windowMs: number | null;
    scope: string | null; label: string | null; usedFraction: number; resetsAt: number | null; observedAt: number;
  };
  const rows = db
    .query<Reading, { from: number }>(
      `SELECT host, report_key AS reportKey, window_id AS windowId, provider, plan, window_ms AS windowMs, scope, label,
              used_fraction AS usedFraction, resets_at AS resetsAt, observed_at AS observedAt
       FROM limit_readings r
       WHERE observed_at >= $from
         AND observed_at = (SELECT MAX(x.observed_at) FROM limit_readings x WHERE x.host = r.host AND x.report_key = r.report_key AND x.window_id = r.window_id)`,
    )
    .all({ from: t - 30 * DAY });
  // Per window, this machine's reading first: a shared database also holds other machines' accounts.
  const latest = new Map<string, Reading>();
  for (const r of rows) {
    const key = `${r.reportKey}|${r.windowId}`;
    const had = latest.get(key);
    const mine = (x: Reading) => x.host === host;
    if (!had || (mine(r) && !mine(had)) || (mine(r) === mine(had) && r.observedAt > had.observedAt)) latest.set(key, r);
  }
  // Codex's own readings from its logs, stored while scanning, when newer than the history.
  const codex = codexLimits(db, host, t);
  for (const w of codex?.windows ?? []) {
    const key = `${codex!.key}|${w.id}`;
    const had = latest.get(key);
    if (!had || had.observedAt < codex!.observedAt) {
      latest.set(key, {
        host, reportKey: codex!.key, windowId: w.id, provider: "codex", plan: codex!.plan, windowMs: w.windowMs, scope: null, label: null,
        usedFraction: w.usedFraction, resetsAt: w.resetsAt, observedAt: codex!.observedAt,
      });
    }
  }
  const windowName = (r: Reading) => {
    if (r.windowMs == null) return r.label ?? r.windowId;
    const h = r.windowMs / 3_600_000;
    return h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`;
  };
  return [...latest.values()]
    .sort((a, b) => a.provider.localeCompare(b.provider) || (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity))
    .map((r) => {
      const reset = r.resetsAt != null && r.resetsAt <= t;
      return {
        provider: r.provider,
        plan: r.plan ?? undefined,
        window: windowName(r),
        scope: r.scope ?? undefined,
        usedPercent: reset ? null : Math.round(r.usedFraction * 1000) / 10,
        resetsAt: reset ? null : iso(r.resetsAt),
        observedAt: iso(r.observedAt),
        ageMinutes: Math.max(0, Math.round((t - r.observedAt) / 60_000)),
        status: reset ? "reset since reading" : t - r.observedAt > LIMIT_FRESH_MS ? "stale" : "fresh",
        host: r.host !== host ? r.host : undefined,
      };
    });
}

export interface BudgetRow {
  scope: "daily" | "monthly" | "project";
  project?: string;
  period: string;
  capUsd: number | null;
  spentUsd: number | null;
  usedPercent: number;
  remainingUsd: number | null;
  projectedUsd?: number | null;
  status: "ok" | "warning" | "over";
}

/** How each cap stands for `user`: today's and this month's spend, with the month's projected total. */
export function budgetRows(db: Database, cfg: BudgetConfig, user: string, now: number): BudgetRow[] {
  return budgetStatus(db, cfg, user, new Date(now)).map((b) => ({
    scope: b.scope,
    project: b.project ?? undefined,
    period: b.period,
    capUsd: usd(b.cap),
    spentUsd: usd(b.spent),
    usedPercent: Math.round(b.fraction * 1000) / 10,
    remainingUsd: usd(Math.max(0, b.cap - b.spent)),
    projectedUsd: b.projected == null ? undefined : usd(b.projected),
    status: b.fraction >= 1 ? "over" : b.fraction >= 0.8 ? "warning" : "ok",
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// The command-line reports

export interface ReportContext {
  db: Database;
  queries: Queries;
  budgets: BudgetConfig;
  /** This machine's user: budgets count this user's spend. */
  user: string;
  host: string;
  now: number;
}

type Summary = ReturnType<Queries["summary"]>;
const totalsOf = (s: Summary) => ({ costUsd: usd(s.cost), tokens: s.tokens, sessions: s.sessions, prompts: s.prompts, modelCalls: s.messages });
const change = (now: number, before: number) => (before ? ratio((now - before) / before) : null);

/** `today`: today so far against the whole of yesterday, the top projects and models, the budgets and Claude's 5-hour window. */
export function todayReport(c: ReportContext, args: Record<string, unknown> = {}) {
  const today = resolveRange({ range: "today" }, "today", c.now);
  const f = filtersOf(c.queries, args, today);
  const yesterday: Filters = { ...f, from: dayStart(c.now, 1), to: today.from };
  const t = c.queries.summary(f);
  const y = c.queries.summary(yesterday);
  const top = (dim: Dimension) =>
    c.queries.breakdown(f, dim, 3).rows.map((r) => ({ key: r.key, label: r.label, costUsd: usd(r.cost), share: ratio(r.share), tokens: r.tokens }));
  const limit: LimitInfo | null = storedFiveHour(c.db, c.host, c.now);
  return {
    date: localDate(c.now),
    filters: filtersOut(f),
    today: totalsOf(t),
    yesterday: totalsOf(y),
    change: { cost: change(t.cost, y.cost), tokens: change(t.tokens, y.tokens), sessions: change(t.sessions, y.sessions), prompts: change(t.prompts, y.prompts) },
    topProjects: top("project"),
    topModels: top("model"),
    budgets: budgetRows(c.db, c.budgets, c.user, c.now),
    claudeFiveHour: limit ? { usedPercent: Math.round(limit.usedFraction * 1000) / 10, resetsAt: iso(limit.resetsAt) } : null,
  };
}

export type TodayReport = ReturnType<typeof todayReport>;

export const REPORT_BY = ["project", "model", "provider", "user", "tag", "day", "week", "month"] as const;
export type ReportBy = (typeof REPORT_BY)[number];

/**
 * `report`: a breakdown (project, model, provider, user, tag) or a time series (day, week, month) for a range. Rows keep
 * the dashboard's own field names, as its table export does.
 */
export function usageReport(c: ReportContext, args: Record<string, unknown>) {
  const by = (args.by ?? "project") as ReportBy;
  if (!REPORT_BY.includes(by)) throw new InputError(`by must be one of ${REPORT_BY.join(", ")}, got "${String(by)}"`);
  const range = resolveRange(args, args.from != null || args.to != null ? "custom" : "30d", c.now);
  const f = filtersOf(c.queries, args, range);
  const s = c.queries.summary(f);
  const total = { cost: s.cost, tokens: s.tokens, messages: s.messages, sessions: s.sessions, prompts: s.prompts };
  let rows: Record<string, unknown>[];
  if (by === "day" || by === "week" || by === "month") {
    rows = c.queries.periods(f, by).map((r) => ({ ...r, share: s.cost ? r.cost / s.cost : 0 }));
  } else if (by === "tag") {
    // A session with several tags is in each row: the rows can add up to more than the total.
    rows = tagUsage(c.db, f).rows.map((r) => ({ ...r }));
  } else {
    // Every row: the human table shortens the list itself, files and scripts get all of it.
    rows = c.queries.breakdown(f, by, 100_000).rows;
  }
  return { by, range: rangeOut(range, c.now), filters: filtersOut(f), total, rows };
}

export type UsageReport = ReturnType<typeof usageReport>;

/** `limits`: the latest plan-limit readings and the budgets, and the exit code `--check` ends with. */
export function limitsReport(c: ReportContext, warnPercent = 80) {
  const windows = limitWindows(c.db, c.host, c.now);
  const budgets = budgetRows(c.db, c.budgets, c.user, c.now);
  const used = [...windows.filter((w) => w.status === "fresh").map((w) => w.usedPercent ?? 0), ...budgets.map((b) => b.usedPercent)];
  const peak = used.length ? Math.max(...used) : null;
  const fresh = windows.some((w) => w.status === "fresh");
  // A limit or cap reached says more than a missing reading, so it wins.
  const status = peak != null && peak >= 100 ? "over" : peak != null && peak >= warnPercent ? "warning" : fresh ? "ok" : "unknown";
  const exitCode = { ok: 0, warning: 10, over: 11, unknown: 2 }[status];
  return { windows, budgets, check: { warnPercent, status, exitCode } };
}

export type LimitsReport = ReturnType<typeof limitsReport>;

function localDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
