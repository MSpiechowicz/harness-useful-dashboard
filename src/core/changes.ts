import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { type Bucket, bucketExpr, fillBuckets, type Filters, projectLabel, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/**
 * What the money bought: the lines the agents' edits added and removed (ingest/lines.ts), and what 100 changed lines
 * cost. An edit is a tool call with a line count, so failed edits, reads and commands are left out. The cost is all of
 * the spend in the same scope (planning, reviews and questions too), so cost per 100 lines is what the work cost per
 * change it made, not what the edits alone cost.
 */
export type LinesDim = "project" | "model" | "provider";
export const LINES_DIMS: readonly LinesDim[] = ["project", "model", "provider"];

export interface LineTotals {
  added: number;
  removed: number;
  /** Added plus removed. */
  changed: number;
  edits: number;
  files: number;
  cost: number;
  /** Cost per 100 changed lines, null when nothing was changed. */
  costPer100: number | null;
}

export interface LineRow extends LineTotals {
  key: string;
  label: string;
}

const EDITS = "t.lines_added IS NOT NULL";
const SUMS = `COALESCE(SUM(t.lines_added), 0) AS added, COALESCE(SUM(t.lines_removed), 0) AS removed, COUNT(*) AS edits`;

/** Cost per 100 changed lines, null when there are none. */
export const per100 = (cost: number, changed: number): number | null => (changed > 0 ? (cost / changed) * 100 : null);

const withRate = <T extends { added: number; removed: number; cost: number }>(r: T): T & { changed: number; costPer100: number | null } => {
  const changed = r.added + r.removed;
  return { ...r, changed, costPer100: per100(r.cost, changed) };
};

function and(where: string, cond: string): string {
  return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
}

/** Lines changed in the filtered scope, and split by project, model or provider. */
export function lines(db: Database, f: Filters, dim?: LinesDim) {
  return memo(db, `lines:${dim ?? ""}:${JSON.stringify(f)}`, () => computeLines(db, f, dim));
}

function computeLines(db: Database, f: Filters, dim?: LinesDim) {
  const wt = whereClause(f, "t");
  const w = whereClause(f);
  const edits = and(wt.sql, EDITS);
  const t = db
    .query<{ added: number; removed: number; edits: number; files: number }, Params>(
      `SELECT ${SUMS}, COUNT(DISTINCT t.file_path) AS files FROM tool_calls t ${edits}`,
    )
    .get(wt.params)!;
  const cost = db.query<{ cost: number }, Params>(`SELECT COALESCE(SUM(u.cost_usd), 0) AS cost FROM usage u ${w.sql}`).get(w.params)!.cost;
  const total: LineTotals = withRate({ ...t, cost });
  if (!dim) return { total, rows: [] as LineRow[] };

  const byKey = new Map<string, { added: number; removed: number; edits: number; files: number; cost: number }>();
  const at = (key: string | null) => {
    const k = key ?? "(none)";
    let r = byKey.get(k);
    if (!r) byKey.set(k, (r = { added: 0, removed: 0, edits: 0, files: 0, cost: 0 }));
    return r;
  };
  for (const r of db
    .query<{ key: string | null; added: number; removed: number; edits: number; files: number }, Params>(
      `SELECT t.${dim} AS key, ${SUMS}, COUNT(DISTINCT t.file_path) AS files FROM tool_calls t ${edits} GROUP BY t.${dim}`,
    )
    .all(wt.params)) {
    Object.assign(at(r.key), { added: r.added, removed: r.removed, edits: r.edits, files: r.files });
  }
  for (const r of db.query<{ key: string | null; cost: number }, Params>(`SELECT u.${dim} AS key, SUM(u.cost_usd) AS cost FROM usage u ${w.sql} GROUP BY u.${dim}`).all(w.params)) {
    at(r.key).cost = r.cost;
  }
  // Only what changed code: a model that only answered questions has no cost per line.
  const rows = [...byKey]
    .filter(([, r]) => r.edits > 0)
    .map(([key, r]): LineRow => ({ key, label: dim === "project" ? projectLabel(key === "(none)" ? null : key) : key, ...withRate(r) }))
    .sort((a, b) => b.changed - a.changed);
  return { total, rows };
}

/** Lines added and removed per time bucket, with what was spent in each. */
export function linesSeries(db: Database, f: Filters, bucket: Bucket) {
  return memo(db, `linesSeries:${bucket}:${JSON.stringify(f)}`, () => {
    const wt = whereClause(f, "t");
    const w = whereClause(f);
    const rows = db
      .query<{ bucket: string; added: number; removed: number }, Params>(
        `SELECT ${bucketExpr(bucket, "t.ts")} AS bucket, ${SUMS} FROM tool_calls t ${and(wt.sql, EDITS)} GROUP BY bucket ORDER BY bucket`,
      )
      .all(wt.params);
    const costs = db
      .query<{ bucket: string; cost: number }, Params>(`SELECT ${bucketExpr(bucket)} AS bucket, SUM(u.cost_usd) AS cost FROM usage u ${w.sql} GROUP BY bucket`)
      .all(w.params);
    const buckets = fillBuckets([...rows.map((r) => r.bucket), ...costs.map((r) => r.bucket)], bucket, f);
    const at = new Map(rows.map((r) => [r.bucket, r]));
    const spent = new Map(costs.map((r) => [r.bucket, r.cost]));
    return {
      buckets,
      added: buckets.map((b) => at.get(b)?.added ?? 0),
      removed: buckets.map((b) => at.get(b)?.removed ?? 0),
      cost: buckets.map((b) => spent.get(b) ?? 0),
    };
  });
}

/** One session's lines (its own edits, not its subagents' sessions). */
export function sessionLines(db: Database, sessionId: string, cost: number) {
  const r = db
    .query<{ added: number; removed: number; edits: number; files: number }, [string]>(
      `SELECT ${SUMS}, COUNT(DISTINCT t.file_path) AS files FROM tool_calls t WHERE t.session_id = ? AND ${EDITS}`,
    )
    .get(sessionId)!;
  return withRate({ ...r, cost });
}
