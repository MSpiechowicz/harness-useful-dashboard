import type { Database } from "bun:sqlite";
import { getMeta, hasTable, setMeta } from "./db.ts";
import { nextTick, type StepOptions, vacuumFree } from "./retention.ts";

/**
 * Successful tool calls older than a week are kept as counts per local day, session and dimensions (`outcome_days`)
 * rather than one row each: they are most of the outcomes, and nothing reads them one by one once they are that old.
 */

/** Days of `tool_ok` outcomes kept row by row, counted from local midnight. */
export const ROLLUP_DAYS = 7;

/** Local midnight of the day `ts` falls on, epoch ms. */
export function localDayStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Where the rollup stops: local midnight of the day ROLLUP_DAYS before `now`. Days are counted on the calendar, so a
 * daylight saving change in between moves nothing.
 */
export function rollupCutoff(now = Date.now()): number {
  const d = new Date(localDayStart(now));
  d.setDate(d.getDate() - ROLLUP_DAYS);
  return d.getTime();
}

/** The local midnight after the one at `day`. Calendar days, so a daylight saving change moves nothing. */
function nextDay(day: number): number {
  const d = new Date(day);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

const DAY = 86_400_000;

/** Where the last rollup of a host is noted: `{ until, at }`. */
const metaKey = (host: string) => `outcome_rollup:${host}`;

interface RollupNote {
  /** Successful tool calls of this host before this time (epoch ms) were rolled up. */
  until: number;
  /** When it ran. */
  at: number;
}

function note(db: Database, host: string): RollupNote | null {
  try {
    const n = JSON.parse(getMeta(db, metaKey(host)) ?? "null") as RollupNote | null;
    return n && typeof n.until === "number" && typeof n.at === "number" ? n : null;
  } catch {
    return null;
  }
}

/** Whether a rollup of this host is due: it never finished, or last finished a day ago. */
export function rollupDue(db: Database, host: string, now = Date.now()): boolean {
  const last = note(db, host);
  return !last || now - last.at >= DAY;
}

export interface RollupResult {
  /** Local days gone over. */
  days: number;
  /** Rows written to `outcome_days`. */
  groups: number;
  /** Successful tool calls those rows count. */
  counted: number;
  /** `tool_ok` rows deleted: the counted ones, and copies of a session-day counted before. */
  deleted: number;
  /** Pages an incremental vacuum gave back to the disk. */
  freedPages: number;
  /** False when `stop` cut it short. */
  done: boolean;
}

export interface RollupOptions extends StepOptions {
  now?: number;
}

/**
 * Rolls this host's successful tool calls older than rollupCutoff(now) into daily counts per session and dimensions,
 * one local day per transaction, oldest first. A session-day already in `outcome_days` isn't counted again: its rows
 * are copies an older app or an earlier run left (the writer skips them), and are deleted uncounted. Other hosts' rows
 * are never touched: each machine rolls up what it ingested, on its own clock. A run cut short resumes with the oldest
 * day left, since a rolled day has no `tool_ok` rows anymore.
 */
export async function rollupOutcomes(db: Database, host: string, opts: RollupOptions = {}): Promise<RollupResult> {
  const now = opts.now ?? Date.now();
  const pause = opts.pause ?? nextTick;
  const stop = opts.stop ?? (() => false);
  const result: RollupResult = { days: 0, groups: 0, counted: 0, deleted: 0, freedPages: 0, done: true };
  // A reader of an older database (never migrated) has nowhere to put the counts.
  if (!hasTable(db, "outcome_days")) return result;

  const cutoff = rollupCutoff(now);
  const oldest = db.query<{ ts: number | null }, { host: string; from: number; cutoff: number }>(
    "SELECT MIN(ts) AS ts FROM outcomes WHERE kind = 'tool_ok' AND host = $host AND ts >= $from AND ts < $cutoff",
  );
  // SQLite reads the whole SELECT before inserting, since it reads the table it inserts into: a session's second
  // group of the day isn't taken for one counted before.
  const insert = db.query<{ n: number }, { host: string; day: number; next: number }>(
    `INSERT INTO outcome_days (ts, host, provider, session_id, project, user, model, agent, effort, tool, kind, n)
     SELECT $day, $host, o.provider, o.session_id, o.project, o.user, o.model, o.agent, o.effort, o.tool, 'tool_ok', COUNT(*)
     FROM outcomes o
     WHERE o.host = $host AND o.kind = 'tool_ok' AND o.ts >= $day AND o.ts < $next
       AND NOT EXISTS (SELECT 1 FROM outcome_days d WHERE d.session_id = o.session_id AND d.ts = $day AND d.host = $host)
     GROUP BY o.provider, o.session_id, o.project, o.user, o.model, o.agent, o.effort, o.tool
     RETURNING n`,
  );
  const remove = db.query<unknown, { host: string; day: number; next: number }>(
    "DELETE FROM outcomes WHERE host = $host AND kind = 'tool_ok' AND ts >= $day AND ts < $next",
  );
  const rollDay = db.transaction((p: { host: string; day: number; next: number }) => {
    const groups = insert.all(p);
    result.groups += groups.length;
    result.counted += groups.reduce((sum, g) => sum + g.n, 0);
    result.deleted += remove.run(p).changes;
  });

  let from = 0;
  while (true) {
    if (stop()) return { ...result, done: false };
    const first = oldest.get({ host, from, cutoff })?.ts;
    if (first == null) break;

    const day = localDayStart(first);
    const next = nextDay(day);
    // Immediate: the day is read and rewritten under one write lock, so another machine's writes can't slip between.
    rollDay.immediate({ host, day, next });
    result.days++;
    from = next;
    await pause();
  }

  setMeta(db, metaKey(host), JSON.stringify({ until: cutoff, at: now } satisfies RollupNote));
  if (result.deleted) result.freedPages = await vacuumFree(db, { pause, stop });
  return result;
}
