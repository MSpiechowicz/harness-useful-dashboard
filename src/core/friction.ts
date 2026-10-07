import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { API_ERROR_CLASSES, type ApiErrorClass, storedApiClass } from "./apiErrors.ts";
import { type FailureReason, storedReason } from "./failures.ts";
import { type Bucket, bucketExpr, fillBuckets, type Filters, projectLabel, sessionTitle, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/** Failures the recent-failures table lists, newest first (and failed model requests the API errors table lists). */
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
  const filtered = whereClause(rest, "o");
  // Tool calls and prompts only: failed model requests are counted apart (apiErrors below), never as tool failures.
  const w = { ...filtered, sql: `${filtered.sql ? `${filtered.sql} AND` : "WHERE"} o.kind <> 'api_error'` };
  const all = <T>(sql: string, params: Params = w.params) => db.query<T, Params>(sql).all(params);
  const totals = db.query<FrictionCounts, Params>(`SELECT ${COUNTS} FROM outcomes o ${w.sql}`).get(w.params)!;
  const wu = whereClause(rest);
  const { prompts, requests } = db
    .query<{ prompts: number; requests: number }, Params>(`SELECT COUNT(DISTINCT u.prompt_id) AS prompts, COUNT(*) AS requests FROM usage u ${wu.sql}`)
    .get(wu.params)!;

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
  const and = `${w.sql} AND`;
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
    apiErrors: apiErrors(db, filtered, bucket, buckets, requests),
  };
}

/**
 * Failed model requests (see apiErrors.ts): counted by class over time and by harness and model, with the latest ones and
 * what they said. `requests` is the model responses logged in the same range, for the share that failed.
 */
function apiErrors(db: Database, w: { sql: string; params: Params }, bucket: Bucket, toolBuckets: string[], requests: number) {
  const where = `${w.sql ? `${w.sql} AND` : "WHERE"} o.kind = 'api_error'`;
  const all = <T>(sql: string) => db.query<T, Params>(sql).all(w.params);
  const byBucket = all<{ bucket: string; reason: string | null; n: number }>(
    `SELECT ${bucketExpr(bucket, "o.ts")} AS bucket, o.reason, COUNT(*) AS n FROM outcomes o ${where} GROUP BY bucket, o.reason`,
  );
  const total = byBucket.reduce((s, r) => s + r.n, 0);
  const counts = new Map<ApiErrorClass, number>();
  const cells = new Map<string, number>();
  for (const r of byBucket) {
    const cls = storedApiClass(r.reason);
    counts.set(cls, (counts.get(cls) ?? 0) + r.n);
    cells.set(`${r.bucket}|${cls}`, (cells.get(`${r.bucket}|${cls}`) ?? 0) + r.n);
  }
  // In their fixed order rather than by count, so a class keeps its place in the stack and the legend.
  const classes = API_ERROR_CLASSES.filter((cls) => counts.has(cls)).map((cls) => ({ cls, count: counts.get(cls)!, share: total ? counts.get(cls)! / total : 0 }));
  // The same buckets as the tool charts above, so the two line up.
  const buckets = [...new Set([...toolBuckets, ...byBucket.map((r) => r.bucket)])].sort();
  const series = classes.map(({ cls }) => ({ key: cls, data: buckets.map((b) => cells.get(`${b}|${cls}`) ?? 0) }));

  const byModel = all<{ provider: string; model: string | null; reason: string | null; n: number; lastTs: number }>(
    `SELECT o.provider, o.model, o.reason, COUNT(*) AS n, MAX(o.ts) AS lastTs FROM outcomes o ${where} GROUP BY o.provider, o.model, o.reason`,
  );
  const models = new Map<string, { provider: string; model: string | null; count: number; lastTs: number; classes: Map<ApiErrorClass, number> }>();
  for (const r of byModel) {
    const key = `${r.provider}|${r.model ?? ""}`;
    const m = models.get(key) ?? { provider: r.provider, model: r.model, count: 0, lastTs: 0, classes: new Map() };
    const cls = storedApiClass(r.reason);
    m.count += r.n;
    m.lastTs = Math.max(m.lastTs, r.lastTs);
    m.classes.set(cls, (m.classes.get(cls) ?? 0) + r.n);
    models.set(key, m);
  }
  const perModel = [...models.values()]
    .map((m) => ({ provider: m.provider, model: m.model ?? "(none)", count: m.count, lastTs: m.lastTs, topClass: [...m.classes].sort((a, b) => b[1] - a[1])[0]![0] }))
    .sort((a, b) => b.count - a.count);

  // A subagent's error opens the session that started it.
  const recent = all<{
    id: string; ts: number; provider: string; model: string | null; reason: string | null; status: number | null; detail: string | null;
    sessionId: string; title: string | null; project: string | null;
  }>(
    `SELECT e.id, e.ts, e.provider, e.model, e.reason, e.status, e.detail, COALESCE(s.parent_session_id, e.session_id) AS sessionId,
            ${sessionTitle("root")} AS title, root.project
     FROM (SELECT o.* FROM outcomes o ${where} ORDER BY o.ts DESC LIMIT ${RECENT_FAILURES}) e
     LEFT JOIN sessions s ON s.id = e.session_id
     LEFT JOIN sessions root ON root.id = COALESCE(s.parent_session_id, e.session_id)
     ORDER BY e.ts DESC`,
  ).map((r) => ({ ...r, reason: storedApiClass(r.reason), projectLabel: projectLabel(r.project) }));

  return { total, requests, rate: requests ? total / (requests + total) : null, buckets, series, classes, models: perModel, recent };
}
