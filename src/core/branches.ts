import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { per100 } from "./changes.ts";
import { bucketExpr, EDIT_TOOLS, fillBuckets, type Filters, projectLabel, sessionTitle, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/** Subagent sessions don't log a branch: they work on the one of the session that started them. */
const JOIN = "LEFT JOIN sessions s ON s.id = u.session_id LEFT JOIN sessions ps ON ps.id = s.parent_session_id";
const BRANCH = "COALESCE(s.git_branch, ps.git_branch)";
const ROOT = "COALESCE(s.parent_session_id, u.session_id)";
/** The same for tool calls: an edit's lines count toward the branch of its session. */
const TJOIN = "LEFT JOIN sessions s ON s.id = t.session_id LEFT JOIN sessions ps ON ps.id = s.parent_session_id";
const TROOT = "COALESCE(s.parent_session_id, t.session_id)";
const LINES = "COALESCE(SUM(t.lines_added), 0) AS added, COALESCE(SUM(t.lines_removed), 0) AS removed";

/** Branches most repositories keep for good: work on them isn't one piece of work. */
export const LONG_LIVED = new Set(["main", "master", "trunk", "develop", "development", "dev", "HEAD"]);

export const NO_BRANCH = "(none)";

/** A branch is only unique within its project. Git refs can't contain ":", so the branch goes first. */
export function branchId(branch: string, project: string | null): string {
  return `${branch}:${project ?? ""}`;
}

export function parseBranchId(id: string): { branch: string; project: string | null } {
  const at = id.indexOf(":");
  if (at < 0) return { branch: id, project: null };
  return { branch: id.slice(0, at), project: id.slice(at + 1) || null };
}

const SUMS = `COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost, COUNT(*) AS messages,
  COUNT(DISTINCT ${ROOT}) AS sessions, COUNT(DISTINCT u.prompt_id) AS prompts, MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs`;

export interface BranchRow {
  id: string;
  branch: string;
  project: string | null;
  projectLabel: string;
  longLived: boolean;
  tokens: number;
  cost: number;
  messages: number;
  sessions: number;
  prompts: number;
  firstTs: number;
  lastTs: number;
  days: number;
  /** Lines the branch's edits added and removed, and the branch's cost per 100 of them (null: none changed). */
  added: number;
  removed: number;
  costPer100: number | null;
}

/** Usage by git branch, per project: what each piece of work cost. */
export function branches(db: Database, f: Filters) {
  return memo(db, `branches:${JSON.stringify(f)}`, () => computeBranches(db, f));
}

function computeBranches(db: Database, f: Filters) {
  const w = whereClause(f);
  const rows = db
    .query<Omit<BranchRow, "id" | "projectLabel" | "longLived">, Params>(
      `SELECT COALESCE(${BRANCH}, '${NO_BRANCH}') AS branch, u.project AS project, ${SUMS},
              COUNT(DISTINCT ${bucketExpr("day")}) AS days
       FROM usage u ${JOIN} ${w.sql}
       GROUP BY branch, u.project ORDER BY cost DESC LIMIT 500`,
    )
    .all(w.params);
  const total = db.query<{ cost: number; tokens: number }, Params>(`SELECT COALESCE(SUM(u.cost_usd), 0) AS cost, COALESCE(SUM(u.total_tokens), 0) AS tokens FROM usage u ${w.sql}`).get(w.params)!;
  const wt = whereClause(f, "t");
  const lines = new Map(
    db
      .query<{ branch: string; project: string | null; added: number; removed: number }, Params>(
        `SELECT COALESCE(${BRANCH}, '${NO_BRANCH}') AS branch, t.project AS project, ${LINES}
         FROM tool_calls t ${TJOIN} ${wt.sql ? `${wt.sql} AND` : "WHERE"} t.lines_added IS NOT NULL
         GROUP BY branch, t.project`,
      )
      .all(wt.params)
      .map((r) => [branchId(r.branch, r.project), r]),
  );
  return {
    total,
    rows: rows.map((r): BranchRow => {
      const id = branchId(r.branch, r.project);
      const l = lines.get(id);
      const added = l?.added ?? 0;
      const removed = l?.removed ?? 0;
      return { ...r, id, projectLabel: projectLabel(r.project), longLived: LONG_LIVED.has(r.branch), added, removed, costPer100: per100(r.cost, added + removed) };
    }),
  };
}

/** One branch over its whole life: its sessions, day by day cost, models and the files it changed. */
export function branchDetail(db: Database, id: string) {
  const { branch, project } = parseBranchId(id);
  const cond = `${branch === NO_BRANCH ? `${BRANCH} IS NULL` : `${BRANCH} = $branch`} AND ${project == null ? "u.project IS NULL" : "u.project = $project"}`;
  const params: Params = {};
  if (branch !== NO_BRANCH) params.branch = branch;
  if (project != null) params.project = project;
  const where = `WHERE ${cond}`;
  const twhere = `WHERE ${cond.replace("u.project", "t.project")} AND t.lines_added IS NOT NULL`;
  const totals = db.query<{ tokens: number; cost: number; messages: number; sessions: number; prompts: number; firstTs: number | null; lastTs: number | null }, Params>(
    `SELECT ${SUMS} FROM usage u ${JOIN} ${where}`,
  ).get(params)!;
  const days = db
    .query<{ bucket: string; cost: number; tokens: number }, Params>(
      `SELECT ${bucketExpr("day")} AS bucket, COALESCE(SUM(u.cost_usd), 0) AS cost, COALESCE(SUM(u.total_tokens), 0) AS tokens
       FROM usage u ${JOIN} ${where} GROUP BY bucket ORDER BY bucket`,
    )
    .all(params);
  const buckets = totals.firstTs != null ? fillBuckets(days.map((d) => d.bucket), "day", { from: totals.firstTs, to: totals.lastTs! + 1 }) : [];
  const at = new Map(days.map((d) => [d.bucket, d]));
  const sessions = db
    .query<{ id: string; title: string | null; provider: string; tokens: number; cost: number; messages: number; prompts: number; subagents: number; firstTs: number; lastTs: number }, Params>(
      // Titles are looked up once per session, after grouping, rather than per usage row.
      `SELECT g.id, ${sessionTitle("root")} AS title, root.provider, g.tokens, g.cost, g.messages, g.prompts, g.subagents, g.firstTs, g.lastTs
       FROM (SELECT ${ROOT} AS id, COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost, COUNT(*) AS messages,
                    COUNT(DISTINCT u.prompt_id) AS prompts, COUNT(DISTINCT CASE WHEN u.session_id <> ${ROOT} THEN u.session_id END) AS subagents,
                    MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
             FROM usage u ${JOIN} ${where} GROUP BY ${ROOT}) g
       LEFT JOIN sessions root ON root.id = g.id
       ORDER BY g.lastTs DESC`,
    )
    .all(params);
  const models = db
    .query<{ key: string | null; tokens: number; cost: number; messages: number }, Params>(
      `SELECT u.model AS key, COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost, COUNT(*) AS messages
       FROM usage u ${JOIN} ${where} GROUP BY u.model ORDER BY cost DESC`,
    )
    .all(params);
  const lines = db.query<{ added: number; removed: number; files: number }, Params>(
    `SELECT ${LINES}, COUNT(DISTINCT t.file_path) AS files FROM tool_calls t ${TJOIN} ${twhere}`,
  ).get(params)!;
  const sessionLines = new Map(
    db.query<{ id: string; added: number; removed: number }, Params>(`SELECT ${TROOT} AS id, ${LINES} FROM tool_calls t ${TJOIN} ${twhere} GROUP BY ${TROOT}`)
      .all(params)
      .map((r) => [r.id, r]),
  );
  const modelLines = new Map(
    db.query<{ key: string | null; added: number; removed: number }, Params>(`SELECT t.model AS key, ${LINES} FROM tool_calls t ${TJOIN} ${twhere} GROUP BY t.model`)
      .all(params)
      .map((r) => [r.key ?? "(none)", r]),
  );
  // The files the branch's sessions changed: tool calls carry the session, not the branch.
  const files = db
    .query<{ key: string; edits: number }, Params>(
      `SELECT t.file_path AS key, COUNT(*) AS edits FROM tool_calls t
       WHERE t.session_id IN (SELECT DISTINCT u.session_id FROM usage u ${JOIN} ${where})
         AND t.file_path IS NOT NULL AND t.tool IN (${EDIT_TOOLS})
       GROUP BY t.file_path ORDER BY edits DESC LIMIT 500`,
    )
    .all(params);
  return {
    branch,
    project,
    projectLabel: projectLabel(project),
    longLived: LONG_LIVED.has(branch),
    totals,
    lines: { ...lines, costPer100: per100(totals.cost, lines.added + lines.removed) },
    days: { buckets, cost: buckets.map((b) => at.get(b)?.cost ?? 0), tokens: buckets.map((b) => at.get(b)?.tokens ?? 0) },
    sessions: sessions.map((x) => ({ ...x, added: sessionLines.get(x.id)?.added ?? 0, removed: sessionLines.get(x.id)?.removed ?? 0 })),
    models: models.map((m) => {
      const key = m.key ?? "(none)";
      const l = modelLines.get(key);
      return { ...m, key, added: l?.added ?? 0, removed: l?.removed ?? 0, costPer100: per100(m.cost, (l?.added ?? 0) + (l?.removed ?? 0)) };
    }),
    files,
  };
}
