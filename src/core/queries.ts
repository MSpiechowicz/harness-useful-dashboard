import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { memo } from "./cache.ts";
import { hasTable } from "./db.ts";
import { storedApiClass } from "./apiErrors.ts";
import { storedReason } from "./failures.ts";
import { normalizeModel, type PriceBook } from "./pricing.ts";
import { type PromptMetric, promptStats } from "./promptStats.ts";
import { KINDS, labelsForSessions } from "./labels.ts";
import { allTags, tagsForSessions } from "./tags.ts";

export interface Filters {
  from?: number;
  to?: number;
  provider?: string;
  project?: string;
  user?: string;
  model?: string;
  skill?: string;
  agent?: string;
  /** A session tag: its sessions, their subagents' sessions, and the projects with that tag as their default. */
  tag?: string;
  /** A kind of work (labels.ts): the sessions labelled with it, and their subagents' sessions. */
  kind?: string;
}

export type Dimension = "provider" | "project" | "user" | "model" | "skill" | "agent" | "session" | "prompt" | "host";
export type Bucket = "hour" | "day" | "week" | "month";
export type SeriesGroup = "none" | "type" | "provider" | "project" | "user" | "model" | "skill" | "agent";
export type Metric = "tokens" | "cost";

type Params = Record<string, string | number | null>;

const FILTER_COLUMNS: (keyof Filters)[] = ["provider", "project", "user", "model", "skill", "agent"];

/**
 * Rows of the sessions a tag reaches, resolved when the query runs, so tagging or untagging a session needs no rewrite
 * of its rows: the tagged session itself, the sessions of its subagents (their parent carries the tag), and every row
 * of a project that has the tag as its default. `alias` is the alias of a table with session_id and project.
 */
function tagCondition(alias: string): string {
  return `(${alias}.session_id IN (SELECT session_id FROM session_tags WHERE tag = $tag
            UNION SELECT s.id FROM sessions s JOIN session_tags g ON g.session_id = s.parent_session_id WHERE g.tag = $tag)
          OR ${alias}.project IN (SELECT project FROM project_tags WHERE tag = $tag))`;
}

/** Rows of the sessions a kind of work reaches, resolved like a tag: the labelled session and its subagents' sessions. */
function kindCondition(alias: string): string {
  return `${alias}.session_id IN (SELECT session_id FROM session_labels WHERE kind = $kind
            UNION SELECT s.id FROM sessions s JOIN session_labels l ON l.session_id = s.parent_session_id WHERE l.kind = $kind)`;
}

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
  if (f.tag) {
    parts.push(tagCondition(alias));
    params.tag = f.tag;
  }
  if (f.kind) {
    parts.push(kindCondition(alias));
    params.kind = f.kind;
  }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function and(where: string, cond: string): string {
  return where ? `${where} AND ${cond}` : `WHERE ${cond}`;
}

/** Tools that read or change a file, across harnesses (Claude Code, Codex, omp). */
export const READ_TOOLS = "'Read','NotebookRead','read'";
export const EDIT_TOOLS = "'Edit','MultiEdit','Write','NotebookEdit','apply_patch','edit','write'";

/** Per-file tool call counts, split into reads and edits by the tool that touched the file. */
const FILE_COUNTS = `COUNT(*) AS calls,
  SUM(CASE WHEN t.tool IN (${READ_TOOLS}) THEN 1 ELSE 0 END) AS reads,
  SUM(CASE WHEN t.tool IN (${EDIT_TOOLS}) THEN 1 ELSE 0 END) AS edits`;

export const TOKEN_SUMS = `
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

/**
 * A file path relative to its project root when it lies inside it. Files elsewhere keep their absolute
 * path, with the home directory shortened to "~".
 */
export function relativeTo(file: string, project: string | null, home = homedir()): string {
  const inside = (root: string) => file.length > root.length + 1 && file.startsWith(root) && /[\\/]/.test(file[root.length]!);
  const root = project?.replace(/[\\/]+$/, "");
  if (root && inside(root)) return file.slice(root.length + 1);
  return home && inside(home) ? `~${file.slice(home.length)}` : file;
}

/**
 * A session's title as SQL: the one its harness gave it, else the AI's (labels.ts, only when the user turned labels on),
 * else its first prompt on one line, else, for a subagent, its name. Many sessions never get a title (omp leaves it
 * empty until it names the session, Codex often has none), and the first prompt says what they were about. Subagents have no prompts of their own (their brief comes from the
 * parent), but harnesses name them after their task ("TriggerDurability"). `alias` is the sessions table's alias.
 */
export function sessionTitle(alias: string): string {
  // A pasted image is logged as "[Image #1, 1481x890]" ahead of the words: up to two of them are left out of the title.
  const noImage = (x: string) => `ltrim(CASE WHEN ${x} LIKE '[Image #%]%' THEN substr(${x}, instr(${x}, ']') + 1) ELSE ${x} END)`;
  const text = noImage(noImage("trim(fp.text)"));
  return `COALESCE(NULLIF(${alias}.title, ''), (SELECT NULLIF(l.title, '') FROM session_labels l WHERE l.session_id = ${alias}.id),
    (SELECT NULLIF(trim(replace(replace(substr(${text}, 1, 160), char(10), ' '), char(13), ' ')), '')
    FROM prompts fp WHERE fp.session_id = ${alias}.id AND fp.text IS NOT NULL AND trim(fp.text) <> '' ORDER BY fp.ts LIMIT 1),
    NULLIF(${alias}.agent, ''))`;
}

export function projectLabel(path: string | null): string {
  if (!path) return "(none)";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A commit found in an agent's transcript. `url` only when its branch has a pull request on github.com. */
export interface GitCommit {
  id: string;
  ts: number;
  branch: string | null;
  sha: string | null;
  subject: string | null;
  project: string | null;
  sessionId: string;
  provider: string;
  url: string | null;
}

/** A pull request found in an agent's transcript. `repo` is "<host>/<owner>/<repo>". */
export interface GitPr {
  id: string;
  ts: number;
  repo: string | null;
  number: number | null;
  url: string | null;
  branch: string | null;
  sessionId: string;
  provider: string;
}

/** A session's context compaction. `estimated`: its cost is worked out from its tokens, not reported. */
export interface Compaction {
  id: string;
  ts: number;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  costUsd: number;
  estimated: boolean;
  model: string | null;
  agent: string;
}

/** How many commits and pull requests a list shows at most. Counts are never capped. */
export const GIT_LIST_LIMIT = 200;

const GITHUB_REPO = /^github\.com\/[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;
/** A pull request's page: https, a host, an owner, a repository and a number. No sign-in, query or fragment. */
const PR_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/([\w.-]+)\/([\w.-]+)\/pull\/\d+$/;

/**
 * A stored pull request link as it may be shown or followed, else null: the store holds what a transcript said. An
 * owner or repository of "." or ".." would lead elsewhere once resolved. Other names may start with a dot (".github").
 */
export function prUrl(url: string | null | undefined): string | null {
  const m = url != null ? PR_URL.exec(url) : null;
  if (!m) return null;

  const dots = (segment: string) => segment === "." || segment === "..";
  return dots(m[1]!) || dots(m[2]!) ? null : url!;
}

/** How many commits and pull requests match `cond` (over `git_events g`): never capped like the lists. */
export function gitCounts(db: Database, cond: string, params: Params): { commitCount: number; prCount: number } {
  if (!hasTable(db, "git_events")) return { commitCount: 0, prCount: 0 };

  return db
    .query<{ commitCount: number; prCount: number }, Params>(
      `SELECT COALESCE(SUM(g.kind = 'commit'), 0) AS commitCount, COALESCE(SUM(g.kind = 'pr'), 0) AS prCount FROM git_events g WHERE ${cond}`,
    )
    .get(params)!;
}

/**
 * The commits and pull requests that match `cond` (over `git_events g`), newest first. A commit links to GitHub only
 * when its branch already has a pull request there: the repository isn't known otherwise. A pull request links only to
 * a plain https page of it (prUrl).
 */
export function gitEvents(db: Database, cond: string, params: Params, limit = GIT_LIST_LIMIT): { commits: GitCommit[]; prs: GitPr[] } {
  if (!hasTable(db, "git_events")) return { commits: [], prs: [] };

  const commits = db
    .query<Omit<GitCommit, "url"> & { prRepo: string | null }, Params>(
      `SELECT g.id, g.ts, g.branch, g.sha, g.subject, g.project, g.session_id AS sessionId, g.provider,
              (SELECT p.repo FROM git_events p
               WHERE p.kind = 'pr' AND p.branch = g.branch AND p.project IS g.project AND p.repo LIKE 'github.com/%'
               ORDER BY p.ts DESC LIMIT 1) AS prRepo
       FROM git_events g WHERE g.kind = 'commit' AND ${cond} ORDER BY g.ts DESC LIMIT ${limit}`,
    )
    .all(params)
    .map(({ prRepo, ...c }) => {
      const linked = prRepo != null && GITHUB_REPO.test(prRepo) && c.sha != null && SHA.test(c.sha);
      return { ...c, url: linked ? `https://${prRepo}/commit/${c.sha}` : null };
    });

  const prs = db
    .query<GitPr, Params>(
      `SELECT g.id, g.ts, g.repo, g.number, g.url, g.branch, g.session_id AS sessionId, g.provider
       FROM git_events g WHERE g.kind = 'pr' AND ${cond} ORDER BY g.ts DESC LIMIT ${limit}`,
    )
    .all(params)
    .map((p) => ({ ...p, url: prUrl(p.url) }));

  return { commits, prs };
}

/** A session's compactions, oldest first. */
export function sessionCompactions(db: Database, sessionId: string): Compaction[] {
  if (!hasTable(db, "compactions")) return [];

  return db
    .query<Omit<Compaction, "estimated"> & { estimated: number }, Params>(
      `SELECT id, ts, trigger, pre_tokens AS preTokens, post_tokens AS postTokens, duration_ms AS durationMs, cost_usd AS costUsd,
              estimated, model, agent
       FROM compactions WHERE session_id = $id ORDER BY ts`,
    )
    .all({ id: sessionId })
    .map((c) => ({ ...c, estimated: c.estimated !== 0 }));
}

const HOUR_MS = 3_600_000;
/** Where the precomputed offsets start. Older times, and times past their end, take SQLite's 'localtime'. */
const ZONE_FROM = Date.UTC(2015, 0, 1);

/** The local time zone's offset (ms) from `at` on, at every change between `from` and `to`, oldest first. */
export function zoneChanges(from: number, to: number): { at: number; offset: number }[] {
  const offset = (t: number) => -new Date(t).getTimezoneOffset() * 60_000;
  const out = [{ at: from, offset: offset(from) }];
  // Offsets change at most a few times a year and never twice within six hours. Each change is then found to the
  // minute, which is where zones change.
  const step = 6 * HOUR_MS;
  for (let t = from; t < to; t += step) {
    const current = out[out.length - 1]!.offset;
    let hi = Math.min(t + step, to);
    if (offset(hi) === current) continue;
    let lo = t;
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
      if (offset(mid) === current) lo = mid;
      else hi = mid;
    }
    out.push({ at: hi, offset: offset(hi) });
  }
  return out;
}

let zone: { until: number; changes: { at: number; offset: number }[] } | null = null;

/**
 * SQL for the local time of an epoch-ms column, as epoch ms. SQLite's 'localtime' asks the C library per row, which on
 * Linux with TZ unset re-reads /etc/localtime every call (about 10x slower on a year of history). The offsets come from
 * the JS clock instead, as a CASE over the zone's changes, newest first since most rows are recent. Times outside the
 * precomputed years fall back to 'localtime', so every row gets the same answer as before.
 */
export function localMs(col: string): string {
  const now = Date.now();
  if (!zone || now > zone.until - 30 * 86_400_000) {
    const until = now + 400 * 86_400_000;
    zone = { until, changes: zoneChanges(ZONE_FROM, until) };
  }
  const exact = `(strftime('%s', ${col} / 1000, 'unixepoch', 'localtime') - ${col} / 1000) * 1000`;
  const parts = [`WHEN ${col} >= ${zone.until} OR ${col} < ${ZONE_FROM} THEN ${exact}`];
  for (let i = zone.changes.length - 1; i > 0; i--) parts.push(`WHEN ${col} >= ${zone.changes[i]!.at} THEN ${zone.changes[i]!.offset}`);
  return `(${col} + CASE ${parts.join(" ")} ELSE ${zone.changes[0]!.offset} END)`;
}

/** SQLite time-value arguments for an epoch-ms column read as local time. */
export function localTime(col: string): string {
  return `${localMs(col)} / 1000, 'unixepoch'`;
}

export function bucketExpr(bucket: Bucket, col = "u.ts"): string {
  const t = localTime(col);
  switch (bucket) {
    case "hour":
      return `strftime('%Y-%m-%d %H:00', ${t})`;
    case "week":
      return `date(${t}, 'weekday 0', '-6 days')`;
    case "month":
      return `strftime('%Y-%m', ${t})`;
    default:
      return `date(${t})`;
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

export type LiveStatus = "working" | "idle" | "error" | "closed";

/**
 * What a session is doing, from its main agent's last response: calls still coming in, or a tool running, is
 * working; an error that ended it is shown as such; otherwise it is idle, waiting for your next prompt.
 */
export function liveStatus(lastTs: number, lastStop: string | null, now: number): LiveStatus {
  const quiet = now - lastTs;
  // Far in the future: another machine on a shared database with its clock ahead. Its times can't be compared with
  // ours, so it isn't shown as working forever. Within 10 minutes ahead it still is, until it goes quiet.
  if (quiet < -10 * 60_000) return "idle";
  if (quiet < 90_000) return "working";
  if (quiet <= 10 * 60_000 && lastStop === "error") return "error";
  if (quiet <= 10 * 60_000 && (lastStop === "tool_use" || lastStop === "toolUse")) return "working";
  return "idle";
}

export interface SessionStatusInput {
  provider: string;
  /** The machine the session ran on, and the one asking. */
  host: string | null;
  thisHost: string | null;
  /** The harness's own session id: Claude Code's registry names sessions by it. */
  nativeId: string | null;
  lastTs: number;
  now: number;
  /** The Claude Code sessions running on this machine (claudeRegistry.ts), or null when there is no registry to read. */
  registry: Set<string> | null;
}

/** Quiet this long, a session that isn't judged by the registry is closed. */
const CLOSED_AFTER_MS = 30 * 60_000;
/** Activity this recent always keeps a session open: the registry may lag a session that just started. */
const RECENT_MS = 90_000;

/**
 * Whether a session has ended, on top of what it was last doing (`base`, from liveStatus). A Claude Code session of
 * this machine is closed once its process is gone from Claude Code's registry. Any other session, or every one when
 * there is no registry, is closed after 30 minutes without activity.
 */
export function sessionStatus(base: LiveStatus, s: SessionStatusInput): LiveStatus {
  const quiet = s.now - s.lastTs;
  if (quiet < RECENT_MS) return base;

  const registry = s.provider === "claude" && s.thisHost != null && s.host === s.thisHost ? s.registry : null;
  if (registry) return s.nativeId != null && registry.has(s.nativeId) ? base : "closed";

  return quiet > CLOSED_AFTER_MS ? "closed" : base;
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

  /** `top` matches the five hues non-provider dimensions get; the rest folds into "Other". */
  timeseries(f: Filters, bucket: Bucket, group: SeriesGroup, metric: Metric, top = 5) {
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
      // Bottom-up stacking order: the bulk (cache reads) forms the base, output sits on top.
      const series = (["cacheRead", "cacheWrite", "input", "output"] as const).map((k) => ({
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

  /** Spend by provider, model and project together: the flows of the Overview's Sankey. */
  flow(f: Filters, limit = 5000) {
    const w = whereClause(f);
    return this.all<{ provider: string; model: string; project: string; tokens: number; cost: number }>(
      `SELECT u.provider AS provider, COALESCE(u.model, '(none)') AS model, COALESCE(u.project, '(none)') AS project,
              COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost
       FROM usage u ${w.sql}
       GROUP BY provider, model, project ORDER BY cost DESC, tokens DESC LIMIT $limit`,
      { ...w.params, limit },
    );
  }

  /**
   * A dimension split by a second one (projects by model, models by project…), for the matrix on the breakdown pages:
   * the biggest `rows` values of the one and `cols` of the other keep their own pairs, everything else is summed into
   * "__other__" on its side, so the totals stay exact however much there is. "(none)" can be left out before ranking.
   */
  pairs(f: Filters, dim: Dimension, by: Dimension, metric: Metric = "cost", opts: { rows?: number; cols?: number; skipNone?: boolean } = {}) {
    const { rows = 8, cols = 8, skipNone = false } = opts;
    const col = metric === "tokens" ? "total_tokens" : "cost_usd";
    const w = whereClause(f);
    const all = this.all<{ key: string | null; sub: string | null; value: number }>(
      `SELECT ${dimExpr(dim)} AS key, ${dimExpr(by)} AS sub, COALESCE(SUM(u.${col}), 0) AS value
       FROM usage u ${w.sql} GROUP BY key, sub HAVING value > 0`,
      w.params,
    )
      .map((r) => ({ key: r.key ?? "(none)", sub: r.sub ?? "(none)", value: r.value }))
      .filter((r) => !skipNone || r.key !== "(none)");
    const biggest = (side: "key" | "sub", n: number) => {
      const totals = new Map<string, number>();
      for (const r of all) totals.set(r[side], (totals.get(r[side]) ?? 0) + r.value);
      return new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k));
    };
    const keepRows = biggest("key", rows);
    const keepCols = biggest("sub", cols);
    const folded = new Map<string, { key: string; sub: string; value: number }>();
    for (const r of all) {
      const key = keepRows.has(r.key) ? r.key : "__other__";
      const sub = keepCols.has(r.sub) ? r.sub : "__other__";
      const at = `${key}\u0000${sub}`;
      const cell = folded.get(at) ?? { key, sub, value: 0 };
      cell.value += r.value;
      folded.set(at, cell);
    }
    const label = (d: Dimension, k: string) => (k === "__other__" ? "other" : d === "project" && k !== "(none)" ? projectLabel(k) : k);
    return [...folded.values()]
      .sort((a, b) => b.value - a.value)
      .map((r) => ({ key: r.key, label: label(dim, r.key), sub: r.sub, subLabel: label(by, r.sub), value: r.value }));
  }

  /**
   * Usage by what it was billed through: the plan or account the harness reports per call (omp: "openai-codex",
   * "github-copilot", …), else the harness's own account. Cost stays API-equivalent; Copilot counts premium
   * requests instead, so those are summed alongside.
   */
  billing(f: Filters) {
    const w = whereClause(f);
    return this.all<{ key: string; reported: number; calls: number; tokens: number; cost: number; premiumRequests: number; estimated: number }>(
      `SELECT COALESCE(u.billing, u.provider) AS key, MAX(u.billing IS NOT NULL) AS reported, COUNT(*) AS calls,
              COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost,
              COALESCE(SUM(u.premium_requests), 0) AS premiumRequests, MAX(u.cost_estimated) AS estimated
       FROM usage u ${w.sql}
       GROUP BY key ORDER BY cost DESC`,
      w.params,
    ).map((r) => ({ ...r, reported: !!r.reported, estimated: !!r.estimated }));
  }

  /** Day-of-week (0 = Monday) × hour activity matrix. */
  heatmap(f: Filters, metric: Metric) {
    const w = whereClause(f);
    const value = metric === "cost" ? "SUM(u.cost_usd)" : "SUM(u.total_tokens)";
    const t = localTime("u.ts");
    const rows = this.all<{ dow: number; hour: number; v: number; n: number }>(
      `SELECT (CAST(strftime('%w', ${t}) AS INTEGER) + 6) % 7 AS dow,
              CAST(strftime('%H', ${t}) AS INTEGER) AS hour,
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

  /** Totals per day, week (from Monday) or month in local time, oldest first. Idle days in the range come as zeros. */
  periods(f: Filters, bucket: Exclude<Bucket, "hour">) {
    const w = whereClause(f);
    type Row = Totals & { period: string; sessions: number; prompts: number; firstTs: number | null; lastTs: number | null };
    const rows = this.all<Row>(
      `SELECT ${bucketExpr(bucket)} AS period, ${TOKEN_SUMS},
              COUNT(DISTINCT u.session_id) AS sessions, COUNT(DISTINCT u.prompt_id) AS prompts,
              MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
       FROM usage u ${w.sql} GROUP BY period ORDER BY period`,
      w.params,
    );
    const idx = new Map(rows.map((r) => [r.period, r]));
    const zero = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, messages: 0, sessions: 0, prompts: 0, firstTs: null, lastTs: null };
    return fillBuckets(rows.map((r) => r.period), bucket, f).map((p): Row => idx.get(p) ?? { period: p, ...zero });
  }

  /**
   * A Live session's subagent runs with activity since `from`, newest first: the first LIVE_RUNS of them, and how many
   * there were. A run is a child session (omp, pi, Codex, OpenCode) or, in Claude Code, the responses of one subagent in
   * the parent's own log, keyed by the call that started it. A run's cost and tokens are all of its own, like the
   * session's. Its status follows its own last response, as a session's follows its main agent's.
   */
  private liveRuns(id: string, project: string | null, from: number, now: number) {
    // The run a row belongs to, and the rows of this session's subagents (not its main agent), per table alias.
    const key = (a: string, spawn: string) =>
      `CASE WHEN ${a}.session_id = $id THEN COALESCE(${spawn}, 'agent:' || ${a}.agent) ELSE ${a}.session_id END`;
    const mine = (a: string) =>
      `((${a}.session_id = $id AND ${a}.agent <> 'main') OR ${a}.session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id))`;
    const p = { id, from };
    const all = this.all<{
      key: string; sessionId: string | null; agent: string | null; brief: string | null;
      tokens: number; cost: number; messages: number; firstTs: number; lastTs: number;
    }>(
      `SELECT r.key, r.sessionId, r.agent,
              CASE WHEN r.sessionId IS NULL THEN (SELECT t.brief FROM tool_calls t WHERE t.id = r.spawnRef) ELSE r.brief END AS brief,
              r.tokens, r.cost, r.messages, r.firstTs, r.lastTs
       FROM (SELECT ${key("u", "u.spawn_ref")} AS key, CASE WHEN u.session_id = $id THEN NULL ELSE u.session_id END AS sessionId,
                    MAX(u.spawn_ref) AS spawnRef, COALESCE(NULLIF(MAX(s.agent), ''), MAX(u.agent)) AS agent,
                    COALESCE(NULLIF(MAX(s.brief), ''), NULLIF(MAX(s.title), '')) AS brief,
                    SUM(u.total_tokens) AS tokens, SUM(u.cost_usd) AS cost, COUNT(*) AS messages, MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
             FROM usage u JOIN sessions s ON s.id = u.session_id
             WHERE ${mine("u")} GROUP BY key HAVING lastTs >= $from) r
       ORDER BY r.lastTs DESC`,
      p,
    );
    const shown = all.slice(0, Queries.LIVE_RUNS);
    if (!shown.length) return { runs: [], runCount: 0 };
    // Each run's last response (how it ended, the model it went to, the effort of the last that logged one), last tool
    // call, failed calls and skills in the window: one query each for all of them.
    const lasts = new Map(
      this.all<{ key: string; stop: string | null; model: string | null; effort: string | null }>(
        `SELECT key, stop, model, effort FROM (
           SELECT ${key("u", "u.spawn_ref")} AS key, m.stop_reason AS stop, u.model,
                  FIRST_VALUE(m.effort) OVER (PARTITION BY ${key("u", "u.spawn_ref")} ORDER BY m.effort IS NULL, u.ts DESC) AS effort,
                  ROW_NUMBER() OVER (PARTITION BY ${key("u", "u.spawn_ref")} ORDER BY u.ts DESC) AS n
           FROM usage u LEFT JOIN response_meta m ON m.usage_id = u.id WHERE ${mine("u")} AND u.ts >= $from
         ) WHERE n = 1`,
        p,
      ).map((r) => [r.key, r]),
    );
    const tools = new Map(
      this.all<{ key: string; tool: string; file: string | null }>(
        `SELECT key, tool, file FROM (
           SELECT ${key("t", "t.spawn_ref")} AS key, t.tool, t.file_path AS file, ROW_NUMBER() OVER (PARTITION BY ${key("t", "t.spawn_ref")} ORDER BY t.ts DESC) AS n
           FROM tool_calls t WHERE ${mine("t")} AND t.ts >= $from
         ) WHERE n = 1`,
        p,
      ).map((r) => [r.key, r]),
    );
    const errors = new Map(
      this.all<{ key: string; n: number }>(
        `SELECT ${key("o", "t.spawn_ref")} AS key, COUNT(*) AS n
         FROM outcomes o LEFT JOIN tool_calls t ON t.id = o.id
         WHERE ${mine("o")} AND o.ts >= $from AND o.kind = 'tool_error' GROUP BY key`,
        p,
      ).map((r) => [r.key, r.n]),
    );
    // A run's skills: the one its agent is built from, any it used itself, else the one its session was in when it
    // started the run (resolveSpawnRefs).
    const skills = new Map<string, string[]>();
    for (const r of this.all<{ key: string; skill: string }>(
      `SELECT ${key("u", "u.spawn_ref")} AS key, u.skill FROM usage u
       WHERE ${mine("u")} AND u.ts >= $from AND u.skill IS NOT NULL AND u.skill <> ''
       GROUP BY key, u.skill ORDER BY MAX(u.ts) DESC`,
      p,
    )) skills.set(r.key, [...(skills.get(r.key) ?? []), r.skill]);
    return {
      runs: shown.map((r) => {
        const tool = tools.get(r.key);
        return {
          ...r,
          model: lasts.get(r.key)?.model ?? null,
          effort: lasts.get(r.key)?.effort ?? null,
          skills: skills.get(r.key) ?? [],
          status: liveStatus(r.lastTs, lasts.get(r.key)?.stop ?? null, now),
          lastTool: tool?.tool ?? null,
          lastFile: tool?.file ? relativeTo(tool.file, project) : null,
          errors: errors.get(r.key) ?? 0,
        };
      }),
      runCount: all.length,
    };
  }
  /** How many subagent runs Live lists under a session. The rest are counted. */
  private static readonly LIVE_RUNS = 8;

  /**
   * The last `minutes` minute by minute, for the Live view: tokens per minute by provider, and the sessions with
   * activity in that time. A subagent's usage counts toward the session that started it, as one line.
   */
  live(f: Filters, minutes: number, now = Date.now(), opts?: { host: string; claudeLive: Set<string> | null }) {
    const MINUTE = 60_000;
    const first = Math.floor(now / MINUTE) - minutes + 1;
    const w = whereClause({ ...f, from: first * MINUTE, to: undefined });
    const cells = this.all<{ minute: number; key: string; tokens: number; cost: number }>(
      `SELECT CAST(u.ts / ${MINUTE} AS INTEGER) AS minute, u.provider AS key,
              COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost
       FROM usage u ${w.sql} GROUP BY minute, key`,
      w.params,
    );
    const keys = [...new Set(cells.map((c) => c.key))].sort();
    const series = keys.map((key) => ({ key, data: new Array<number>(minutes).fill(0) }));
    const costSeries = keys.map((key) => ({ key, data: new Array<number>(minutes).fill(0) }));
    for (const c of cells) {
      const i = c.minute - first;
      if (i < 0 || i >= minutes) continue;
      series[keys.indexOf(c.key)]!.data[i]! += c.tokens;
      costSeries[keys.indexOf(c.key)]!.data[i]! += c.cost;
    }
    const sessions = this.all<{
      id: string; title: string | null; project: string | null; provider: string; gitBranch: string | null;
      tokens: number; cost: number; messages: number; subagents: number; model: string | null; firstTs: number; lastTs: number;
      ownTokens: number; ownCost: number; host: string | null; nativeId: string | null;
    }>(
      `WITH active AS (
         SELECT DISTINCT COALESCE(s.parent_session_id, u.session_id) AS id
         FROM usage u LEFT JOIN sessions s ON s.id = u.session_id ${w.sql}
       )
       SELECT a.id, ${sessionTitle("root")} AS title, root.project, root.provider, root.git_branch AS gitBranch,
              root.host, root.native_id AS nativeId,
              COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost_usd), 0) AS cost, COUNT(u.id) AS messages,
              COUNT(DISTINCT CASE WHEN u.session_id <> a.id THEN u.session_id END) AS subagents,
              COALESCE(SUM(CASE WHEN u.session_id = a.id AND u.agent = 'main' THEN u.total_tokens END), 0) AS ownTokens,
              COALESCE(SUM(CASE WHEN u.session_id = a.id AND u.agent = 'main' THEN u.cost_usd END), 0) AS ownCost,
              (SELECT u2.model FROM usage u2 WHERE u2.session_id = a.id ORDER BY u2.agent = 'main' DESC, u2.ts DESC LIMIT 1) AS model,
              MIN(u.ts) AS firstTs, MAX(u.ts) AS lastTs
       FROM active a
       JOIN sessions root ON root.id = a.id
       JOIN sessions s ON s.id = a.id OR s.parent_session_id = a.id
       JOIN usage u ON u.session_id = s.id
       GROUP BY a.id ORDER BY lastTs DESC LIMIT 20`,
      w.params,
    );
    const from = first * MINUTE;
    // Each session with what its main agent last did, its last tool and file, the subagents working right now, and the
    // tool errors and its main agent's skills in the window. A session's subagents are its child sessions (omp, Codex) or other agents in it (Claude).
    const tree = "(u.session_id = $id OR u.session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id))";
    const tags = tagsForSessions(this.db, sessions.map((r) => r.id));
    const detailed = sessions.map(({ host, nativeId, ...r }) => {
      const p = { id: r.id, from, recent: now - 3 * MINUTE };
      const lastStop = this.get<{ stop: string | null }>(
        `SELECT m.stop_reason AS stop FROM usage u LEFT JOIN response_meta m ON m.usage_id = u.id
         WHERE u.session_id = $id AND u.agent = 'main' ORDER BY u.ts DESC LIMIT 1`,
        { id: r.id },
      )?.stop ?? null;
      // The effort its main agent last ran at, from the last response that logged one.
      const effort = this.get<{ effort: string }>(
        `SELECT m.effort FROM usage u JOIN response_meta m ON m.usage_id = u.id
         WHERE u.session_id = $id AND u.agent = 'main' AND m.effort IS NOT NULL ORDER BY u.ts DESC LIMIT 1`,
        { id: r.id },
      )?.effort ?? null;
      const tool = this.get<{ tool: string; file: string | null }>(
        `SELECT t.tool, t.file_path AS file FROM tool_calls t
         WHERE t.session_id = $id OR t.session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id) ORDER BY t.ts DESC LIMIT 1`,
        { id: r.id },
      );
      const active = this.get<{ n: number }>(
        `SELECT COUNT(DISTINCT CASE WHEN u.session_id <> $id THEN u.session_id ELSE COALESCE(u.spawn_ref, u.agent) END) AS n
         FROM usage u WHERE ${tree} AND u.ts >= $recent AND (u.session_id <> $id OR u.agent <> 'main')`,
        p,
      )!.n;
      const { errors, apiErrors } = this.get<{ errors: number; apiErrors: number }>(
        `SELECT COALESCE(SUM(o.kind = 'tool_error'), 0) AS errors, COALESCE(SUM(o.kind = 'api_error'), 0) AS apiErrors FROM outcomes o
         WHERE (o.session_id = $id OR o.session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id)) AND o.ts >= $from
           AND o.kind IN ('tool_error', 'api_error')`,
        p,
      )!;
      const skills = this.all<{ skill: string }>(
        `SELECT u.skill FROM usage u WHERE u.session_id = $id AND u.agent = 'main' AND u.ts >= $from AND u.skill IS NOT NULL AND u.skill <> ''
         GROUP BY u.skill ORDER BY MAX(u.ts) DESC`,
        { id: r.id, from },
      ).map((x) => x.skill);
      return {
        ...r,
        projectLabel: projectLabel(r.project),
        skills,
        tags: tags.get(r.id) ?? [],
        effort,
        status: sessionStatus(liveStatus(r.lastTs, lastStop, now), {
          provider: r.provider, host, thisHost: opts?.host ?? null, nativeId, lastTs: r.lastTs, now, registry: opts?.claudeLive ?? null,
        }),
        lastTool: tool?.tool ?? null,
        lastFile: tool?.file ? relativeTo(tool.file, r.project) : null,
        activeSubagents: active,
        errors,
        apiErrors,
        ...this.liveRuns(r.id, r.project, from, now),
      };
    });

    // The latest happenings across sessions: prompts sent, tool calls that failed or were declined, prompts stopped, model
    // requests that failed. A failed call says why (failures.ts) and what its error was, and what it was given, a failed
    // request its class (apiErrors.ts), status and message.
    const feed = this.all<{
      ts: number; kind: string; text: string | null; tool: string | null; reason: string | null; detail: string | null; input: string | null;
      status: number | null; model: string | null; sessionId: string; title: string | null; provider: string;
    }>(
      `SELECT * FROM (
         SELECT p.ts, 'prompt' AS kind, p.text, NULL AS tool, NULL AS reason, NULL AS detail, NULL AS input, NULL AS status, NULL AS model,
                p.session_id AS sessionId, ${sessionTitle("s")} AS title, p.provider
         FROM prompts p JOIN sessions s ON s.id = p.session_id WHERE p.ts >= $from
         UNION ALL
         SELECT o.ts, o.kind, NULL AS text, COALESCE(o.tool, t.tool) AS tool, o.reason, o.detail, o.input, o.status, o.model,
                COALESCE(s.parent_session_id, o.session_id) AS sessionId, ${sessionTitle("root")} AS title, o.provider
         FROM outcomes o LEFT JOIN tool_calls t ON t.id = o.id LEFT JOIN sessions s ON s.id = o.session_id
         LEFT JOIN sessions root ON root.id = COALESCE(s.parent_session_id, o.session_id)
         WHERE o.ts >= $from AND o.kind IN ('tool_error', 'tool_rejected', 'interrupt', 'api_error')
       ) ORDER BY ts DESC LIMIT 300`,
      { from },
    ).map((e) => ({
      ...e,
      text: e.text ? e.text.replace(/\s+/g, " ").slice(0, 140) : null,
      reason: e.kind === "tool_error" || e.kind === "tool_rejected" ? storedReason(e.kind, e.reason) : e.kind === "api_error" ? storedApiClass(e.reason) : null,
    }));

    // Today so far, and a typical day up to the same time: the median of the last 14 days with any use.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const sinceMidnight = now - midnight.getTime();
    const today = this.get<{ cost: number; tokens: number }>(
      `SELECT COALESCE(SUM(u.cost_usd), 0) AS cost, COALESCE(SUM(u.total_tokens), 0) AS tokens FROM usage u WHERE u.ts >= $start AND u.ts <= $now`,
      { start: midnight.getTime(), now },
    )!;
    const before: { cost: number; tokens: number }[] = [];
    for (let d = 1; d <= 14; d++) {
      const day = new Date(midnight);
      day.setDate(day.getDate() - d);
      const row = this.get<{ cost: number; tokens: number; n: number }>(
        `SELECT COALESCE(SUM(u.cost_usd), 0) AS cost, COALESCE(SUM(u.total_tokens), 0) AS tokens, COUNT(*) AS n FROM usage u WHERE u.ts >= $start AND u.ts < $end`,
        { start: day.getTime(), end: day.getTime() + sinceMidnight },
      )!;
      if (row.n) before.push(row);
    }
    const mid = (xs: number[]) => {
      if (!xs.length) return null;
      const v = [...xs].sort((a, b) => a - b);
      return v.length % 2 ? v[v.length >> 1]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
    };

    // When anything was last used, also before the window: "last activity 3 hours ago" on a quiet page.
    const ever = whereClause({ ...f, from: undefined, to: undefined });
    const last = this.get<{ ts: number | null }>(`SELECT MAX(u.ts) AS ts FROM usage u ${ever.sql}`, ever.params);
    return {
      from,
      minutes,
      series,
      costSeries,
      sessions: detailed,
      feed,
      today: { ...today, typicalCost: mid(before.map((b) => b.cost)), typicalTokens: mid(before.map((b) => b.tokens)), days: before.length },
      lastTs: last?.ts ?? null,
    };
  }

  sessions(f: Filters, opts: { sort?: string; limit?: number; offset?: number; q?: string }) {
    const w = whereClause(f);
    const params: Params = { ...w.params, limit: opts.limit ?? 50, offset: opts.offset ?? 0 };
    let having = "";
    if (opts.q) {
      // A tag is found too, whether the session or its parent session carries it.
      having = `HAVING title LIKE $q OR s.project LIKE $q OR s.id LIKE $q
                OR EXISTS (SELECT 1 FROM session_tags g WHERE g.tag LIKE $q AND g.session_id IN (u.session_id, s.parent_session_id))`;
      params.q = `%${opts.q}%`;
    }
    const sortCol = { cost: "cost", tokens: "tokens", recent: "lastTs", messages: "messages", prompts: "prompts" }[opts.sort ?? "recent"] ?? "lastTs";
    const rows = this.all<Totals & Record<string, unknown> & { id: string }>(
      `SELECT u.session_id AS id, ${sessionTitle("s")} AS title, s.project, s.provider, s.user, s.host, s.git_branch AS gitBranch,
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
    const tags = tagsForSessions(this.db, rows.map((r) => r.id));
    const labels = labelsForSessions(this.db, rows.map((r) => r.id));
    const compactions = this.compactionCounts(rows.map((r) => r.id));
    return {
      total: count,
      rows: rows.map((r) => ({
        ...r,
        projectLabel: projectLabel(r.project as string | null),
        tags: tags.get(r.id) ?? [],
        kind: labels.get(r.id)?.kind ?? null,
        aiTitle: labels.get(r.id)?.aiTitle ?? false,
        compactions: compactions.get(r.id) ?? 0,
      })),
    };
  }

  /** How many times each of these sessions compacted its context: counted for the rows of one page only. */
  private compactionCounts(ids: string[]): Map<string, number> {
    if (!ids.length || !hasTable(this.db, "compactions")) return new Map();

    const rows = this.all<{ id: string; n: number }>(
      `SELECT session_id AS id, COUNT(*) AS n FROM compactions WHERE session_id IN (SELECT value FROM json_each($ids)) GROUP BY session_id`,
      { ids: JSON.stringify(ids) },
    );
    return new Map(rows.map((r) => [r.id, r.n]));
  }

  sessionDetail(id: string) {
    const session = this.get<Record<string, unknown>>(`SELECT * FROM sessions WHERE id = $id`, { id });
    const titleOf = (sid: string) => this.get<{ title: string | null }>(`SELECT ${sessionTitle("s")} AS title FROM sessions s WHERE s.id = $id`, { id: sid })?.title ?? null;
    if (session) {
      session.title = titleOf(id);
      // A subagent's page names the session that started it.
      if (typeof session.parent_session_id === "string") {
        const parentId = session.parent_session_id;
        const parent = this.get<{ provider: string; started_at: number | null }>(`SELECT provider, started_at FROM sessions WHERE id = $id`, { id: parentId });
        // The parent's whole cost, its subagents included: what this subagent's share is of.
        const cost = this.get<{ cost: number }>(
          `SELECT COALESCE(SUM(u.cost_usd), 0) AS cost FROM usage u JOIN sessions s ON s.id = u.session_id WHERE s.id = $id OR s.parent_session_id = $id`,
          { id: parentId },
        )!.cost;
        session.parent = { id: parentId, title: titleOf(parentId), provider: parent?.provider ?? null, startedAt: parent?.started_at ?? null, cost };
      }
    }
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
      `SELECT u.ts, u.model, u.agent, COALESCE(u.spawn_ref, u.session_id) AS run, u.input_tokens AS input, u.output_tokens AS output,
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
       GROUP BY file_path ORDER BY calls DESC LIMIT 500`,
      { id },
    );
    const children = this.all(
      `SELECT s.id, s.agent, ${sessionTitle("s")} AS title, COALESCE(SUM(u.total_tokens),0) AS tokens, COALESCE(SUM(u.cost_usd),0) AS cost
       FROM sessions s LEFT JOIN usage u ON u.session_id = s.id WHERE s.parent_session_id = $id GROUP BY s.id ORDER BY cost DESC`,
      { id },
    );
    // Commits and pull requests of the session and its subagents' sessions, and its own compactions.
    const gitCond = "(g.session_id = $id OR g.session_id IN (SELECT id FROM sessions WHERE parent_session_id = $id))";
    const git = { ...gitCounts(this.db, gitCond, { id }), ...gitEvents(this.db, gitCond, { id }) };
    const compactions = sessionCompactions(this.db, id);
    return { session, totals, prompts, timeline, models, agents, tools, files, children, compactions, git };
  }

  /** Every prompt's cost, tokens and provider in the range: the prompts page's cost distribution and Pareto curve. */
  /** How spend spreads across the prompts in range: summed here, so the page gets the shape, not every prompt. */
  promptStats(f: Filters, metric: PromptMetric) {
    const w = whereClause(f);
    const rows = this.all<{ value: number; provider: string }>(
      `SELECT SUM(${metric === "cost" ? "u.cost_usd" : "u.total_tokens"}) AS value, MIN(u.provider) AS provider
       FROM usage u ${and(w.sql, "u.prompt_id IS NOT NULL")} GROUP BY u.prompt_id`,
      w.params,
    );
    return promptStats(rows, metric);
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
    // Tool calls are counted in the outer query, so only the returned page pays for the lookup.
    const rows = this.all<Record<string, unknown> & { id: string }>(
      `SELECT page.*, (SELECT COUNT(*) FROM tool_calls t WHERE t.prompt_id = page.id) AS toolCalls
       FROM (SELECT p.id, p.ts, p.text, p.skill, p.is_command AS isCommand, p.session_id AS sessionId, p.provider,
                    s.project, ${sessionTitle("s")} AS sessionTitle,
                    agg.tokens, agg.cost, agg.messages, agg.input, agg.output, agg.cacheRead, agg.cacheWrite, agg.models, agg.subagentCost
             FROM (SELECT u.prompt_id, SUM(u.total_tokens) AS tokens, SUM(u.cost_usd) AS cost, COUNT(*) AS messages,
                          SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output, SUM(u.cache_read_tokens) AS cacheRead,
                          SUM(u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite,
                          GROUP_CONCAT(DISTINCT u.model) AS models,
                          SUM(CASE WHEN u.is_subagent = 1 THEN u.cost_usd ELSE 0 END) AS subagentCost
                   FROM usage u ${where} GROUP BY u.prompt_id) agg
             JOIN prompts p ON p.id = agg.prompt_id
             LEFT JOIN sessions s ON s.id = p.session_id
             WHERE 1 = 1 ${qcond}
             ORDER BY ${sortCol} DESC LIMIT $limit OFFSET $offset) page
       ORDER BY ${sortCol} DESC`,
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
      `SELECT p.*, s.project, ${sessionTitle("s")} AS sessionTitle FROM prompts p LEFT JOIN sessions s ON s.id = p.session_id WHERE p.id = $id`,
      { id },
    );
    const totals = this.get<Totals>(`SELECT ${TOKEN_SUMS} FROM usage u WHERE u.prompt_id = $id`, { id });
    const timeline = this.all(
      `SELECT u.ts, u.model, u.agent, COALESCE(u.spawn_ref, u.session_id) AS run, u.input_tokens AS input, u.output_tokens AS output, u.cache_read_tokens AS cacheRead,
              (u.cache_write_tokens + u.cache_write_1h_tokens) AS cacheWrite, u.cost_usd AS cost
       FROM usage u WHERE u.prompt_id = $id ORDER BY u.ts`,
      { id },
    );
    const tools = this.all(`SELECT tool AS key, COUNT(*) AS calls FROM tool_calls WHERE prompt_id = $id GROUP BY tool ORDER BY calls DESC`, { id });
    const files = this.all(
      `SELECT file_path AS key, COUNT(*) AS calls FROM tool_calls WHERE prompt_id = $id AND file_path IS NOT NULL GROUP BY file_path ORDER BY calls DESC LIMIT 500`,
      { id },
    );
    const agents = this.all(`SELECT u.agent AS key, ${TOKEN_SUMS} FROM usage u WHERE u.prompt_id = $id GROUP BY u.agent ORDER BY cost DESC`, { id });
    return { prompt, totals, timeline, tools, files, agents };
  }

  tools(f: Filters) {
    // tool_calls has no model column: drop the model filter for tool-level stats.
    const { model: _model, ...rest } = f;
    const wt = whereClause(rest, "t");
    const counts = this.get<{ calls: number; tools: number; mcpTools: number; mcpCalls: number }>(
      `SELECT COUNT(*) AS calls, COUNT(DISTINCT t.tool) AS tools,
              COUNT(DISTINCT CASE WHEN substr(t.tool, 1, 5) = 'mcp__' THEN t.tool END) AS mcpTools,
              COALESCE(SUM(CASE WHEN substr(t.tool, 1, 5) = 'mcp__' THEN 1 ELSE 0 END), 0) AS mcpCalls
       FROM tool_calls t ${wt.sql}`,
      wt.params,
    )!;
    // All prompts in range, not just those that used tools, so "calls per prompt" isn't inflated.
    const w = whereClause(rest);
    const prompts = this.get<{ n: number }>(`SELECT COUNT(DISTINCT u.prompt_id) AS n FROM usage u ${w.sql}`, w.params)!.n;
    const totals = { ...counts, prompts };
    const tools = this.all<{ key: string; calls: number; sessions: number }>(
      `SELECT t.tool AS key, COUNT(*) AS calls, COUNT(DISTINCT t.session_id) AS sessions
       FROM tool_calls t ${wt.sql} GROUP BY t.tool ORDER BY calls DESC LIMIT 20`,
      wt.params,
    );
    // Each listed tool's calls split by project: the busiest projects by name, the rest folded into "other".
    const projectKeys = this.all<{ key: string | null }>(
      `SELECT t.project AS key FROM tool_calls t ${wt.sql} GROUP BY t.project ORDER BY COUNT(*) DESC LIMIT 6`,
      wt.params,
    ).map((r) => r.key ?? "(none)");
    const listed = new Set(tools.map((x) => x.key));
    const split = new Map<string, Record<string, number>>();
    for (const r of this.all<{ tool: string; project: string | null; calls: number }>(
      `SELECT t.tool, t.project, COUNT(*) AS calls FROM tool_calls t ${wt.sql} GROUP BY t.tool, t.project`,
      wt.params,
    )) {
      if (!listed.has(r.tool)) continue;
      const key = projectKeys.includes(r.project ?? "(none)") ? (r.project ?? "(none)") : "__other__";
      const row = split.get(r.tool) ?? {};
      row[key] = (row[key] ?? 0) + r.calls;
      split.set(r.tool, row);
    }
    // MCP tools are named mcp__<server>__<tool>; everything else is built into the harness.
    const sources = new Map<string, number>();
    const perTool: { key: string; calls: number; sessions: number }[] = [];
    for (const r of this.all<{ tool: string; calls: number; sessions: number }>(
      `SELECT t.tool, COUNT(*) AS calls, COUNT(DISTINCT t.session_id) AS sessions FROM tool_calls t ${wt.sql} GROUP BY t.tool`,
      wt.params,
    )) {
      const server = /^mcp__(.+?)__/.exec(r.tool)?.[1] ?? "builtin";
      sources.set(server, (sources.get(server) ?? 0) + r.calls);
      perTool.push({ key: r.tool, calls: r.calls, sessions: r.sessions });
    }
    return {
      totals,
      tools: tools.map((x) => ({ ...x, byProject: split.get(x.key) ?? {} })),
      projects: projectKeys.map((k) => ({ key: k, label: projectLabel(k === "(none)" ? null : k) })),
      sources: [...sources].map(([key, calls]) => ({ key, calls })).sort((a, b) => b.calls - a.calls),
      /** Every tool with its calls and sessions: the kinds of work and the full table. */
      counts: perTool,
    };
  }

  /** Totals and the projects with file activity, busiest first (the hotspot picker's options). */
  files(f: Filters) {
    const { model: _model, ...rest } = f;
    const wt = whereClause(rest, "t");
    const where = and(wt.sql, "t.file_path IS NOT NULL");
    const totals = this.get<{ files: number; calls: number; reads: number; edits: number }>(
      `SELECT COUNT(DISTINCT t.file_path) AS files, ${FILE_COUNTS} FROM tool_calls t ${where}`,
      wt.params,
    )!;
    const projects = this.all<{ key: string | null; files: number; calls: number }>(
      `SELECT t.project AS key, COUNT(DISTINCT t.file_path) AS files, COUNT(*) AS calls
       FROM tool_calls t ${where} GROUP BY t.project ORDER BY calls DESC LIMIT 30`,
      wt.params,
    ).map((r) => ({ ...r, key: r.key ?? "(none)", label: projectLabel(r.key) }));
    return { totals, projects };
  }

  /**
   * Where the work concentrates within the filtered scope (normally one project): the busiest folders,
   * relative to the project root, and the busiest files.
   */
  hotspots(f: Filters, limit = 8) {
    const { model: _model, ...rest } = f;
    const wt = whereClause(rest, "t");
    const rows = this.all<{ key: string; project: string | null; calls: number; reads: number; edits: number }>(
      `SELECT t.file_path AS key, MAX(t.project) AS project, ${FILE_COUNTS}
       FROM tool_calls t ${and(wt.sql, "t.file_path IS NOT NULL")} GROUP BY t.file_path`,
      wt.params,
    ).map((r) => ({ ...r, path: relativeTo(r.key, r.project), projectLabel: projectLabel(r.project) }));
    // Files a project's sessions touched outside its root (temp files, sibling repos) are not part of the
    // project: they fold into one "__outside__" folder and stay out of the file list.
    const outside = (r: { project: string | null; path: string }) => r.project != null && /^(~|\/|[A-Za-z]:[\\/])/.test(r.path);
    const folders = new Map<string, { path: string; files: number; calls: number; reads: number; edits: number }>();
    for (const r of rows) {
      const cut = Math.max(r.path.lastIndexOf("/"), r.path.lastIndexOf("\\"));
      const path = outside(r) ? "__outside__" : cut > 0 ? r.path.slice(0, cut) : ".";
      const g = folders.get(path) ?? { path, files: 0, calls: 0, reads: 0, edits: 0 };
      g.files++;
      g.calls += r.calls;
      g.reads += r.reads;
      g.edits += r.edits;
      folders.set(path, g);
    }
    const byCalls = <T extends { calls: number }>(a: T, b: T) => b.calls - a.calls;
    return {
      // The outside bucket is context, not a hotspot: it always comes last.
      folders: [...folders.values()]
        .sort((a, b) => Number(a.path === "__outside__") - Number(b.path === "__outside__") || b.calls - a.calls)
        .slice(0, limit),
      files: rows.filter((r) => !outside(r)).sort(byCalls).slice(0, limit),
    };
  }

  /** Paged, searchable list of files across projects (search matches the path). */
  fileList(f: Filters, opts: { sort?: string; limit?: number; offset?: number; q?: string }) {
    const { model: _model, ...rest } = f;
    const wt = whereClause(rest, "t");
    let where = and(wt.sql, "t.file_path IS NOT NULL");
    const params: Params = { ...wt.params };
    if (opts.q) {
      where = and(where, "t.file_path LIKE $q");
      params.q = `%${opts.q}%`;
    }
    const sortCol = { calls: "calls", edits: "edits", reads: "reads", recent: "lastTs" }[opts.sort ?? "calls"] ?? "calls";
    const rows = this.all<{ key: string; project: string | null; calls: number; reads: number; edits: number; sessions: number; lastTs: number }>(
      `SELECT t.file_path AS key, MAX(t.project) AS project, ${FILE_COUNTS},
              COUNT(DISTINCT t.session_id) AS sessions, MAX(t.ts) AS lastTs
       FROM tool_calls t ${where} GROUP BY t.file_path ORDER BY ${sortCol} DESC, key LIMIT $limit OFFSET $offset`,
      { ...params, limit: opts.limit ?? 50, offset: opts.offset ?? 0 },
    );
    const total = this.get<{ n: number }>(`SELECT COUNT(DISTINCT t.file_path) AS n FROM tool_calls t ${where}`, params)!.n;
    return { total, rows: rows.map((r) => ({ ...r, path: relativeTo(r.key, r.project), projectLabel: projectLabel(r.project) })) };
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

  /**
   * Every value of each filter dimension in the range, by cost. One pass over the combinations, folded per dimension
   * here, rather than a scan per dimension; the UI asks on every refresh, so the answer is kept until the data changes.
   */
  filters(f: Filters = {}) {
    return memo(this.db, `filters:${f.from ?? ""}:${f.to ?? ""}`, () => {
      const time = whereClause({ from: f.from, to: f.to });
      const cols = ["provider", "project", "user", "model", "skill", "agent"] as const;
      type Col = (typeof cols)[number];
      const combos = this.all<Record<Col, string | null> & { n: number; cost: number }>(
        `SELECT ${cols.map((c) => `u.${c}`).join(", ")}, COUNT(*) AS n, COALESCE(SUM(u.cost_usd), 0) AS cost
         FROM usage u ${time.sql} GROUP BY ${cols.map((c) => `u.${c}`).join(", ")}`,
        time.params,
      );
      const values = (col: Col) => {
        const sums = new Map<string | null, { n: number; cost: number }>();
        for (const r of combos) {
          const s = sums.get(r[col]) ?? { n: 0, cost: 0 };
          s.n += r.n;
          s.cost += r.cost;
          sums.set(r[col], s);
        }
        return [...sums]
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(([value, s]) => ({ value: value ?? "(none)", label: col === "project" ? projectLabel(value) : value ?? "(none)", n: s.n }));
      };
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
        // Every tag in use, whatever the range: a tag is the user's own label, and picking one never comes up empty-handed.
        tag: allTags(this.db).map((t) => ({ value: t.tag, label: t.tag, n: t.sessions })),
        // The kinds of work in use, whatever the range, like tags: only once labels exist.
        kind: this.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM session_labels GROUP BY kind")
          .sort((a, b) => KINDS.indexOf(a.kind as (typeof KINDS)[number]) - KINDS.indexOf(b.kind as (typeof KINDS)[number]))
          .map((k) => ({ value: k.kind, label: k.kind, n: k.n })),
        range,
      };
    });
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
