import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { per100 } from "./changes.ts";
import { type Filters, TOKEN_SUMS, type Totals, whereClause } from "./queries.ts";
import { UNTAGGED } from "./tags.ts";

type Params = Record<string, string | number | null>;

export interface TagRow extends Totals {
  key: string;
  label: string;
  sessions: number;
  prompts: number;
  firstTs: number;
  lastTs: number;
  /** 1 when a price of some of its calls is estimated. */
  estimated: number;
  cacheHitRate: number;
  /** Shares of the whole scope's spend and tokens. A session with several tags counts in each, so they can add up to more than 1. */
  share: number;
  tokenShare: number;
  added: number;
  removed: number;
  changed: number;
  /** Cost per 100 changed lines, null when the tag's sessions changed none. */
  costPer100: number | null;
}

/**
 * What each tag cost: tokens, cost, sessions, prompts and changed lines of the sessions that carry it, a subagent's
 * session counting for its parent's tags and every session of a project for the project's default tag. Sessions
 * without a tag are the "(none)" row. A session with several tags is counted in each of them, so the rows can add up
 * to more than `total`, which is the scope's own spend.
 *
 * Resolved here from per-session sums rather than by joining every usage row to its tags: the sums are one row per
 * session, and the tags of a session are a handful.
 */
export function tagUsage(db: Database, f: Filters) {
  return memo(db, `tagUsage:${JSON.stringify(f)}`, () => compute(db, f, "tag"));
}

/**
 * What each kind of work cost (labels.ts): the same per-session sums as tagUsage, grouped by the kind of the session, or
 * of its parent session for a subagent's. Every session has at most one kind, so the rows add up to `total`, except that
 * the "(none)" row holds the sessions without a label.
 */
export function kindUsage(db: Database, f: Filters) {
  return memo(db, `kindUsage:${JSON.stringify(f)}`, () => compute(db, f, "kind"));
}

function compute(db: Database, f: Filters, by: "tag" | "kind") {
  const w = whereClause(f);
  const wt = whereClause(f, "t");
  const sessions = db
    .query<Totals & { id: string; project: string | null; prompts: number; firstTs: number; lastTs: number; estimated: number }, Params>(
      `SELECT u.session_id AS id, u.project, ${TOKEN_SUMS}, COUNT(DISTINCT u.prompt_id) AS prompts, MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs,
              MAX(u.cost_estimated) AS estimated
       FROM usage u ${w.sql} GROUP BY u.session_id, u.project`,
    )
    .all(w.params);
  const edits = db
    .query<{ id: string; project: string | null; added: number; removed: number }, Params>(
      `SELECT t.session_id AS id, t.project, COALESCE(SUM(t.lines_added), 0) AS added, COALESCE(SUM(t.lines_removed), 0) AS removed
       FROM tool_calls t ${wt.sql ? `${wt.sql} AND` : "WHERE"} t.lines_added IS NOT NULL GROUP BY t.session_id, t.project`,
    )
    .all(wt.params);

  const own = new Map<string, string[]>();
  const source = by === "kind" ? "SELECT session_id AS id, kind AS tag FROM session_labels" : "SELECT session_id AS id, tag FROM session_tags";
  for (const r of db.query<{ id: string; tag: string }, []>(source).all()) {
    (own.get(r.id) ?? own.set(r.id, []).get(r.id)!).push(r.tag);
  }
  const parent = new Map(db.query<{ id: string; parent: string }, []>("SELECT id, parent_session_id AS parent FROM sessions WHERE parent_session_id IS NOT NULL").all().map((r) => [r.id, r.parent]));
  // A project's default tag has no counterpart for kinds.
  const rule = new Map(by === "kind" ? [] : db.query<{ project: string; tag: string }, []>("SELECT project, tag FROM project_tags").all().map((r) => [r.project, r.tag]));
  const tagsOf = (id: string, project: string | null): Set<string> => {
    const tags = new Set([...(own.get(id) ?? []), ...(own.get(parent.get(id) ?? "") ?? [])]);
    const byProject = project ? rule.get(project) : undefined;
    if (byProject) tags.add(byProject);
    return tags;
  };

  interface Acc extends Totals {
    sessions: Set<string>;
    prompts: number;
    firstTs: number;
    lastTs: number;
    estimated: number;
    added: number;
    removed: number;
  }
  const acc = new Map<string, Acc>();
  const at = (tag: string): Acc => {
    let a = acc.get(tag);
    if (!a) {
      acc.set(tag, (a = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, messages: 0, sessions: new Set(), prompts: 0, firstTs: Infinity, lastTs: 0, estimated: 0, added: 0, removed: 0 }));
    }
    return a;
  };
  const tagged = (id: string, project: string | null) => {
    const tags = tagsOf(id, project);
    return tags.size ? [...tags] : [UNTAGGED];
  };
  for (const s of sessions) {
    for (const tag of tagged(s.id, s.project)) {
      const a = at(tag);
      for (const k of ["tokens", "input", "output", "cacheRead", "cacheWrite", "reasoning", "cost", "messages", "prompts"] as const) a[k] += s[k];
      a.sessions.add(s.id);
      a.firstTs = Math.min(a.firstTs, s.firstTs);
      a.lastTs = Math.max(a.lastTs, s.lastTs);
      a.estimated = Math.max(a.estimated, s.estimated);
    }
  }
  for (const e of edits) {
    for (const tag of tagged(e.id, e.project)) {
      // Lines of a session that spent nothing in the range still count toward a tag the range has usage for.
      if (!acc.has(tag)) continue;
      const a = at(tag);
      a.added += e.added;
      a.removed += e.removed;
    }
  }

  const total = sessions.reduce((a, s) => ({ tokens: a.tokens + s.tokens, cost: a.cost + s.cost }), { tokens: 0, cost: 0 });
  const rows: TagRow[] = [...acc]
    .map(([key, a]): TagRow => {
      const changed = a.added + a.removed;
      return {
        ...a,
        key,
        label: key,
        sessions: a.sessions.size,
        cacheHitRate: a.input + a.cacheRead + a.cacheWrite ? a.cacheRead / (a.input + a.cacheRead + a.cacheWrite) : 0,
        share: total.cost ? a.cost / total.cost : 0,
        tokenShare: total.tokens ? a.tokens / total.tokens : 0,
        changed,
        costPer100: per100(a.cost, changed),
      };
    })
    .sort((a, b) => b.cost - a.cost);
  return { total, rows };
}
