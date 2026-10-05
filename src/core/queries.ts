import type { Database } from "bun:sqlite";
import { normalizeModel, type PriceBook } from "./pricing.ts";

export interface Filters {
  from?: number;
  to?: number;
  provider?: string;
  project?: string;
  user?: string;
  model?: string;
  skill?: string;
  agent?: string;
}

export type Dimension = "provider" | "project" | "user" | "model" | "skill" | "agent" | "session" | "prompt" | "host";
export type Bucket = "hour" | "day" | "week" | "month";
export type SeriesGroup = "none" | "type" | "provider" | "project" | "user" | "model" | "skill" | "agent";
export type Metric = "tokens" | "cost";

type Params = Record<string, string | number | null>;

const FILTER_COLUMNS: (keyof Filters)[] = ["provider", "project", "user", "model", "skill", "agent"];

/** Builds a WHERE clause over the `usage` table (alias `u`). */
export function whereClause(f: Filters, alias = "u"): { sql: string; params: Params } {
  const parts: string[] = [];
  const params: Params = {};
  if (f.from != null) {
    parts.push(`${alias}.ts >= $from`);
    params.from = f.from;
  }
  if (f.to != null) {
    parts.push(`${alias}.ts < $to`);
    params.to = f.to;
  }
  for (const col of FILTER_COLUMNS) {
    const v = f[col];
    if (v == null || v === "") continue;
    if (v === "(none)") parts.push(`${alias}.${col} IS NULL`);
    else {
      parts.push(`${alias}.${col} = $${col}`);
      params[col] = v as string;
    }
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function and(where: string, cond: string): string {
  return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
}

const TOKEN_SUMS = `
  COALESCE(SUM(u.total_tokens), 0)          AS tokens,
  COALESCE(SUM(u.input_tokens), 0)          AS input,
  COALESCE(SUM(u.output_tokens), 0)         AS output,
  COALESCE(SUM(u.cache_read_tokens), 0)     AS cacheRead,
  COALESCE(SUM(u.cache_write_tokens + u.cache_write_1h_tokens), 0) AS cacheWrite,
  COALESCE(SUM(u.reasoning_tokens), 0)      AS reasoning,
  COALESCE(SUM(u.cost_usd), 0)              AS cost,
  COUNT(*)                                  AS messages`;

export interface Totals {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  messages: number;
}

export function projectLabel(path: string | null): string {
  if (!path) return "(unknown)";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

const LOCAL = "'unixepoch', 'localtime'";
function bucketExpr(bucket: Bucket, col = "u.ts"): string {
  const t = `${col} / 1000`;
  switch (bucket) {
    case "hour":
      return `strftime('%Y-%m-%d %H:00', ${t}, ${LOCAL})`;
    case "week":
      return `date(${t}, ${LOCAL}, 'weekday 0', '-6 days')`;
    case "month":
      return `strftime('%Y-%m', ${t}, ${LOCAL})`;
    default:
      return `date(${t}, ${LOCAL})`;
  }
}

function dimExpr(dim: Dimension | SeriesGroup): string {
  switch (dim) {
    case "session":
      return "u.session_id";
    case "prompt":
      return "u.prompt_id";
    case "none":
    case "type":
      return "'all'";
    default:
      return `u.${dim}`;
  }
}

export class Queries {
  constructor(
    private db: Database,
    private prices: () => PriceBook,
  ) {}

  private all<T>(sql: string, params: Params = {}): T[] {
    return this.db.query<T, Params>(sql).all(params);
  }
  private get<T>(sql: string, params: Params = {}): T | null {
    return this.db.query<T, Params>(sql).get(params);
  }

  summary(f: Filters) {
    const w = whereClause(f);
    const totals = this.get<Totals & { sessions: number; prompts: number; estimatedCost: number; firstTs: number; lastTs: number }>(
      `SELECT ${TOKEN_SUMS},
              COUNT(DISTINCT u.session_id) AS sessions,
              COUNT(DISTINCT u.prompt_id)  AS prompts,
              COALESCE(SUM(CASE WHEN u.cost_estimated = 1 THEN u.cost_usd ELSE 0 END), 0) AS estimatedCost,
              MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
       FROM usage u ${w.sql}`,
      w.params,
    )!;
    let previous: (Totals & { sessions: number; prompts: number }) | null = null;
    if (f.from != null) {
      const to = f.to ?? Date.now();
      const span = to - f.from;
      const pw = whereClause({ ...f, from: f.from - span, to: f.from });
      previous = this.get(
        `SELECT ${TOKEN_SUMS}, COUNT(DISTINCT u.session_id) AS sessions, COUNT(DISTINCT u.prompt_id) AS prompts
         FROM usage u ${pw.sql}`,
        pw.params,
      );
    }
    const days = this.get<{ days: number }>(`SELECT COUNT(DISTINCT ${bucketExpr("day")}) AS days FROM usage u ${w.sql}`, w.params)!.days;
    const cacheDenominator = totals.input + totals.cacheRead + totals.cacheWrite;
    return {
      ...totals,
      activeDays: days,
      cacheHitRate: cacheDenominator ? totals.cacheRead / cacheDenominator : 0,
      costPerPrompt: totals.prompts ? totals.cost / totals.prompts : 0,
      previous,
    };
  }

  timeseries(f: Filters, bucket: Bucket, group: SeriesGroup, metric: Metric, top = 8) {
    const w = whereClause(f);
    const b = bucketExpr(bucket);
    const value = metric === "cost" ? "SUM(u.cost_usd)" : "SUM(u.total_tokens)";

    if (group === "type") {
      const rows = this.all<{ bucket: string; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>(
        `SELECT ${b} AS bucket, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output,
                SUM(u.cache_read_tokens) AS cacheRead, SUM(u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite,
                SUM(u.cost_usd) AS cost
         FROM usage u ${w.sql} GROUP BY bucket ORDER BY bucket`,
        w.params,
      );
      const buckets = fillBuckets(rows.map((r) => r.bucket), bucket, f);
      const idx = new Map(rows.map((r) => [r.bucket, r]));
      const series = (["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => ({
        key: k,
        name: k,
        data: buckets.map((bk) => idx.get(bk)?.[k] ?? 0),
      }));
      return { buckets, series, costs: buckets.map((bk) => idx.get(bk)?.cost ?? 0) };
    }

    const d = dimExpr(group);
    const ranking = this.all<{ key: string | null }>(
      `SELECT ${d} AS key FROM usage u ${w.sql} GROUP BY key ORDER BY ${value} DESC LIMIT ${top}`,
      w.params,
    ).map((r) => r.key);
    const rows = this.all<{ bucket: string; key: string | null; v: number }>(
      `SELECT ${b} AS bucket, ${d} AS key, ${value} AS v FROM usage u ${w.sql} GROUP BY bucket, key ORDER BY bucket`,
      w.params,
    );
    const buckets = fillBuckets(rows.map((r) => r.bucket), bucket, f);
    const topSet = new Set(ranking);
    const map = new Map<string, Map<string, number>>();
    let hasOther = false;
    for (const r of rows) {
      const k = topSet.has(r.key) ? (r.key ?? "(none)") : "__other__";
      if (k === "__other__") hasOther = true;
      const m = map.get(k) ?? new Map();
      m.set(r.bucket, (m.get(r.bucket) ?? 0) + r.v);
      map.set(k, m);
    }
    const keys = [...ranking.map((k) => k ?? "(none)"), ...(hasOther ? ["__other__"] : [])];
    const series = keys.map((k) => ({
      key: k,
      name: k === "__other__" ? "other" : group === "project" ? projectLabel(k) : k,
      data: buckets.map((bk) => map.get(k)?.get(bk) ?? 0),
    }));
    return { buckets, series };
  }

  breakdown(f: Filters, dim: Dimension, limit = 50, sort: "tokens" | "cost" = "cost") {
    const w = whereClause(f);
    const d = dimExpr(dim);
    const rows = this.all<Totals & { key: string | null; sessions: number; prompts: number; firstTs: number; lastTs: number; estimated: number }>(
      `SELECT ${d} AS key, ${TOKEN_SUMS},
              COUNT(DISTINCT u.session_id) AS sessions,
              COUNT(DISTINCT u.prompt_id)  AS prompts,
              MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs,
              MAX(u.cost_estimated) AS estimated
       FROM usage u ${w.sql}
       GROUP BY key ORDER BY ${sort === "tokens" ? "tokens" : "cost"} DESC LIMIT $limit`,
      { ...w.params, limit },
    );
    const total = this.get<{ tokens: number; cost: number }>(
      `SELECT COALESCE(SUM(u.total_tokens),0) AS tokens, COALESCE(SUM(u.cost_usd),0) AS cost FROM usage u ${w.sql}`,
      w.params,
    )!;
    return {
      total,
      rows: rows.map((r) => ({
        ...r,
        key: r.key ?? "(none)",
        label: dim === "project" ? projectLabel(r.key) : r.key ?? "(none)",
        cacheHitRate: r.input + r.cacheRead + r.cacheWrite ? r.cacheRead / (r.input + r.cacheRead + r.cacheWrite) : 0,
        share: total.cost ? r.cost / total.cost : 0,
        tokenShare: total.tokens ? r.tokens / total.tokens : 0,
      })),
    };
  }

  /** Day-of-week (0 = Monday) × hour activity matrix. */
  heatmap(f: Filters, metric: Metric) {
    const w = whereClause(f);
    const value = metric === "cost" ? "SUM(u.cost_usd)" : "SUM(u.total_tokens)";
    const rows = this.all<{ dow: number; hour: number; v: number; n: number }>(
      `SELECT (CAST(strftime('%w', u.ts / 1000, ${LOCAL}) AS INTEGER) + 6) % 7 AS dow,
              CAST(strftime('%H', u.ts / 1000, ${LOCAL}) AS INTEGER) AS hour,
              ${value} AS v, COUNT(*) AS n
       FROM usage u ${w.sql} GROUP BY dow, hour`,
      w.params,
    );
    return { cells: rows.map((r) => [r.hour, r.dow, r.v, r.n] as const) };
  }

  /** Calendar heatmap (GitHub style) of daily totals. */
  calendar(f: Filters) {
    const w = whereClause(f);
    return this.all<{ day: string; tokens: number; cost: number }>(
      `SELECT ${bucketExpr("day")} AS day, SUM(u.total_tokens) AS tokens, SUM(u.cost_usd) AS cost
       FROM usage u ${w.sql} GROUP BY day ORDER BY day`,
      w.params,
    );
  }

  sessions(f: Filters, opts: { sort?: string; limit?: number; offset?: number; q?: string }) {
    const w = whereClause(f);
    const params: Params = { ...w.params, limit: opts.limit ?? 50, offset: opts.offset ?? 0 };
    let having = "";
    if (opts.q) {
      having = "HAVING s.title LIKE $q OR s.project LIKE $q OR s.id LIKE $q";
      params.q = `%${opts.q}%`;
    }
    const sortCol = { cost: "cost", tokens: "tokens", recent: "lastTs", messages: "messages", prompts: "prompts" }[opts.sort ?? "recent"] ?? "lastTs";
    const rows = this.all<Totals & Record<string, unknown> & { id: string }>(
      `SELECT u.session_id AS id, s.title, s.project, s.provider, s.user, s.host, s.git_branch AS gitBranch,
              s.agent AS sessionAgent, s.parent_session_id AS parentSessionId, s.client,
              ${TOKEN_SUMS},
              COUNT(DISTINCT u.prompt_id) AS prompts,
              GROUP_CONCAT(DISTINCT u.model) AS models,
              SUM(u.is_subagent) AS subagentMessages,
              MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
       FROM usage u LEFT JOIN sessions s ON s.id = u.session_id
       ${w.sql}
       GROUP BY u.session_id ${having}
       ORDER BY ${sortCol} DESC LIMIT $limit OFFSET $offset`,
      params,
    );
    const count = this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT u.session_id FROM usage u LEFT JOIN sessions s ON s.id = u.session_id ${w.sql}
       GROUP BY u.session_id ${having})`,
      opts.q ? { ...w.params, q: params.q! } : w.params,
    )!.n;
    return { total: count, rows: rows.map((r) => ({ ...r, projectLabel: projectLabel(r.project as string | null) })) };
  }

  sessionDetail(id: string) {
    const session = this.get<Record<string, unknown>>(`SELECT * FROM sessions WHERE id = $id`, { id });
    const totals = this.get<Totals>(`SELECT ${TOKEN_SUMS} FROM usage u WHERE u.session_id = $id`, { id });
    const prompts = this.all<Record<string, unknown>>(
      `SELECT p.id, p.ts, p.text, p.skill, p.is_command AS isCommand,
              COALESCE(SUM(u.total_tokens),0) AS tokens, COALESCE(SUM(u.cost_usd),0) AS cost, COUNT(u.id) AS messages,
              (SELECT COUNT(*) FROM tool_calls t WHERE t.prompt_id = p.id) AS toolCalls
       FROM prompts p LEFT JOIN usage u ON u.prompt_id = p.id
       WHERE p.session_id = $id GROUP BY p.id ORDER BY p.ts`,
      { id },
    );
    const timeline = this.all<Record<string, unknown>>(
      `SELECT u.ts, u.model, u.agent, u.input_tokens AS input, u.output_tokens AS output,
              u.cache_read_tokens AS cacheRead, (u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite,
              u.cost_usd AS cost, u.prompt_id AS promptId
       FROM usage u WHERE u.session_id = $id ORDER BY u.ts`,
      { id },
    );
    const models = this.all(`SELECT u.model AS key, ${TOKEN_SUMS} FROM usage u WHERE u.session_id = $id GROUP BY u.model ORDER BY cost DESC`, { id });
    const agents = this.all(`SELECT u.agent AS key, ${TOKEN_SUMS} FROM usage u WHERE u.session_id = $id GROUP BY u.agent ORDER BY cost DESC`, { id });
    const tools = this.all(
      `SELECT tool AS key, COUNT(*) AS calls FROM tool_calls WHERE session_id = $id GROUP BY tool ORDER BY calls DESC`,
      { id },
    );
    const files = this.all(
      `SELECT file_path AS key, COUNT(*) AS calls FROM tool_calls WHERE session_id = $id AND file_path IS NOT NULL
       GROUP BY file_path ORDER BY calls DESC LIMIT 25`,
      { id },
    );
    const children = this.all(
      `SELECT s.id, s.agent, s.title, COALESCE(SUM(u.total_tokens),0) AS tokens, COALESCE(SUM(u.cost_usd),0) AS cost
       FROM sessions s LEFT JOIN usage u ON u.session_id = s.id WHERE s.parent_session_id = $id GROUP BY s.id ORDER BY cost DESC`,
      { id },
    );
    return { session, totals, prompts, timeline, models, agents, tools, files, children };
  }

  prompts(f: Filters, opts: { sort?: string; limit?: number; offset?: number; q?: string }) {
    const w = whereClause(f);
    const where = and(w.sql, "u.prompt_id IS NOT NULL");
    const params: Params = { ...w.params, limit: opts.limit ?? 50, offset: opts.offset ?? 0 };
    let qcond = "";
    if (opts.q) {
      qcond = "AND p.text LIKE $q";
      params.q = `%${opts.q}%`;
    }
    const sortCol = { cost: "cost", tokens: "tokens", recent: "ts", messages: "messages" }[opts.sort ?? "cost"] ?? "cost";
    const rows = this.all<Record<string, unknown> & { id: string }>(
      `SELECT p.id, p.ts, p.text, p.skill, p.is_command AS isCommand, p.session_id AS sessionId, p.provider,
              s.project, s.title AS sessionTitle,
              agg.tokens, agg.cost, agg.messages, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.models, agg.subagentCost,
              (SELECT COUNT(*) FROM tool_calls t WHERE t.prompt_id = p.id) AS toolCalls
       FROM (SELECT u.prompt_id, SUM(u.total_tokens) AS tokens, SUM(u.cost_usd) AS cost, COUNT(*) AS messages,
                    SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output, SUM(u.cache_read_tokens) AS cacheRead,
                    SUM(u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite,
                    GROUP_CONCAT(DISTINCT u.model) AS models,
                    SUM(CASE WHEN u.is_subagent = 1 THEN u.cost_usd ELSE 0 END) AS subagentCost
             FROM usage u ${where} GROUP BY u.prompt_id) agg
       JOIN prompts p ON p.id = agg.prompt_id
       LEFT JOIN sessions s ON s.id = p.session_id
       WHERE 1 = 1 ${qcond}
       ORDER BY ${sortCol} DESC LIMIT $limit OFFSET $offset`,
      params,
    );
    const total = this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT u.prompt_id FROM usage u ${where} GROUP BY u.prompt_id) agg
       JOIN prompts p ON p.id = agg.prompt_id WHERE 1 = 1 ${qcond}`,
      opts.q ? { ...w.params, q: params.q! } : w.params,
    )!.n;
    return { total, rows: rows.map((r) => ({ ...r, projectLabel: projectLabel(r.project as string | null) })) };
  }

  promptDetail(id: string) {
    const prompt = this.get<Record<string, unknown>>(
      `SELECT p.*, s.project, s.title AS sessionTitle FROM prompts p LEFT JOIN sessions s ON s.id = p.session_id WHERE p.id = $id`,
      { id },
    );
    const totals = this.get<Totals>(`SELECT ${TOKEN_SUMS} FROM usage u WHERE u.prompt_id = $id`, { id });
    const timeline = this.all(
      `SELECT u.ts, u.model, u.agent, u.input_tokens AS input, u.output_tokens AS output, u.cache_read_tokens AS cacheRead,
              (u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite, u.cost_usd AS cost
       FROM usage u WHERE u.prompt_id = $id ORDER BY u.ts`,
      { id },
    );
    const tools = this.all(`SELECT tool AS key, COUNT(*) AS calls FROM tool_calls WHERE prompt_id = $id GROUP BY tool ORDER BY calls DESC`, { id });
    const files = this.all(
      `SELECT file_path AS key, COUNT(*) AS calls FROM tool_calls WHERE prompt_id = $id AND file_path IS NOT NULL GROUP BY file_path ORDER BY calls DESC LIMIT 25`,
      { id },
    );
    const agents = this.all(`SELECT u.agent AS key, ${TOKEN_SUMS} FROM usage u WHERE u.prompt_id = $id GROUP BY u.agent ORDER BY cost DESC`, { id });
    return { prompt, totals, timeline, tools, files, agents };
  }

  tools(f: Filters) {
    // tool_calls has no model column: drop the model filter for tool-level stats.
    const { model: _model, ...rest } = f;
    const wt = whereClause(rest, "t");
    const tools = this.all<{ key: string; calls: number; sessions: number }>(
      `SELECT t.tool AS key, COUNT(*) AS calls, COUNT(DISTINCT t.session_id) AS sessions
       FROM tool_calls t ${wt.sql} GROUP BY t.tool ORDER BY calls DESC LIMIT 40`,
      wt.params,
    );
    const files = this.all<{ key: string; calls: number; reads: number; edits: number; sessions: number; project: string | null }>(
      `SELECT t.file_path AS key, COUNT(*) AS calls,
              SUM(CASE WHEN t.tool IN ('Read','NotebookRead') THEN 1 ELSE 0 END) AS reads,
              SUM(CASE WHEN t.tool IN ('Edit','MultiEdit','Write','NotebookEdit','apply_patch') THEN 1 ELSE 0 END) AS edits,
              COUNT(DISTINCT t.session_id) AS sessions, MAX(t.project) AS project
       FROM tool_calls t ${and(wt.sql, "t.file_path IS NOT NULL")}
       GROUP BY t.file_path ORDER BY calls DESC LIMIT 50`,
      wt.params,
    );
    const topTools = tools.slice(0, 12).map((t) => t.key);
    const topProjects = this.all<{ key: string | null }>(
      `SELECT t.project AS key FROM tool_calls t ${wt.sql} GROUP BY t.project ORDER BY COUNT(*) DESC LIMIT 10`,
      wt.params,
    ).map((r) => r.key);
    const matrix = this.all<{ tool: string; project: string | null; calls: number }>(
      `SELECT t.tool, t.project, COUNT(*) AS calls FROM tool_calls t ${wt.sql} GROUP BY t.tool, t.project`,
      wt.params,
    ).filter((r) => topTools.includes(r.tool) && topProjects.includes(r.project));
    const byHour = this.all<{ tool: string; hour: number; calls: number }>(
      `SELECT t.tool, CAST(strftime('%H', t.ts / 1000, ${LOCAL}) AS INTEGER) AS hour, COUNT(*) AS calls
       FROM tool_calls t ${wt.sql} GROUP BY t.tool, hour`,
      wt.params,
    ).filter((r) => topTools.includes(r.tool));
    return {
      tools,
      files: files.map((r) => ({ ...r, projectLabel: projectLabel(r.project) })),
      matrix: {
        tools: topTools,
        projects: topProjects.map((p) => ({ key: p ?? "(none)", label: projectLabel(p) })),
        cells: matrix.map((m) => [topTools.indexOf(m.tool), topProjects.indexOf(m.project), m.calls] as const),
      },
      byHour: { tools: topTools, cells: byHour.map((r) => [r.hour, topTools.indexOf(r.tool), r.calls] as const) },
    };
  }

  cache(f: Filters, bucket: Bucket) {
    const w = whereClause(f);
    const series = this.all<{ bucket: string; input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>(
      `SELECT ${bucketExpr(bucket)} AS bucket, SUM(u.input_tokens) AS input, SUM(u.cache_read_tokens) AS cacheRead,
              SUM(u.cache_write_tokens) AS cacheWrite, SUM(u.cache_write_1h_tokens) AS cacheWrite1h
       FROM usage u ${w.sql} GROUP BY bucket ORDER BY bucket`,
      w.params,
    );
    const perModel = this.all<{ model: string | null; input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number; cost: number }>(
      `SELECT u.model, SUM(u.input_tokens) AS input, SUM(u.cache_read_tokens) AS cacheRead, SUM(u.cache_write_tokens) AS cacheWrite,
              SUM(u.cache_write_1h_tokens) AS cacheWrite1h, SUM(u.output_tokens) AS output, SUM(u.cost_usd) AS cost
       FROM usage u ${and(w.sql, "u.provider != 'cursor'")} GROUP BY u.model`,
      w.params,
    );
    const book = this.prices();
    let savings = 0;
    let writeCost = 0;
    let readCost = 0;
    const models = perModel.map((m) => {
      const { price } = book.lookup(m.model);
      const readRate = price.cacheRead ?? price.input * 0.1;
      const w5 = price.cacheWrite5m ?? price.input * 1.25;
      const w1 = price.cacheWrite1h ?? price.input * 2;
      const saved = (m.cacheRead * (price.input - readRate)) / 1e6;
      const wc = (m.cacheWrite * w5 + m.cacheWrite1h * w1) / 1e6;
      const rc = (m.cacheRead * readRate) / 1e6;
      savings += saved;
      writeCost += wc;
      readCost += rc;
      const denom = m.input + m.cacheRead + m.cacheWrite + m.cacheWrite1h;
      return { key: normalizeModel(m.model), hitRate: denom ? m.cacheRead / denom : 0, savings: saved, writeCost: wc, readCost: rc, cost: m.cost, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite + m.cacheWrite1h, input: m.input };
    });
    const totals = series.reduce(
      (a, r) => ({ input: a.input + r.input, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite, cacheWrite1h: a.cacheWrite1h + r.cacheWrite1h }),
      { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
    );
    const denom = totals.input + totals.cacheRead + totals.cacheWrite + totals.cacheWrite1h;
    const buckets = fillBuckets(series.map((s) => s.bucket), bucket, f);
    const idx = new Map(series.map((s) => [s.bucket, s]));
    return {
      totals: { ...totals, hitRate: denom ? totals.cacheRead / denom : 0, savings, writeCost, readCost },
      buckets,
      series: buckets.map((b) => {
        const s = idx.get(b);
        const d = s ? s.input + s.cacheRead + s.cacheWrite + s.cacheWrite1h : 0;
        return { bucket: b, input: s?.input ?? 0, cacheRead: s?.cacheRead ?? 0, cacheWrite: (s?.cacheWrite ?? 0) + (s?.cacheWrite1h ?? 0), hitRate: d ? s!.cacheRead / d : null };
      }),
      models: models.sort((a, b) => b.cost - a.cost),
    };
  }

  filters(f: Filters = {}) {
    const time = whereClause({ from: f.from, to: f.to });
    const values = (col: string) =>
      this.all<{ value: string | null; n: number; cost: number }>(
        `SELECT u.${col} AS value, COUNT(*) AS n, SUM(u.cost_usd) AS cost FROM usage u ${time.sql} GROUP BY u.${col} ORDER BY cost DESC`,
        time.params,
      ).map((r) => ({ value: r.value ?? "(none)", label: col === "project" ? projectLabel(r.value) : r.value ?? "(none)", n: r.n }));
    const range = this.get<{ minTs: number | null; maxTs: number | null; rows: number }>(
      "SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS rows FROM usage",
    )!;
    return {
      provider: values("provider"),
      project: values("project"),
      user: values("user"),
      model: values("model"),
      skill: values("skill").filter((v) => v.value !== "(none)"),
      agent: values("agent"),
      range,
    };
  }
}

/** Ensures every bucket in the range appears (zero-filled) so charts don't skip idle days. */
export function fillBuckets(present: string[], bucket: Bucket, f: Filters): string[] {
  const uniq = [...new Set(present)].sort();
  if (bucket !== "day" || uniq.length === 0) return uniq;
  const start = f.from != null ? localDay(f.from) : uniq[0]!;
  const endTs = Math.min((f.to ?? Date.now() + 1) - 1, Date.now()); // `to` is exclusive
  const end = uniq[uniq.length - 1]! > localDay(endTs) ? uniq[uniq.length - 1]! : localDay(endTs);
  const out: string[] = [];
  const d = new Date(start + "T00:00:00");
  for (let i = 0; i < 3700; i++) {
    const s = localDay(d.getTime());
    if (s > end) break;
    out.push(s);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function localDay(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
