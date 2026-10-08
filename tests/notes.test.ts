import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { OutcomeRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { addNote, compareNote, deleteNote, listNotes, MAX_NOTE_TEXT, MAX_NOTES, NOTE_NOT_FOUND, type Note, updateNote } from "../src/core/notes.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";

const DAY = 86_400_000;
/** Local midnight of 2026-09-10, the day the notes below stand on. */
const T = new Date(2026, 8, 10).getTime();
const NOW = T + 40 * DAY;

const ok = <T>(r: { ok: T } | { error: string }): T => {
  if ("error" in r) throw new Error(r.error);
  return r.ok;
};
const error = (r: { ok: unknown } | { error: string }) => ("error" in r ? r.error : null);

describe("note validation", () => {
  test("a day note keeps its day, text is one trimmed line", () => {
    const db = memDb();
    const note = ok(addNote(db, { ts: T, day: "2026-09-10", text: "  switched\n to   Opus \t" }, NOW));
    expect(note).toMatchObject({ ts: T, day: "2026-09-10", text: "switched to Opus", createdAt: NOW, updatedAt: NOW });
    expect(note.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(listNotes(db)).toEqual([note]);
  });

  test("a timed note has no day", () => {
    const db = memDb();
    expect(ok(addNote(db, { ts: T + 3_600_000, text: "new CLAUDE.md" }, NOW)).day).toBeNull();
  });

  test("secrets in the text are redacted", () => {
    const db = memDb();
    const note = ok(addNote(db, { ts: T, text: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 rotated" }, NOW));
    expect(note.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(note.text).toContain("[redacted]");
  });

  test("text that is empty or too long is refused", () => {
    const db = memDb();
    expect(error(addNote(db, { ts: T, text: "   \n " }, NOW))).toContain("characters");
    expect(error(addNote(db, { ts: T, text: "x".repeat(MAX_NOTE_TEXT + 1) }, NOW))).toContain("characters");
    expect(error(addNote(db, { ts: T, text: 42 }, NOW))).toContain("characters");
    expect(ok(addNote(db, { ts: T, text: "x".repeat(MAX_NOTE_TEXT) }, NOW)).text).toHaveLength(MAX_NOTE_TEXT);
  });

  test("a day must be YYYY-MM-DD and on the calendar", () => {
    const db = memDb();
    expect(error(addNote(db, { ts: T, day: "2026-9-10", text: "a" }, NOW))).toContain("day");
    expect(error(addNote(db, { ts: T, day: "2026-02-30", text: "a" }, NOW))).toContain("day");
    expect(error(addNote(db, { ts: T, day: "2026-13-01", text: "a" }, NOW))).toContain("day");
    expect(ok(addNote(db, { ts: T, day: "2028-02-29", text: "leap" }, NOW)).day).toBe("2028-02-29");
  });

  test("the time must lie between 2000 and a year ahead", () => {
    const db = memDb();
    expect(error(addNote(db, { ts: Date.UTC(1999, 11, 31), text: "a" }, NOW))).toContain("time");
    expect(error(addNote(db, { ts: NOW + 367 * DAY, text: "a" }, NOW))).toContain("time");
    expect(error(addNote(db, { ts: Number.NaN, text: "a" }, NOW))).toContain("time");
    expect(error(addNote(db, { ts: "1757462400000", text: "a" }, NOW))).toContain("time");
    expect(ok(addNote(db, { ts: NOW + 365 * DAY, text: "a" }, NOW)).ts).toBe(NOW + 365 * DAY);
  });

  test("ids must have the UUID shape", () => {
    const db = memDb();
    expect(error(updateNote(db, { id: "nope", text: "a" }, NOW))).toBe("invalid note id");
    expect(error(deleteNote(db, "1; DROP TABLE chart_notes"))).toBe("invalid note id");
    expect(error(compareNote(db, new Queries(db, () => new PriceBook()), 7, 7, {}, NOW))).toBe("invalid note id");
    expect(error(deleteNote(db, crypto.randomUUID()))).toBe(NOTE_NOT_FOUND);
    expect(error(updateNote(db, { id: crypto.randomUUID(), text: "a" }, NOW))).toBe(NOTE_NOT_FOUND);
  });

  test(`no more than ${MAX_NOTES} notes`, () => {
    const db = memDb();
    const insert = db.prepare("INSERT INTO chart_notes(id, ts, day, text, created_at, updated_at) VALUES (?, ?, NULL, 'n', 0, 0)");
    db.transaction(() => {
      for (let i = 0; i < MAX_NOTES - 1; i++) insert.run(crypto.randomUUID(), T);
    })();
    expect("ok" in addNote(db, { ts: T, text: "last one" }, NOW)).toBe(true);
    expect(error(addNote(db, { ts: T, text: "one too many" }, NOW))).toContain(`${MAX_NOTES}`);
  });
});

describe("editing and listing notes", () => {
  test("an edit changes only the fields given, day: null makes a timed note", () => {
    const db = memDb();
    const note = ok(addNote(db, { ts: T, day: "2026-09-10", text: "first" }, NOW));

    const renamed = ok(updateNote(db, { id: note.id, text: "second" }, NOW + 1));
    expect(renamed).toEqual({ ...note, text: "second", updatedAt: NOW + 1 });

    const timed = ok(updateNote(db, { id: note.id, ts: T + 9 * 3_600_000, day: null }, NOW + 2));
    expect(timed).toMatchObject({ ts: T + 9 * 3_600_000, day: null, text: "second", createdAt: NOW, updatedAt: NOW + 2 });

    expect(error(updateNote(db, { id: note.id, day: "2026-02-30" }, NOW))).toContain("day");
    expect(error(updateNote(db, { id: note.id, text: "" }, NOW))).toContain("characters");
    expect(error(updateNote(db, { id: note.id, ts: 0 }, NOW))).toContain("time");
    expect(listNotes(db)).toEqual([timed]);
  });

  test("delete removes the note", () => {
    const db = memDb();
    const note = ok(addNote(db, { ts: T, text: "gone soon" }, NOW));
    expect(deleteNote(db, note.id)).toEqual({ ok: null });
    expect(listNotes(db)).toEqual([]);
  });

  test("the list keeps to the range, oldest first", () => {
    const db = memDb();
    const late = ok(addNote(db, { ts: T + 2 * DAY, text: "late" }, NOW));
    const early = ok(addNote(db, { ts: T, text: "early" }, NOW));
    ok(addNote(db, { ts: T + 5 * DAY, text: "outside" }, NOW));
    expect(listNotes(db, { from: T, to: T + 5 * DAY }).map((n) => n.text)).toEqual([early.text, late.text]);
  });

  test("a database from before notes lists none and refuses changes", () => {
    const db = new Database(":memory:");
    expect(listNotes(db)).toEqual([]);
    expect("error" in addNote(db, { ts: T, text: "a" }, NOW)).toBe(true);
    expect("error" in updateNote(db, { id: crypto.randomUUID(), text: "a" }, NOW)).toBe(true);
    expect("error" in deleteNote(db, crypto.randomUUID())).toBe(true);
  });
});

describe("before and after a note", () => {
  function usage(over: Partial<UsageRecord> & { id: string; ts: number }): UsageRecord {
    return {
      provider: "claude", sessionId: "claude:s1", promptId: `p-${over.id}`, project: "/work/alpha", model: "claude-sonnet-4-5",
      skill: null, agent: "main", isSubagent: false, input: 100, output: 0, cacheRead: 300, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
      ...over,
    };
  }

  function outcome(id: string, ts: number, kind: OutcomeRecord["kind"], project = "/work/alpha"): OutcomeRecord {
    return { id, provider: "claude", sessionId: "claude:s1", ts, project, model: "claude-sonnet-4-5", agent: "main", kind };
  }

  /** Alpha: one prompt 2 days before the note, two 1 and 2 days after, and one 5 days before. Beta: noise. */
  function seed() {
    const db = memDb();
    const prices = new PriceBook();
    const w = new DbWriter(db, prices, ID);
    w.usage(usage({ id: "far-before", ts: T - 5 * DAY }));
    w.usage(usage({ id: "before", ts: T - 2 * DAY }));
    w.usage(usage({ id: "after-1", ts: T + DAY }));
    w.usage(usage({ id: "after-2", ts: T + 2 * DAY, input: 300, cacheRead: 100 }));
    w.usage(usage({ id: "beta", ts: T + DAY, project: "/work/beta", input: 50_000 }));
    w.outcome(outcome("o1", T - DAY, "tool_ok"));
    w.outcome(outcome("o2", T + DAY, "tool_ok"));
    w.outcome(outcome("o3", T + DAY, "tool_error"));
    w.outcome(outcome("o4", T + DAY, "tool_error", "/work/beta"));
    return { db, q: new Queries(db, () => prices), prices };
  }

  const dayNote = (db: Database): Note => ok(addNote(db, { ts: T + 7 * 3_600_000, day: "2026-09-10", text: "switched" }, NOW));

  test("a day note compares from its day's midnight, the after window clipped at now", () => {
    const { db, q } = seed();
    const note = dayNote(db);
    const now = T + 3 * DAY;

    const r = ok(compareNote(db, q, note.id, 7, { project: "/work/alpha" }, now));
    expect(r.clipped).toBe(true);
    expect(r.after).toMatchObject({ from: T, to: now, prompts: 2, tokensPerPrompt: 400, toolErrorRate: 0.5 });
    expect(r.after.cacheHitRate).toBeCloseTo(400 / 800);
    // The before window is as long as the after one: the prompt 5 days before is left out.
    expect(r.before).toMatchObject({ from: T - 3 * DAY, to: T, prompts: 1, tokensPerPrompt: 400, toolErrorRate: 0 });
    expect(r.before.cacheHitRate).toBeCloseTo(0.75);
    expect(r.before.costPerPrompt).toBeCloseTo(r.before.cost);
  });

  test("whole windows when now is past them", () => {
    const { db, q } = seed();
    const note = dayNote(db);
    const r = ok(compareNote(db, q, note.id, 7, { project: "/work/alpha" }, NOW));
    expect(r.clipped).toBe(false);
    expect(r.days).toBe(7);
    expect(r.after).toMatchObject({ from: T, to: T + 7 * DAY, prompts: 2 });
    expect(r.before).toMatchObject({ from: T - 7 * DAY, to: T, prompts: 2 });
  });

  test("the other filters apply, the range is the note's", () => {
    const { db, q } = seed();
    const note = dayNote(db);
    const all = ok(compareNote(db, q, note.id, 7, { from: 0, to: 1 }, NOW)).after;
    expect(all.prompts).toBe(3);
    expect(all.toolErrorRate).toBeCloseTo(2 / 3);

    const beta = ok(compareNote(db, q, note.id, 7, { project: "/work/beta" }, NOW));
    expect(beta.after).toMatchObject({ prompts: 1, toolErrorRate: 1 });
    expect(beta.before).toMatchObject({ cost: 0, prompts: 0, costPerPrompt: null, tokensPerPrompt: null, cacheHitRate: null, toolErrorRate: null });
  });

  test("a timed note compares from its moment", () => {
    const { db, q } = seed();
    const note = ok(addNote(db, { ts: T + DAY + 1, text: "later" }, NOW));
    const r = ok(compareNote(db, q, note.id, 14, { project: "/work/alpha" }, NOW));
    expect(r.after).toMatchObject({ from: T + DAY + 1, prompts: 1 });
  });

  test("a note ahead of now has empty windows, unknown days are refused", () => {
    const { db, q } = seed();
    const note = ok(addNote(db, { ts: NOW + DAY, text: "ahead" }, NOW));
    const r = ok(compareNote(db, q, note.id, 30, {}, NOW));
    expect(r.clipped).toBe(true);
    expect(r.after.to - r.after.from).toBe(0);
    expect(r.before.to - r.before.from).toBe(0);

    expect(error(compareNote(db, q, note.id, 10, {}, NOW))).toContain("days");
    expect(error(compareNote(db, q, crypto.randomUUID(), 7, {}, NOW))).toBe(NOTE_NOT_FOUND);
  });
});

describe("notes across time zones and daylight saving", () => {
  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.TZ;
    process.env.TZ = "Europe/Warsaw";
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });

  test("a day note is listed by its day, wherever the machine that wrote it was", () => {
    const db = memDb();
    const day = new Date(2026, 8, 12).getTime();
    // Written in Tokyo: its midnight is 7 hours before this one's.
    const ahead = ok(addNote(db, { ts: day - 7 * 3_600_000, day: "2026-09-12", text: "from Tokyo" }, NOW));
    // Written in New York on the 11th: its midnight falls on this machine's 12th.
    ok(addNote(db, { ts: day + 6 * 3_600_000, day: "2026-09-11", text: "from New York" }, NOW));
    const timed = ok(addNote(db, { ts: day + 3_600_000, text: "timed" }, NOW));
    ok(addNote(db, { ts: day - 3_600_000, text: "timed before" }, NOW));

    expect(listNotes(db, { from: day, to: new Date(2026, 8, 13).getTime() }).map((n) => n.text)).toEqual([ahead.text, timed.text]);
    expect(listNotes(db, { from: day }).map((n) => n.text)).toEqual([ahead.text, timed.text]);
    expect(listNotes(db, { to: day }).map((n) => n.text)).toEqual(["timed before", "from New York"]);
  });

  test("a note's windows are whole calendar days across a daylight saving change", () => {
    const db = memDb();
    const prices = new PriceBook();
    const q = new Queries(db, () => prices);
    // Summer time ends on October 25: the week after October 20 is an hour longer.
    const note = ok(addNote(db, { ts: new Date(2026, 9, 20).getTime(), day: "2026-10-20", text: "switched" }, NOW));
    const later = new Date(2026, 11, 1).getTime();

    const r = ok(compareNote(db, q, note.id, 7, {}, later));
    expect(r.clipped).toBe(false);
    expect(r.after).toMatchObject({ from: new Date(2026, 9, 20).getTime(), to: new Date(2026, 9, 27).getTime() });
    expect(r.before).toMatchObject({ from: new Date(2026, 9, 13).getTime(), to: new Date(2026, 9, 20).getTime() });
    expect(r.after.to - r.after.from).toBe(7 * DAY + 3_600_000);

    const clipped = ok(compareNote(db, q, note.id, 7, {}, new Date(2026, 9, 22).getTime()));
    expect(clipped.clipped).toBe(true);
    expect(clipped.before.to - clipped.before.from).toBe(clipped.after.to - clipped.after.from);
  });
});
