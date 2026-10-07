import type { Database } from "bun:sqlite";
import { getMeta, setMeta } from "./db.ts";

/**
 * Detail retention: after N months the bulky detail of a row goes, the row itself stays. Every usage row is kept with
 * its tokens, cost, model, project, user and time, so totals, trends, breakdowns and budgets don't change. What goes:
 *
 * - prompt text, except the start of each session's first prompt, which titles the session (Prompts shows no text)
 * - file paths and subagent briefs on tool calls (Files is empty for those days, tool counts stay)
 * - error messages and inputs on outcomes (Friction keeps its counts and classes, not the messages)
 * - subagent briefs on sessions
 * - response times and effort (response_meta, Time and Model drift have nothing for those days)
 *
 * The setting is per machine (config.json), and so is what it trims: only the rows this host ingested. On a shared
 * database each machine keeps its own detail as long as its own setting says, and a machine with trimming off never
 * loses anything to another's. Trimming runs at most once a day, in batches of a few thousand rows per transaction,
 * so the server stays responsive and a database in a synced folder isn't rewritten in one huge commit.
 *
 * Reading old logs again (a full rescan, a migration) doesn't bring the detail back: the writer leaves out detail
 * older than the cutoff (DbWriter's `detailBefore`), and a stored prompt's text is never overwritten.
 */

/** Rows per transaction. */
export const TRIM_BATCH = 5000;
/** Characters of a session's first prompt kept for its title (sessionTitle uses 160 after leaving out images). */
const TITLE_CHARS = 300;
/** Pages given back to the disk per step of an incremental vacuum (8 MB at 4 KB pages). */
const VACUUM_PAGES = 2000;
const DAY = 86_400_000;

/** Where the last trim of a host is noted: `{ months, until, at }`. */
const metaKey = (host: string) => `detail_trim:${host}`;

interface TrimNote {
  /** The setting it ran with. */
  months: number;
  /** Everything of this host before this time (epoch ms) is trimmed. */
  until: number;
  /** When it ran. */
  at: number;
}

/** The time detail is kept from, for a retention of `months` (0: keep everything, null). Calendar months, local time. */
export function detailCutoff(months: number, now = Date.now()): number | null {
  if (!(months > 0)) return null;
  const d = new Date(now);
  d.setMonth(d.getMonth() - months);
  return d.getTime();
}

function note(db: Database, host: string): TrimNote | null {
  try {
    const n = JSON.parse(getMeta(db, metaKey(host)) ?? "null") as TrimNote | null;
    return n && typeof n.until === "number" && typeof n.at === "number" ? n : null;
  } catch {
    return null;
  }
}

/** Whether a trim is due: never ran with this setting, or last ran a day ago. Off with nothing noted is never due. */
export function trimDue(db: Database, host: string, months: number, now = Date.now()): boolean {
  const last = note(db, host);
  if (!(months > 0)) return last != null;
  return !last || last.months !== months || now - last.at >= DAY;
}

export interface TrimResult {
  prompts: number;
  toolCalls: number;
  outcomes: number;
  sessions: number;
  responseMeta: number;
  /** Transactions committed. */
  batches: number;
  /** Pages an incremental vacuum gave back to the disk. */
  freedPages: number;
  /** False when `stop` cut it short. */
  done: boolean;
}

export interface TrimOptions {
  now?: number;
  batch?: number;
  /** Called between batches: the server answers requests there. */
  pause?: () => Promise<void>;
  /** Asked between batches: true ends the run early (the database was switched or closed). */
  stop?: () => boolean;
}

/**
 * Trims this host's detail older than `months` (see the top of this file), then gives the freed pages back to the disk
 * when the database can do that a step at a time. With `months` 0 it only forgets the note of an earlier trim, so
 * turning trimming on again later goes over all history once more.
 */
export async function trimDetail(db: Database, host: string, months: number, opts: TrimOptions = {}): Promise<TrimResult> {
  const now = opts.now ?? Date.now();
  const n = opts.batch ?? TRIM_BATCH;
  const pause = opts.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const stop = opts.stop ?? (() => false);
  const result: TrimResult = { prompts: 0, toolCalls: 0, outcomes: 0, sessions: 0, responseMeta: 0, batches: 0, freedPages: 0, done: true };
  const cutoff = detailCutoff(months, now);
  if (cutoff == null) {
    if (note(db, host)) db.query("DELETE FROM meta WHERE key = ?").run(metaKey(host));
    return result;
  }
  // The big tables are gone over from where the last trim with this setting ended (less a day, for a scan that ran
  // alongside it). The writer keeps detail older than the cutoff out, so nothing older comes back. Prompts and
  // sessions are few: always all of them.
  const last = note(db, host);
  const from = last && last.months === months ? Math.max(0, Math.min(last.until, cutoff) - DAY) : 0;

  // Each step reads the next rows in time order (keyset on ts and rowid, so a batch never reads the rows of the one
  // before), then changes those that still hold detail in one transaction.
  type Row = { rid: number; ts: number; dirty: number };
  const steps: { key: "prompts" | "toolCalls" | "outcomes" | "responseMeta" | "sessions"; select: string; update: string; from: number }[] = [
    {
      key: "prompts",
      select: `SELECT p.rowid AS rid, p.ts, (length(p.text) > ${TITLE_CHARS} OR p.id IS NOT ${firstPrompt("p")}) AS dirty
               FROM prompts p JOIN sessions s ON s.id = p.session_id
               WHERE s.host = $host AND p.text IS NOT NULL AND (p.ts, p.rowid) > ($ts, $rid) AND p.ts < $cutoff
               ORDER BY p.ts, p.rowid LIMIT $n`,
      // A session's first prompt keeps its start: it is the session's title when the harness gave it none.
      update: `UPDATE prompts SET text = CASE WHEN id IS ${firstPrompt("prompts")} THEN substr(text, 1, ${TITLE_CHARS}) END
               WHERE rowid = $rid AND (length(text) > ${TITLE_CHARS} OR id IS NOT ${firstPrompt("prompts")})`,
      from: 0,
    },
    {
      key: "toolCalls",
      select: `SELECT t.rowid AS rid, t.ts, (t.file_path IS NOT NULL OR t.brief IS NOT NULL) AS dirty
               FROM tool_calls t JOIN sessions s ON s.id = t.session_id
               WHERE s.host = $host AND (t.ts, t.rowid) > ($ts, $rid) AND t.ts < $cutoff ORDER BY t.ts, t.rowid LIMIT $n`,
      update: "UPDATE tool_calls SET file_path = NULL, brief = NULL WHERE rowid = $rid",
      from,
    },
    {
      key: "outcomes",
      select: `SELECT rowid AS rid, ts, (detail IS NOT NULL OR input IS NOT NULL) AS dirty FROM outcomes
               WHERE host = $host AND (ts, rowid) > ($ts, $rid) AND ts < $cutoff ORDER BY ts, rowid LIMIT $n`,
      update: "UPDATE outcomes SET detail = NULL, input = NULL WHERE rowid = $rid",
      from,
    },
    {
      // Response times hang off usage rows: found through them, by time, and deleted (the usage row stays).
      key: "responseMeta",
      select: `SELECT u.rowid AS rid, u.ts, EXISTS (SELECT 1 FROM response_meta m WHERE m.usage_id = u.id) AS dirty FROM usage u
               WHERE u.host = $host AND (u.ts, u.rowid) > ($ts, $rid) AND u.ts < $cutoff ORDER BY u.ts, u.rowid LIMIT $n`,
      update: "DELETE FROM response_meta WHERE usage_id = (SELECT id FROM usage WHERE rowid = $rid)",
      from,
    },
    {
      key: "sessions",
      select: `SELECT rowid AS rid, COALESCE(ended_at, started_at) AS ts, 1 AS dirty FROM sessions
               WHERE host = $host AND brief IS NOT NULL AND COALESCE(ended_at, started_at) < $cutoff
               AND (COALESCE(ended_at, started_at), rowid) > ($ts, $rid) ORDER BY 2, rowid LIMIT $n`,
      update: "UPDATE sessions SET brief = NULL WHERE rowid = $rid",
      from: 0,
    },
  ];

  for (const step of steps) {
    const select = db.query<Row, Record<string, number | string>>(step.select);
    const update = db.query<unknown, { rid: number }>(step.update);
    let cursor = { ts: step.from - 1, rid: Number.MAX_SAFE_INTEGER };
    // From `from` on: (ts, rowid) > (from - 1, max) is every row with ts >= from.
    while (true) {
      if (stop()) return { ...result, done: false };
      const rows = select.all({ host, cutoff, n, ts: cursor.ts, rid: cursor.rid });
      const dirty = rows.filter((r) => r.dirty);
      if (dirty.length) {
        db.transaction(() => {
          for (const r of dirty) result[step.key] += update.run({ rid: r.rid }).changes;
        })();
        result.batches++;
      }
      if (rows.length < n) break;
      const lastRow = rows[rows.length - 1]!;
      cursor = { ts: lastRow.ts, rid: lastRow.rid };
      await pause();
    }
  }
  if (stop()) return { ...result, done: false };
  setMeta(db, metaKey(host), JSON.stringify({ months, until: cutoff, at: now } satisfies TrimNote));
  result.freedPages = await vacuumFree(db, { pause, stop });
  return result;
}

/** The id of a session's first prompt with text, as SQL, for the prompts row `alias`. */
function firstPrompt(alias: string): string {
  return `(SELECT fp.id FROM prompts fp WHERE fp.session_id = ${alias}.session_id AND fp.text IS NOT NULL AND trim(fp.text) <> ''
           ORDER BY fp.ts LIMIT 1)`;
}

/**
 * Gives free pages back to the disk a step at a time, when the database is in incremental auto-vacuum mode (new ones
 * are, see openDb, older ones after Compact). Otherwise the pages stay free inside the file for new rows.
 */
export async function vacuumFree(db: Database, opts: { pause?: () => Promise<void>; stop?: () => boolean } = {}): Promise<number> {
  const pause = opts.pause ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  if (pragma(db, "auto_vacuum") !== 2) return 0;
  let freed = 0;
  while (!opts.stop?.()) {
    const free = pragma(db, "freelist_count");
    if (free === 0) break;
    db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
    freed += free - pragma(db, "freelist_count");
    if (free <= VACUUM_PAGES) break;
    await pause();
  }
  return freed;
}

function pragma(db: Database, name: string): number {
  return Number(Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0] ?? 0);
}

export interface DbSize {
  /** Bytes in use by the database (pages × page size), free pages included. */
  bytes: number;
  /** Bytes of free pages inside the file: what Compact would give back. */
  freeBytes: number;
  /** Whether trimming hands freed pages back to the disk by itself. Older databases need Compact once for that. */
  incremental: boolean;
}

export function dbSize(db: Database): DbSize {
  const page = pragma(db, "page_size");
  return { bytes: pragma(db, "page_count") * page, freeBytes: pragma(db, "freelist_count") * page, incremental: pragma(db, "auto_vacuum") === 2 };
}

/**
 * Rewrites the whole database without its free pages, and switches it to incremental auto-vacuum on the way. Takes
 * as long as copying the file, and holds the write lock all the while: other machines sharing the file wait.
 */
export function compact(db: Database): DbSize {
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  // In WAL mode VACUUM writes the whole file into the log: fold it back so the log doesn't stay that big.
  if (String((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toLowerCase() === "wal") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return dbSize(db);
}
