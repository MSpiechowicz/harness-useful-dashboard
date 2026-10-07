import type { Database } from "bun:sqlite";
import { redact } from "./redact.ts";

/**
 * Tags and notes the user gives sessions. They live in the database itself, so on a shared database every machine
 * sees them. A tag is kept lowercase: "Acme" and "acme" are one client, and matching never depends on the case. A
 * subagent's session has no tags of its own to set: it takes its parent's, and so does every row of a project that has
 * a default tag (`project_tags`). Both are resolved when a query runs (see tagCondition in queries.ts), so tagging
 * rewrites no usage rows.
 */
export const MAX_TAG_LENGTH = 32;
export const MAX_TAGS_PER_SESSION = 20;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_PROJECT_TAGS = 500;
/** The key of the sessions without any tag in a breakdown, as "(none)" is for the other dimensions. */
export const UNTAGGED = "(none)";

/** Letters, digits and . _ : / - inside, a letter or digit first: "acme", "client:acme", "q3/billable". */
const TAG = /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u;

/** The tag as it is stored: trimmed, lowercase, inner spaces as "-", a leading "#" dropped. Null when it isn't a tag. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, "-").toLowerCase();
  return tag.length > 0 && tag.length <= MAX_TAG_LENGTH && TAG.test(tag) && tag !== UNTAGGED ? tag : null;
}

/** A note as it is stored: line breaks kept, secrets redacted, trailing space cut. Null when it is too long. */
export function normalizeNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const note = raw.replace(/\r\n?/g, "\n").trim();
  return note.length <= MAX_NOTE_LENGTH ? redact(note) : null;
}

const sessionExists = (db: Database, id: string): boolean =>
  !!db.query("SELECT 1 FROM sessions WHERE id = ? UNION ALL SELECT 1 FROM usage WHERE session_id = ? LIMIT 1").get(id, id);

export type Result<T> = { ok: T } | { error: string };

/** A session's own tags, the ones it has from its parent session and from its project, and its note. */
export function sessionTags(db: Database, id: string) {
  const own = db.query<{ tag: string }, [string]>("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag").all(id).map((r) => r.tag);
  const inherited = db
    .query<{ tag: string }, [string]>(
      `SELECT DISTINCT g.tag FROM sessions s JOIN session_tags g ON g.session_id = s.parent_session_id WHERE s.id = ? ORDER BY g.tag`,
    )
    .all(id)
    .map((r) => r.tag);
  const rule = db.query<{ tag: string }, [string]>("SELECT p.tag FROM sessions s JOIN project_tags p ON p.project = s.project WHERE s.id = ?").get(id)?.tag ?? null;
  const note = db.query<{ note: string; updatedAt: number }, [string]>("SELECT note, updated_at AS updatedAt FROM session_notes WHERE session_id = ?").get(id) ?? null;
  return { tags: own, inherited: inherited.filter((t) => !own.includes(t)), rule: rule && !own.includes(rule) ? rule : null, note };
}

export function addTag(db: Database, id: unknown, raw: unknown): Result<string[]> {
  if (typeof id !== "string" || !id || id.length > 500) return { error: "invalid value for session" };
  const tag = normalizeTag(raw);
  if (!tag) return { error: `invalid tag: use up to ${MAX_TAG_LENGTH} letters, digits and . _ : / -` };
  if (!sessionExists(db, id)) return { error: "unknown session" };
  const have = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session_tags WHERE session_id = ?").get(id)!.n;
  if (have >= MAX_TAGS_PER_SESSION && !db.query("SELECT 1 FROM session_tags WHERE session_id = ? AND tag = ?").get(id, tag)) {
    return { error: `a session takes at most ${MAX_TAGS_PER_SESSION} tags` };
  }
  db.query("INSERT OR IGNORE INTO session_tags(session_id, tag) VALUES (?, ?)").run(id, tag);
  return { ok: sessionTags(db, id).tags };
}

export function removeTag(db: Database, id: unknown, raw: unknown): Result<string[]> {
  if (typeof id !== "string" || !id || id.length > 500) return { error: "invalid value for session" };
  const tag = normalizeTag(raw);
  if (!tag) return { error: "invalid tag" };
  db.query("DELETE FROM session_tags WHERE session_id = ? AND tag = ?").run(id, tag);
  return { ok: sessionTags(db, id).tags };
}

/** Saves a session's note, or removes it when it is empty. */
export function setNote(db: Database, id: unknown, raw: unknown, now = Date.now()): Result<{ note: string; updatedAt: number } | null> {
  if (typeof id !== "string" || !id || id.length > 500) return { error: "invalid value for session" };
  const note = normalizeNote(raw);
  if (note === null) return { error: `a note takes at most ${MAX_NOTE_LENGTH} characters` };
  if (!sessionExists(db, id)) return { error: "unknown session" };
  if (!note) {
    db.query("DELETE FROM session_notes WHERE session_id = ?").run(id);
    return { ok: null };
  }
  db.query("INSERT OR REPLACE INTO session_notes(session_id, note, updated_at) VALUES (?, ?, ?)").run(id, note, now);
  return { ok: { note, updatedAt: now } };
}

/** The default tag of each project: a project path and the tag its sessions get. */
export function projectRules(db: Database): { project: string; tag: string }[] {
  return db.query<{ project: string; tag: string }, []>("SELECT project, tag FROM project_tags ORDER BY project").all();
}

/** Replaces the project rules. Rows that aren't a path with a tag are refused as a whole, not skipped. */
export function setProjectRules(db: Database, rules: unknown): Result<{ project: string; tag: string }[]> {
  if (!Array.isArray(rules) || rules.length > MAX_PROJECT_TAGS) return { error: "expected a list of project rules" };
  const clean = new Map<string, string>();
  for (const r of rules as Record<string, unknown>[]) {
    const project = typeof r?.project === "string" ? r.project.trim() : "";
    const tag = normalizeTag(r?.tag);
    if (!project || project.length > 4096 || !tag) return { error: "each rule needs a project path and a valid tag" };
    clean.set(project, tag);
  }
  db.transaction(() => {
    db.exec("DELETE FROM project_tags");
    const ins = db.prepare("INSERT INTO project_tags(project, tag) VALUES (?, ?)");
    for (const [project, tag] of clean) ins.run(project, tag);
  })();
  return { ok: projectRules(db) };
}

/** Every tag in use, for suggestions: explicit ones and project defaults, with the number of sessions given each. */
export function allTags(db: Database): { tag: string; sessions: number }[] {
  return db
    .query<{ tag: string; sessions: number }, []>(
      `SELECT tag, SUM(n) AS sessions FROM (
         SELECT tag, COUNT(*) AS n FROM session_tags GROUP BY tag
         UNION ALL SELECT tag, 0 FROM project_tags
       ) GROUP BY tag ORDER BY sessions DESC, tag`,
    )
    .all();
}

/**
 * The tags each of these sessions has, from the session itself, its parent session and its project's default, by
 * session id. A session without any is left out of the map.
 */
export function tagsForSessions(db: Database, ids: string[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (id: string, tag: string) => {
    let set = out.get(id);
    if (!set) out.set(id, (set = new Set()));
    set.add(tag);
  };
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    for (const r of db.query<{ id: string; tag: string }, string[]>(`SELECT session_id AS id, tag FROM session_tags WHERE session_id IN (${marks})`).all(...chunk)) add(r.id, r.tag);
    for (const r of db
      .query<{ id: string; tag: string }, string[]>(
        `SELECT s.id, g.tag FROM sessions s JOIN session_tags g ON g.session_id = s.parent_session_id WHERE s.id IN (${marks})`,
      )
      .all(...chunk)) add(r.id, r.tag);
    for (const r of db
      .query<{ id: string; tag: string }, string[]>(`SELECT s.id, p.tag FROM sessions s JOIN project_tags p ON p.project = s.project WHERE s.id IN (${marks})`)
      .all(...chunk)) add(r.id, r.tag);
  }
  return new Map([...out].map(([id, set]) => [id, [...set].sort()]));
}
