import type { Database } from "bun:sqlite";
import { hasTable } from "./db.ts";
import { frictionTotals } from "./friction.ts";
import type { Filters, Queries } from "./queries.ts";
import { redact } from "./redact.ts";
import type { Result } from "./tags.ts";

/**
 * Notes on the usage chart: "switched to Opus", "new CLAUDE.md". They live in the database itself, so on a shared
 * database every machine sees them. A day note stands for a whole day and keeps its date (`day`) wherever it is read,
 * a timed note stands at a moment (`ts`) and has no day. One line each, secrets redacted.
 */
export const MAX_NOTE_TEXT = 200;
export const MAX_NOTES = 1000;
/** The days after a note that its before/after comparison can cover. */
export const COMPARE_DAYS = [7, 14, 30] as const;
export type CompareDays = (typeof COMPARE_DAYS)[number];

/** The error of a note id that names no note, for the server to answer 404. */
export const NOTE_NOT_FOUND = "unknown note";
const NO_TABLE = "this database has no chart notes yet: update the app that created it";

const DAY = 86_400_000;
const EARLIEST = Date.UTC(2000, 0, 1);
/** Notes may stand up to a year ahead: a release date, a contract's end. */
const LATEST_AHEAD = 366 * DAY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface Note {
  id: string;
  ts: number;
  day: string | null;
  text: string;
  createdAt: number;
  updatedAt: number;
}

const COLUMNS = "id, ts, day, text, created_at AS createdAt, updated_at AS updatedAt";

// ---- Validation ------------------------------------------------------------

/** The text as it is stored: one line, spaces collapsed, secrets redacted. Null when it is empty or too long. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 20 * MAX_NOTE_TEXT) return null;

  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_NOTE_TEXT) return null;

  return redact(text);
}

function validTs(raw: unknown, now: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < EARLIEST || raw > now + LATEST_AHEAD) return null;
  return Math.round(raw);
}

/** A "YYYY-MM-DD" that names a real calendar day: February 30 is refused. */
function validDay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const m = DAY_KEY.exec(raw);
  if (!m) return null;

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return real ? raw : null;
}

const validId = (raw: unknown): raw is string => typeof raw === "string" && UUID.test(raw);

const asObject = (input: unknown): Record<string, unknown> | null =>
  input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : null;

const TEXT_ERROR = `a note takes 1 to ${MAX_NOTE_TEXT} characters`;
const TS_ERROR = "invalid time for the note";
const DAY_ERROR = "invalid day for the note: use YYYY-MM-DD";

// ---- Reading and writing ---------------------------------------------------

function getNote(db: Database, id: string): Note | null {
  return db.query<Note, [string]>(`SELECT ${COLUMNS} FROM chart_notes WHERE id = ?`).get(id) ?? null;
}

/** The local date of a moment here, as "YYYY-MM-DD". */
function localDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The notes standing in a range, oldest first. Empty on a database from before notes. A timed note stands at its
 * moment, a day note on its day: it is in the range when that day is one of the range's local days here, wherever it
 * was written (its `ts` is midnight where it was).
 */
export function listNotes(db: Database, range: { from?: number; to?: number } = {}): Note[] {
  if (!hasTable(db, "chart_notes")) return [];

  const timed: string[] = ["day IS NULL"];
  const daily: string[] = ["day IS NOT NULL"];
  const params: Record<string, number | string> = {};
  if (range.from != null) {
    timed.push("ts >= $from");
    daily.push("day >= $fromDay");
    params.from = range.from;
    params.fromDay = localDay(range.from);
  }
  if (range.to != null) {
    timed.push("ts < $to");
    daily.push("day <= $toDay");
    params.to = range.to;
    params.toDay = localDay(range.to - 1);
  }

  const where = `WHERE (${timed.join(" AND ")}) OR (${daily.join(" AND ")})`;
  return db.query<Note, Record<string, number | string>>(`SELECT ${COLUMNS} FROM chart_notes ${where} ORDER BY ts, created_at`).all(params);
}

/** Adds a note `{ ts, day?, text }`. A day note carries its day, a timed one has none. */
export function addNote(db: Database, input: unknown, now = Date.now()): Result<Note> {
  if (!hasTable(db, "chart_notes")) return { error: NO_TABLE };

  const body = asObject(input);
  if (!body) return { error: "expected a note" };

  const text = cleanText(body.text);
  if (text === null) return { error: TEXT_ERROR };

  const ts = validTs(body.ts, now);
  if (ts === null) return { error: TS_ERROR };

  let day: string | null = null;
  if (body.day != null) {
    day = validDay(body.day);
    if (day === null) return { error: DAY_ERROR };
  }

  const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chart_notes").get()!.n;
  if (count >= MAX_NOTES) return { error: `at most ${MAX_NOTES} notes` };

  const id = crypto.randomUUID();
  db.query("INSERT INTO chart_notes(id, ts, day, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, ts, day, text, now, now);
  return { ok: getNote(db, id)! };
}

/**
 * Changes a note `{ id, text?, ts?, day? }`: fields left out stay as they are, `day: null` makes a day note a timed one.
 */
export function updateNote(db: Database, input: unknown, now = Date.now()): Result<Note> {
  if (!hasTable(db, "chart_notes")) return { error: NO_TABLE };

  const body = asObject(input);
  if (!body) return { error: "expected a note" };
  if (!validId(body.id)) return { error: "invalid note id" };

  const note = getNote(db, body.id);
  if (!note) return { error: NOTE_NOT_FOUND };

  let { text, ts, day } = note;

  if (body.text !== undefined) {
    const clean = cleanText(body.text);
    if (clean === null) return { error: TEXT_ERROR };
    text = clean;
  }

  if (body.ts !== undefined) {
    const valid = validTs(body.ts, now);
    if (valid === null) return { error: TS_ERROR };
    ts = valid;
  }

  if (body.day === null) day = null;
  else if (body.day !== undefined) {
    const valid = validDay(body.day);
    if (valid === null) return { error: DAY_ERROR };
    day = valid;
  }

  db.query("UPDATE chart_notes SET ts = ?, day = ?, text = ?, updated_at = ? WHERE id = ?").run(ts, day, text, now, note.id);
  return { ok: getNote(db, note.id)! };
}

export function deleteNote(db: Database, id: unknown): Result<null> {
  if (!hasTable(db, "chart_notes")) return { error: NO_TABLE };
  if (!validId(id)) return { error: "invalid note id" };

  const { changes } = db.query("DELETE FROM chart_notes WHERE id = ?").run(id);
  return changes ? { ok: null } : { error: NOTE_NOT_FOUND };
}

// ---- Before and after ------------------------------------------------------

/** One side of a note's comparison. Rates are 0..1, null when there is nothing to divide by. */
export interface NoteWindow {
  from: number;
  to: number;
  cost: number;
  prompts: number;
  costPerPrompt: number | null;
  tokensPerPrompt: number | null;
  cacheHitRate: number | null;
  toolErrorRate: number | null;
  apiErrorRate: number | null;
}

export interface NoteCompare {
  note: Note;
  days: CompareDays;
  clipped: boolean;
  before: NoteWindow;
  after: NoteWindow;
}

/** Where a note stands: a day note at its day's local midnight here, a timed note at its moment. */
function noteStart(note: Note): number {
  if (!note.day) return note.ts;

  const [y, m, d] = note.day.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

function measure(db: Database, queries: Queries, f: Filters, from: number, to: number): NoteWindow {
  const range = { ...f, from, to };
  const s = queries.summary(range);
  const friction = frictionTotals(db, range);

  const cacheBase = s.input + s.cacheRead + s.cacheWrite;
  const finished = friction.ok + friction.errors;
  return {
    from,
    to,
    cost: s.cost,
    prompts: s.prompts,
    costPerPrompt: s.prompts ? s.cost / s.prompts : null,
    tokensPerPrompt: s.prompts ? s.tokens / s.prompts : null,
    cacheHitRate: cacheBase ? s.cacheRead / cacheBase : null,
    toolErrorRate: finished ? friction.errors / finished : null,
    apiErrorRate: friction.apiErrorRate,
  };
}

/** `days` calendar days after `ts` (before, when negative), at the same local time: a daylight saving change moves nothing. */
function addDays(ts: number, days: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/**
 * The days after a note against as many days before it, counted on the calendar. The after window ends `days` after
 * the note or at `now`, whichever comes first (`clipped`): a clipped one has a before window just as long. The filters
 * apply, except their range.
 */
export function compareNote(db: Database, queries: Queries, id: unknown, days: unknown, f: Filters = {}, now = Date.now()): Result<NoteCompare> {
  if (!hasTable(db, "chart_notes")) return { error: NO_TABLE };
  if (!validId(id)) return { error: "invalid note id" };
  if (!COMPARE_DAYS.includes(days as CompareDays)) return { error: `days must be one of ${COMPARE_DAYS.join(", ")}` };

  const note = getNote(db, id);
  if (!note) return { error: NOTE_NOT_FOUND };

  const start = noteStart(note);
  const full = addDays(start, days as CompareDays);
  const clipped = full > now;

  // A note ahead of now has no after yet: both windows are empty.
  const end = clipped ? Math.max(start, now) : full;
  const beforeStart = clipped ? start - (end - start) : addDays(start, -(days as CompareDays));

  return {
    ok: {
      note,
      days: days as CompareDays,
      clipped,
      before: measure(db, queries, f, beforeStart, start),
      after: measure(db, queries, f, start, end),
    },
  };
}
