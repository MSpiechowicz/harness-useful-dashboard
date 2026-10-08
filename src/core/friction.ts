import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { hasTable } from "./db.ts";
import { API_ERROR_CLASSES, type ApiErrorClass, storedApiClass } from "./apiErrors.ts";
import { type FailureReason, storedReason } from "./failures.ts";
import { type Bucket, bucketExpr, fillBuckets, type Filters, projectLabel, sessionTitle, whereClause } from "./queries.ts";

type Params = Record<string, string | number | null>;

/** Failures the recent-failures table lists, newest first (and failed model requests the API errors table lists). */
const RECENT_FAILURES = 200;

/**
 * Where tool calls and interrupts are counted, as `o`: the `outcome_counts` view, which adds the successful calls
 * rolled up into daily counts (rollup.ts) to the rows, each row standing for `n` outcomes. A reader that opened an
 * older database without migrating it (MCP, statusline, reports) has only the rows, one outcome each.
 */
function counted(db: Database): { from: string; counts: string } {
  const rolled = hasTable(db, "outcome_days");
  const n = rolled ? "o.n" : "1";
  const sum = (kind: string) => `COALESCE(SUM(CASE WHEN o.kind = '${kind}' THEN ${n} ELSE 0 END), 0)`;
  return {
    from: rolled ? "outcome_counts o" : "outcomes o",
    // How tool calls ended and prompts were stopped, counted per group.
    counts: `
      ${sum("tool_ok")}       AS ok,
      ${sum("tool_error")}    AS errors,
      ${sum("tool_rejected")} AS rejected,
      ${sum("interrupt")}     AS interrupts`,
  };
}

/** The outcome filters of a view: outcomes carry no skill, and failed model requests are counted apart from tool calls. */
function outcomeWhere(f: Filters) {
  const { skill: _skill, ...rest } = f;
  const filtered = whereClause(rest, "o");
  const tools = { ...filtered, sql: `${filtered.sql ? `${filtered.sql} AND` : "WHERE"} o.kind <> 'api_error'` };
  return { rest, filtered, tools };
}

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

/**
 * The headline counts of a range: tool calls by how they ended, interrupts, the share of finished calls that failed,
 * and failed model requests against the responses logged. Kept until the data changes.
 */
export function frictionTotals(db: Database, f: Filters) {
  return memo(db, `friction-totals:${JSON.stringify(f)}`, () => computeTotals(db, f));
}

function computeTotals(db: Database, f: Filters) {
  const { rest, filtered, tools } = outcomeWhere(f);
  const { from, counts } = counted(db);
  const totals = db.query<FrictionCounts, Params>(`SELECT ${counts} FROM ${from} ${tools.sql}`).get(tools.params)!;

  const wu = whereClause(rest);
  const requests = db.query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM usage u ${wu.sql}`).get(wu.params)!.n;
  const apiErrors = db
    .query<{ n: number }, Params>(`SELECT COUNT(*) AS n FROM outcomes o ${filtered.sql ? `${filtered.sql} AND` : "WHERE"} o.kind = 'api_error'`)
    .get(filtered.params)!.n;

  return { ...totals, errorRate: errorRate(totals), apiErrors, requests, apiErrorRate: requests ? apiErrors / (requests + apiErrors) : null };
}

function computeFriction(db: Database, f: Filters, bucket: Bucket) {
  // Tool calls and prompts only: failed model requests are counted apart (apiErrors below), never as tool failures.
  const { rest, filtered, tools: w } = outcomeWhere(f);
  const { from, counts } = counted(db);
  const all = <T>(sql: string, params: Params = w.params) => db.query<T, Params>(sql).all(params);
  const totals = db.query<FrictionCounts, Params>(`SELECT ${counts} FROM ${from} ${w.sql}`).get(w.params)!;
  const wu = whereClause(rest);
  const { prompts, requests } = db
    .query<{ prompts: number; requests: number }, Params>(`SELECT COUNT(DISTINCT u.prompt_id) AS prompts, COUNT(*) AS requests FROM usage u ${wu.sql}`)
    .get(wu.params)!;

  const rows = all<FrictionCounts & { bucket: string }>(`SELECT ${bucketExpr(bucket, "o.ts")} AS bucket, ${counts} FROM ${from} ${w.sql} GROUP BY bucket ORDER BY bucket`);
  const buckets = fillBuckets(rows.map((r) => r.bucket), bucket, f);
  const at = new Map(rows.map((r) => [r.bucket, r]));
  const zero: FrictionCounts = { ok: 0, errors: 0, rejected: 0, interrupts: 0 };
  const series = buckets.map((b) => {
    const c = at.get(b) ?? zero;
    return { bucket: b, errors: c.errors, rejected: c.rejected, interrupts: c.interrupts, errorRate: errorRate(c) };
  });

  const withRates = <T extends FrictionCounts>(r: T) => ({ ...r, calls: r.ok + r.errors + r.rejected, errorRate: errorRate(r), rejectRate: rejectRate(r) });
  // Summed: a bare `errors` here would be one subagent's row of the group, not the session's count.
  const noisy = "HAVING SUM(x.errors) + SUM(x.rejected) + SUM(x.interrupts) > 0";
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
    `SELECT o.tool AS key, ${counts} FROM ${from}
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
  const models = all<FrictionCounts & { key: string | null }>(`SELECT o.model AS key, ${counts} FROM ${from} ${w.sql} GROUP BY key ORDER BY errors + rejected + interrupts DESC`).map((r) =>
    withRates({ ...r, key: r.key ?? "(none)" }),
  );
  // Subagent sessions count toward the session that started them, which is the one to open. Outcomes are counted per
  // session first and titles looked up for the sessions listed only: per outcome row, both lookups cost seconds.
  const sessions = all<FrictionCounts & { id: string; title: string | null; project: string | null; provider: string; lastTs: number }>(
    `SELECT g.id, ${sessionTitle("root")} AS title, root.project, g.provider, g.lastTs, g.ok, g.errors, g.rejected, g.interrupts
     FROM (SELECT COALESCE(s.parent_session_id, x.session_id) AS id, MAX(x.provider) AS provider, MAX(x.lastTs) AS lastTs,
                  SUM(x.ok) AS ok, SUM(x.errors) AS errors, SUM(x.rejected) AS rejected, SUM(x.interrupts) AS interrupts
           FROM (SELECT o.session_id, MAX(o.provider) AS provider, MAX(o.ts) AS lastTs, ${counts} FROM ${from} ${w.sql} GROUP BY o.session_id) x
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

  // An error logged before the session's first reply names no model (Claude Code's failed sign-in): it goes to the
  // model the session went on to use, when it used one at all.
  const model = "COALESCE(o.model, (SELECT u.model FROM usage u WHERE u.session_id = o.session_id ORDER BY u.ts LIMIT 1))";
  const byModel = all<{ provider: string; model: string | null; reason: string | null; n: number; lastTs: number }>(
    `SELECT o.provider, ${model} AS model, o.reason, COUNT(*) AS n, MAX(o.ts) AS lastTs FROM outcomes o ${where} GROUP BY o.provider, 2, o.reason`,
  );
  const models = new Map<string, { provider: string; model: string | null; count: number; lastTs: number; classes: Map<ApiErrorClass, number> }>();
  for (const r of byModel) {
    // Errors no model can be given (sign-in failed before any reply) count in the chart and the list, not here.
    if (r.model == null) continue;
    const key = `${r.provider}|${r.model ?? ""}`;
    const m = models.get(key) ?? { provider: r.provider, model: r.model, count: 0, lastTs: 0, classes: new Map() };
    const cls = storedApiClass(r.reason);
    m.count += r.n;
    m.lastTs = Math.max(m.lastTs, r.lastTs);
    m.classes.set(cls, (m.classes.get(cls) ?? 0) + r.n);
    models.set(key, m);
  }
  const perModel = [...models.values()]
    .map((m) => ({ provider: m.provider, model: m.model!, count: m.count, lastTs: m.lastTs, topClass: [...m.classes].sort((a, b) => b[1] - a[1])[0]![0] }))
    .sort((a, b) => b.count - a.count);

  // A subagent's error opens the session that started it.
  const recent = all<{
    id: string; ts: number; provider: string; model: string | null; reason: string | null; status: number | null; detail: string | null;
    sessionId: string; title: string | null; project: string | null;
  }>(
    `SELECT e.id, e.ts, e.provider, e.model, e.reason, e.status, e.detail, COALESCE(s.parent_session_id, e.session_id) AS sessionId,
            ${sessionTitle("root")} AS title, root.project
     FROM (SELECT o.*, ${model} AS model FROM outcomes o ${where} ORDER BY o.ts DESC LIMIT ${RECENT_FAILURES}) e
     LEFT JOIN sessions s ON s.id = e.session_id
     LEFT JOIN sessions root ON root.id = COALESCE(s.parent_session_id, e.session_id)
     ORDER BY e.ts DESC`,
  ).map((r) => ({ ...r, reason: storedApiClass(r.reason), projectLabel: projectLabel(r.project) }));

  return { total, requests, rate: requests ? total / (requests + total) : null, buckets, series, classes, models: perModel, recent };
}
