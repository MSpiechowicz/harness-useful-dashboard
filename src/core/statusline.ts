import type { Database } from "bun:sqlite";

/**
 * The `statusline` command: Claude Code runs it after every turn with a JSON description of the session on stdin and
 * shows the one line it prints under the prompt. It only reads the database (never scans, never asks the network), so
 * it stays fast, and it never fails: whatever goes wrong, a shorter line still comes out.
 */

export const DEFAULT_FORMAT = "{model} · {session} · {today} · {limit}";

/** A limit reading older than this is not shown: the dashboard refreshes the limits every few minutes while it runs. */
export const LIMIT_FRESH_MS = 15 * 60_000;

/** What Claude Code passes on stdin, as far as the status line uses it. Every field is optional. */
export interface StatusInput {
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  /** Claude Code's own cost estimate for the session, USD. */
  costUsd: number | null;
  /** The 5-hour window as Claude Code reports it (newer versions), when present. */
  fiveHour: LimitInfo | null;
}

export interface LimitInfo {
  usedFraction: number;
  /** Epoch ms, null when unknown. */
  resetsAt: number | null;
}

export interface StatusData {
  model: string | null;
  sessionCost: number | null;
  todayCost: number | null;
  limit: LimitInfo | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** An epoch in seconds or ms, or an ISO date. */
function epochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function fiveHourFrom(raw: unknown): LimitInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const w = (raw as Record<string, unknown>).five_hour;
  if (!w || typeof w !== "object") return null;
  const o = w as Record<string, unknown>;
  const pct = num(o.used_percentage) ?? num(o.used_percent) ?? num(o.utilization);
  if (pct == null) return null;
  return { usedFraction: Math.max(0, pct / 100), resetsAt: epochMs(o.resets_at) };
}

/** Reads Claude Code's stdin JSON. Anything missing or malformed comes back as null, never as an error. */
export function parseInput(text: string): StatusInput {
  let j: Record<string, any> = {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object") j = v;
  } catch {
    /* not JSON: nothing known */
  }
  const model = j.model && typeof j.model === "object" ? str(j.model.display_name) ?? str(j.model.id) : str(j.model);
  return {
    sessionId: str(j.session_id),
    model,
    cwd: str(j.workspace?.current_dir) ?? str(j.cwd),
    costUsd: num(j.cost?.total_cost_usd),
    fiveHour: fiveHourFrom(j.rate_limits),
  };
}

/** Local midnight of the day `now` falls in. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** API-equivalent cost of a session and its subagents, null when the database has nothing for it yet. */
export function sessionCost(db: Database, sessionId: string): number | null {
  const row = db
    .query<{ cost: number | null; n: number }, { id: string }>(
      `SELECT SUM(cost_usd) AS cost, COUNT(*) AS n FROM usage
        WHERE session_id = $id OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id)`,
    )
    .get({ id: sessionId });
  return row && row.n > 0 ? (row.cost ?? 0) : null;
}

/** What one user spent today across every harness, USD. */
export function todayCost(db: Database, user: string, now: number): number {
  const row = db
    .query<{ cost: number | null }, { from: number; user: string }>("SELECT SUM(cost_usd) AS cost FROM usage WHERE ts >= $from AND user = $user")
    .get({ from: startOfDay(now), user });
  return row?.cost ?? 0;
}

/**
 * The latest stored reading of Claude's 5-hour window, when it is fresh and the window has not reset since. Readings
 * from this machine win over ones another machine wrote into a shared database.
 */
export function storedFiveHour(db: Database, host: string, now: number): LimitInfo | null {
  const row = db
    .query<{ used_fraction: number; resets_at: number | null }, { from: number; host: string }>(
      `SELECT used_fraction, resets_at FROM limit_readings
        WHERE observed_at >= $from AND provider = 'claude' AND window_id = 'five_hour'
        ORDER BY host = $host DESC, observed_at DESC LIMIT 1`,
    )
    .get({ from: now - LIMIT_FRESH_MS, host });
  if (!row) return null;
  if (row.resets_at != null && row.resets_at <= now) return null;
  return { usedFraction: row.used_fraction, resetsAt: row.resets_at };
}

export interface GatherOptions {
  user: string;
  host: string;
  now: number;
}

/** Collects what the line shows. Each part that fails is left out, the others still show. */
export function gather(db: Database | null, input: StatusInput, o: GatherOptions): StatusData {
  const attempt = <T>(f: () => T): T | null => {
    if (!db) return null;
    try {
      return f();
    } catch {
      return null;
    }
  };
  const fromDb = input.sessionId ? attempt(() => sessionCost(db!, `claude:${input.sessionId}`)) : null;
  return {
    model: input.model,
    sessionCost: fromDb ?? input.costUsd,
    todayCost: attempt(() => todayCost(db!, o.user, o.now)),
    limit: input.fiveHour ?? attempt(() => storedFiveHour(db!, o.host, o.now)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Formatting

export function formatUsd(v: number): string {
  if (v >= 10_000) return `$${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
}

/** "1h20m", "45m", "2d3h". Under a minute counts as one. */
export function formatDuration(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${String(min % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const ANSI = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };
type Paint = (code: keyof typeof ANSI, s: string) => string;

function painter(color: boolean): Paint {
  return color ? (code, s) => `${ANSI[code]}${s}${ANSI.reset}` : (_code, s) => s;
}

/** The value of each placeholder, "" when unknown. */
export function placeholders(d: StatusData, o: { color: boolean; now: number }): Record<string, string> {
  const p = painter(o.color);
  const money = (label: string, v: number | null) => (v == null ? "" : `${p("dim", label)} ${formatUsd(v)}`);
  let limit = "";
  if (d.limit) {
    const pct = Math.round(d.limit.usedFraction * 100);
    const tone = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
    const resets = d.limit.resetsAt != null && d.limit.resetsAt > o.now ? ` ${p("dim", `(resets ${formatDuration(d.limit.resetsAt - o.now)})`)}` : "";
    limit = `${p("dim", "5h")} ${p(tone, `${pct}%`)}${resets}`;
  }
  return {
    model: d.model ? p("bold", d.model) : "",
    session: money("session", d.sessionCost),
    today: money("today", d.todayCost),
    limit,
  };
}

/**
 * Fills a template such as "{model} · {session}". A placeholder with no value is dropped together with the separator
 * in front of it (or after it, for the first one), so the line never shows dangling separators. Unknown placeholders
 * stay as written.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const tokens: { text: string; slot: boolean }[] = [];
  const re = /\{(\w+)\}/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) tokens.push({ text: template.slice(last, m.index), slot: false });
    const known = Object.hasOwn(values, m[1]!);
    tokens.push({ text: known ? values[m[1]!]! : m[0], slot: known });
    last = m.index + m[0].length;
  }
  if (last < template.length) tokens.push({ text: template.slice(last), slot: false });

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.slot || t.text) continue;
    const before = i > 0 && !tokens[i - 1]!.slot ? i - 1 : -1;
    const after = i + 1 < tokens.length && !tokens[i + 1]!.slot ? i + 1 : -1;
    // A separator sits between two values: drop the one before unless this is the first value of the line.
    const hasValueBefore = tokens.slice(0, i).some((x) => x.slot && x.text);
    const drop = hasValueBefore && before >= 0 ? before : after >= 0 && i + 2 < tokens.length ? after : before;
    tokens.splice(i, 1);
    if (drop >= 0) tokens.splice(drop > i ? drop - 1 : drop, 1);
    i = -1; // start over: indexes moved
  }
  return tokens.map((t) => t.text).join("").trim();
}

export function render(d: StatusData, o: { format?: string; color: boolean; now: number }): string {
  const line = fillTemplate(o.format || DEFAULT_FORMAT, placeholders(d, o));
  return line || fallbackLine(d.model);
}

/** What prints when nothing else can: the model's name, or the app's. */
export function fallbackLine(model: string | null): string {
  return model ?? "harness-dashboard";
}

/** NO_COLOR (any non-empty value) and --no-color turn colors off. */
export function useColor(flag: boolean, env: Record<string, string | undefined>): boolean {
  return !flag && !env.NO_COLOR;
}
