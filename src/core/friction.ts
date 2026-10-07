import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { type FailureReason, storedReason } from "./failures.ts";
import { type Bucket, bucketExpr, fillBuckets, type Filters, projectLabel, sessionTitle, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/** Failures the recent-failures table lists, newest first. */
const RECENT_FAILURES = 200;

/** How tool calls ended and prompts were stopped, counted per group. */
const COUNTS = `
  COALESCE(SUM(o.kind = 'tool_ok'), 0)       AS ok,
  COALESCE(SUM(o.kind = 'tool_error'), 0)    AS errors,
  COALESCE(SUM(o.kind = 'tool_rejected'), 0) AS rejected,
  COALESCE(SUM(o.kind = 'interrupt'), 0)     AS interrupts`;

export interface FrictionCounts {
  ok: number;
  errors: number;
  rejected: number;
  interrupts: number;
}

/** Share of finished tool calls that failed: calls the user or the harness stopped are left out, as in model drift. */
export function errorRate(c: FrictionCounts): number | null {
  return c.ok + c.errors ? c.errors / (c.ok + c.errors) : null;
}

/** Share of tool calls the user turned down. */
export function rejectRate(c: FrictionCounts): number | null {
  const n = c.ok + c.errors + c.rejected;
  return n ? c.rejected / n : null;
}

/**
 * Where work gets stuck: failed and rejected tool calls and interrupted prompts, over time and by tool, model, project
 * and session, why calls failed, and the latest failures with their error text. Outcomes carry no skill, so that filter
 * doesn't apply.
 */
export function friction(db: Database, f: Filters, bucket: Bucket) {
  return memo(db, `friction:${bucket}:${JSON.stringify(f)}`, () => computeFriction(db, f, bucket));
}

function computeFriction(db: Database, f: Filters, bucket: Bucket) {
  const { skill: _skill, ...rest } = f;
  const w = whereClause(rest, "o");
  const all = <T>(sql: string, params: Params = w.params) => db.query<T, Params>(sql).all(params);
  const totals = db.query<FrictionCounts, Params>(`SELECT ${COUNTS} FROM outcomes o ${w.sql}`).get(w.params)!;
  const wu = whereClause(rest);
  const prompts = db.query<{ n: number }, Params>(`SELECT COUNT(DISTINCT u.prompt_id) AS n FROM usage u ${wu.sql}`).get(wu.params)!.n;

  const rows = all<FrictionCounts & { bucket: string }>(`SELECT ${bucketExpr(bucket, "o.ts")} AS bucket, ${COUNTS} FROM outcomes o ${w.sql} GROUP BY bucket ORDER BY bucket`);
  const buckets = fillBuckets(rows.map((r) => r.bucket), bucket, f);
  const at = new Map(rows.map((r) => [r.bucket, r]));
  const zero: FrictionCounts = { ok: 0, errors: 0, rejected: 0, interrupts: 0 };
  const series = buckets.map((b) => {
    const c = at.get(b) ?? zero;
    return { bucket: b, errors: c.errors, rejected: c.rejected, interrupts: c.interrupts, errorRate: errorRate(c) };
  });

  const withRates = <T extends FrictionCounts>(r: T) => ({ ...r, calls: r.ok + r.errors + r.rejected, errorRate: errorRate(r), rejectRate: rejectRate(r) });
  const noisy = "HAVING errors + rejected + interrupts > 0";
  const and = w.sql ? `${w.sql} AND` : "WHERE";
  const failed = `${and} o.kind IN ('tool_error', 'tool_rejected')`;

  // Why calls failed: failures counted by reason and tool, then summed per reason (with its tools) and per tool.
  const byReasonTool = all<{ reason: string | null; kind: string; tool: string | null; n: number }>(
    `SELECT o.reason, o.kind, o.tool, COUNT(*) AS n FROM outcomes o ${failed} GROUP BY o.reason, o.kind, o.tool`,
  );
  const reasonMap = new Map<FailureReason, { count: number; tools: Map<string, number> }>();
  const toolReasons = new Map<string, Map<FailureReason, number>>();
  for (const r of byReasonTool) {
    const reason = storedReason(r.kind, r.reason);
    const tool = r.tool ?? "(none)";
    const e = reasonMap.get(reason) ?? { count: 0, tools: new Map() };
    e.count += r.n;
    e.tools.set(tool, (e.tools.get(tool) ?? 0) + r.n);
    reasonMap.set(reason, e);
    const t = toolReasons.get(tool) ?? new Map();
    t.set(reason, (t.get(reason) ?? 0) + r.n);
    toolReasons.set(tool, t);
  }
  const failures = totals.errors + totals.rejected;
  const top = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]);
  const reasons = [...reasonMap]
    .map(([reason, e]) => ({ reason, count: e.count, share: failures ? e.count / failures : 0, tools: top(e.tools).slice(0, 3).map(([tool, count]) => ({ tool, count })) }))
    .sort((a, b) => b.count - a.count);

  // Codex names its tool results differently from its tool calls: outcomes read before they carried their tool have none.
  const tools = all<FrictionCounts & { key: string | null }>(
    `SELECT o.tool AS key, ${COUNTS} FROM outcomes o
     ${and} o.kind <> 'interrupt' GROUP BY key ORDER BY errors + rejected DESC, ok DESC LIMIT 50`,
  ).map((r) => {
    const key = r.key ?? "(none)";
    const main = top(toolReasons.get(key) ?? new Map<FailureReason, number>()).find(([reason]) => reason !== "rejected");
    return { ...withRates({ ...r, key }), topReason: main?.[0] ?? null };
  });

  // The latest failures with what each said, for the table under the reasons. A subagent's failure opens the session
  // that started it.
  const recent = all<{
    id: string; ts: number; kind: string; tool: string | null; reason: string | null; detail: string | null; input: string | null;
    sessionId: string; title: string | null; provider: string; project: string | null;
  }>(
    `SELECT f.id, f.ts, f.kind, f.tool, f.reason, f.detail, f.input, COALESCE(s.parent_session_id, f.session_id) AS sessionId,
            ${sessionTitle("root")} AS title, f.provider, root.project
     FROM (SELECT o.* FROM outcomes o ${failed} ORDER BY o.ts DESC LIMIT ${RECENT_FAILURES}) f
     LEFT JOIN sessions s ON s.id = f.session_id
     LEFT JOIN sessions root ON root.id = COALESCE(s.parent_session_id, f.session_id)
     ORDER BY f.ts DESC`,
  ).map((r) => ({ ...r, reason: storedReason(r.kind, r.reason), projectLabel: projectLabel(r.project) }));
  const models = all<FrictionCounts & { key: string | null }>(`SELECT o.model AS key, ${COUNTS} FROM outcomes o ${w.sql} GROUP BY key ORDER BY errors + rejected + interrupts DESC`).map((r) =>
    withRates({ ...r, key: r.key ?? "(none)" }),
  );
  // Subagent sessions count toward the session that started them, which is the one to open. Outcomes are counted per
  // session first and titles looked up for the sessions listed only: per outcome row, both lookups cost seconds.
  const sessions = all<FrictionCounts & { id: string; title: string | null; project: string | null; provider: string; lastTs: number }>(
    `SELECT g.id, ${sessionTitle("root")} AS title, root.project, g.provider, g.lastTs, g.ok, g.errors, g.rejected, g.interrupts
     FROM (SELECT COALESCE(s.parent_session_id, x.session_id) AS id, MAX(x.provider) AS provider, MAX(x.lastTs) AS lastTs,
                  SUM(x.ok) AS ok, SUM(x.errors) AS errors, SUM(x.rejected) AS rejected, SUM(x.interrupts) AS interrupts
           FROM (SELECT o.session_id, MAX(o.provider) AS provider, MAX(o.ts) AS lastTs, ${COUNTS} FROM outcomes o ${w.sql} GROUP BY o.session_id) x
           LEFT JOIN sessions s ON s.id = x.session_id
           GROUP BY 1 ${noisy} ORDER BY errors + rejected + interrupts DESC LIMIT 100) g
     LEFT JOIN sessions root ON root.id = g.id
     ORDER BY g.errors + g.rejected + g.interrupts DESC`,
  ).map((r) => withRates({ ...r, projectLabel: projectLabel(r.project) }));

  return {
    totals: { ...withRates(totals), prompts, interruptsPer100: prompts ? (totals.interrupts / prompts) * 100 : null },
    buckets,
    series,
    tools,
    models,
    sessions,
    reasons,
    recent,
  };
}
