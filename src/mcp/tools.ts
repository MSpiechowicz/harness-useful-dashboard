import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { en } from "../../web/src/lib/locales/en.ts";
import { branchDetail, branches, branchId, type BranchRow } from "../core/branches.ts";
import type { BudgetConfig } from "../core/budgets.ts";
import { per100, sessionLines } from "../core/changes.ts";
import { friction } from "../core/friction.ts";
import type { PriceBook } from "../core/pricing.ts";
import { type Dimension, type Queries, relativeTo } from "../core/queries.ts";
import {
  budgetRows, filtersOf, filtersOut, InputError, iso, limitWindows, openReadOnly, RANGES, type Range, rangeOut, ratio, resolveRange, usd,
} from "../core/reports.ts";
import { sessionCost } from "../core/statusline.ts";
import { generateTips } from "../core/tips.ts";
import { type Schema, type Tool, ToolError } from "./server.ts";

/**
 * The tools the MCP server offers: each one a thin wrapper over the queries the dashboard's views use, with compact
 * output an agent can keep in its context. Times are ISO 8601, money is USD at API-equivalent list prices.
 */

export interface ToolContext {
  /** Where the database is. It is opened read-only on first use, and again later if it didn't exist yet. */
  dbPath: string;
  budgets: BudgetConfig;
  /** This machine's user, as its usage rows are tagged: budgets count this user's spend. */
  user: string;
  host: string;
  /** The client's working directory: the session and branch to use when none is named. */
  cwd: string;
  env: Record<string, string | undefined>;
  now?: () => number;
}

const COST_NOTE = "Costs are USD at API-equivalent list prices, not what a subscription bills.";

/** The read-only database, opened when a tool first needs it. */
class Store {
  private handle: { db: Database; queries: Queries; prices: PriceBook } | null = null;

  constructor(private path: string) {}

  get(): { db: Database; queries: Queries; prices: PriceBook } {
    if (this.handle) return this.handle;
    this.handle = openReadOnly(this.path);
    return this.handle;
  }

  close(): void {
    this.handle?.db.close();
    this.handle = null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Output helpers

const clip = (s: string | null | undefined, n: number) => {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const tokensOf = (t: { tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }) => ({
  total: t.tokens,
  input: t.input,
  output: t.output,
  cacheRead: t.cacheRead,
  cacheWrite: t.cacheWrite,
  reasoning: t.reasoning,
});

// ---------------------------------------------------------------------------------------------------------------
// Ranges and filters

function rangeProps(fallback: Range): Record<string, Schema> {
  return {
    range: {
      type: "string",
      enum: RANGES,
      description: `Time range in local time: today (since midnight), 7d or 30d (whole days, today included), month (this calendar month), all, or custom with from and to. Default ${fallback}.`,
    },
    from: { type: "string", maxLength: 40, description: "Start for range custom: a date (YYYY-MM-DD, local) or an ISO 8601 time." },
    to: { type: "string", maxLength: 40, description: "End for range custom: a date (included) or an ISO 8601 time (excluded). Default now." },
  };
}

const FILTER_PROPS: Record<string, Schema> = {
  provider: { type: "string", maxLength: 100, description: "Only this harness, e.g. claude, codex, opencode, omp, pi, cursor." },
  project: { type: "string", maxLength: 1000, description: "Only this project: its path or its folder name." },
  model: { type: "string", maxLength: 200, description: "Only this model id, e.g. claude-opus-5-5." },
  user: { type: "string", maxLength: 200, description: "Only this user (on a database shared by several people)." },
};

const limitProp = (fallback: number, max: number, what: string): Schema => ({ type: "integer", minimum: 1, maximum: max, description: `How many ${what} to return, ${fallback} by default, at most ${max}.` });
const limitOf = (args: Record<string, unknown>, fallback: number) => (typeof args.limit === "number" ? args.limit : fallback);

// ---------------------------------------------------------------------------------------------------------------
// Sessions and branches of the working directory

/** The folder and its parents, innermost first: usage is stored under the git root, which may be a parent. */
function ancestors(dir: string): string[] {
  // An absolute path is taken as it is, in its own style: a POSIX path stays one on Windows (a session recorded on
  // another machine of a shared database), and a Windows one keeps its drive and backslashes.
  const start = posix.isAbsolute(dir) || win32.isAbsolute(dir) ? dir : resolve(dir);
  const p = /^[A-Za-z]:[\\/]|^\\\\/.test(start) ? win32 : posix;
  const out: string[] = [];
  for (let d = p.normalize(start); ; d = p.dirname(d)) {
    out.push(d);
    if (p.dirname(d) === d) return out;
  }
}

/** The checked-out branch of the repository `dir` is in, read from .git/HEAD. Null when detached or not a repository. */
export function gitBranch(dir: string): string | null {
  for (const d of ancestors(dir)) {
    const dotGit = join(d, ".git");
    if (!existsSync(dotGit)) continue;
    try {
      let gitDir = dotGit;
      // A worktree or submodule: .git is a file that points at the real folder.
      if (statSync(dotGit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
        if (!m) return null;
        gitDir = resolve(d, m[1]!.trim());
      }
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
    } catch {
      return null;
    }
  }
  return null;
}

const hasSession = (db: Database, id: string) =>
  !!db.query<{ x: number }, [string, string]>("SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?) OR EXISTS (SELECT 1 FROM usage WHERE session_id = ?)").get(id, id);

/** A session id as the dashboard stores it ("claude:<id>"), or as the harness gives it (Claude Code's bare id). */
function findSession(db: Database, raw: string): string | null {
  for (const id of [raw, `claude:${raw}`]) if (hasSession(db, id)) return id;
  return db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE native_id = ? ORDER BY started_at DESC LIMIT 1").get(raw)?.id ?? null;
}

/** The session that last used the project the directory belongs to, counted from its root session. */
function latestSessionIn(db: Database, cwd: string): string | null {
  const dirs = ancestors(cwd);
  const row = db
    .query<{ id: string }, string[]>(`SELECT session_id AS id FROM usage WHERE project IN (${dirs.map(() => "?").join(", ")}) ORDER BY ts DESC LIMIT 1`)
    .get(...dirs);
  if (!row) return null;
  return db.query<{ parent: string | null }, [string]>("SELECT parent_session_id AS parent FROM sessions WHERE id = ?").get(row.id)?.parent ?? row.id;
}

// ---------------------------------------------------------------------------------------------------------------
// Tips: the dashboard's English wording, with numbers formatted as the UI does.

const MESSAGES = en as Record<string, string>;

function tipText(id: string, params: Record<string, string | number | null>): { title: string; detail: string | null } {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "number") p[k] = v == null ? "" : String(v);
    else if (["cost", "before", "after"].includes(k)) p[k] = `$${v.toFixed(2)}`;
    else if (["ratio", "share", "rate"].includes(k)) p[k] = String(Math.round(v * 10) / 10);
    else p[k] = Math.round(v).toLocaleString("en-US");
  }
  const fill = (key: string) => {
    const text = MESSAGES[key];
    return text ? text.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? "") : null;
  };
  return { title: fill(`tip.${id}.title`) ?? id, detail: fill(`tip.${id}.body`) };
}

// ---------------------------------------------------------------------------------------------------------------

/** The tools, and a close() for the database they share. */
export function createTools(ctx: ToolContext): { tools: Tool[]; close: () => void } {
  const store = new Store(ctx.dbPath);
  const now = ctx.now ?? Date.now;

  const usageSummary: Tool = {
    name: "usage_summary",
    title: "Usage summary",
    description:
      "Token use and cost of AI coding agents (Claude Code, Codex, OpenCode, …) on this machine for a time range: cost, tokens by type, sessions, prompts, cache hit rate, and the change against the period before. Use it to check spend before starting expensive work.",
    inputSchema: { type: "object", properties: { ...rangeProps("today"), ...FILTER_PROPS }, additionalProperties: false },
    run(args) {
      const { queries: q } = store.get();
      const t = now();
      const range = resolveRange(args, "today", t);
      const f = filtersOf(q, args, range);
      const s = q.summary(f);
      const prev = s.previous;
      const span = range.from != null ? (range.to ?? t) - range.from : 0;
      return {
        range: rangeOut(range, t),
        filters: filtersOut(f),
        costUsd: usd(s.cost),
        estimatedCostUsd: s.estimatedCost ? usd(s.estimatedCost) : undefined,
        tokens: tokensOf(s),
        modelCalls: s.messages,
        sessions: s.sessions,
        prompts: s.prompts,
        activeDays: s.activeDays,
        cacheHitRate: ratio(s.cacheHitRate),
        costPerPromptUsd: usd(s.costPerPrompt),
        firstActivity: iso(s.firstTs),
        lastActivity: iso(s.lastTs),
        previousPeriod: prev
          ? {
              from: iso(range.from! - span),
              to: iso(range.from),
              costUsd: usd(prev.cost),
              tokens: prev.tokens,
              sessions: prev.sessions,
              prompts: prev.prompts,
              costChange: prev.cost ? ratio((s.cost - prev.cost) / prev.cost) : null,
            }
          : null,
        note: COST_NOTE,
      };
    },
  };

  const DIMENSIONS = ["project", "model", "provider", "user", "skill", "agent"] as const;
  const breakdown: Tool = {
    name: "breakdown",
    title: "Usage breakdown",
    description: "Cost and tokens split by project, model, provider (harness), user, skill or agent for a time range, most expensive first, with each one's share of the total.",
    inputSchema: {
      type: "object",
      properties: {
        dimension: { type: "string", enum: DIMENSIONS, description: "What to group by." },
        ...rangeProps("30d"),
        ...FILTER_PROPS,
        limit: limitProp(10, 50, "rows"),
      },
      required: ["dimension"],
      additionalProperties: false,
    },
    run(args) {
      const { queries: q } = store.get();
      const t = now();
      const range = resolveRange(args, "30d", t);
      const f = filtersOf(q, args, range);
      const limit = limitOf(args, 10);
      const b = q.breakdown(f, args.dimension as Dimension, limit + 1);
      return {
        dimension: args.dimension,
        range: rangeOut(range, t),
        filters: filtersOut(f),
        totalCostUsd: usd(b.total.cost),
        totalTokens: b.total.tokens,
        rows: b.rows.slice(0, limit).map((r) => ({
          key: r.key,
          label: r.label !== r.key ? r.label : undefined,
          costUsd: usd(r.cost),
          share: ratio(r.share),
          tokens: r.tokens,
          modelCalls: r.messages,
          sessions: r.sessions,
          prompts: r.prompts,
          cacheHitRate: ratio(r.cacheHitRate),
          lastActivity: iso(r.lastTs),
          estimatedPrice: r.estimated ? true : undefined,
        })),
        moreRows: b.rows.length > limit || undefined,
        note: COST_NOTE,
      };
    },
  };

  const sessionCostTool: Tool = {
    name: "session_cost",
    title: "Session cost",
    description:
      "Cost and tokens of one agent session, its subagents included. Without session_id it takes the current Claude Code session when known, else the latest session in the working directory's project. Accepts Claude Code's session id as it is or as claude:<id>.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", maxLength: 300, description: "The session id, e.g. Claude Code's session id. Optional." },
        cwd: { type: "string", maxLength: 1000, description: "The project folder to take the latest session from when no session_id is given. Default the server's working directory." },
      },
      additionalProperties: false,
    },
    run(args) {
      const { db, queries: q } = store.get();
      let id: string | null = null;
      let resolvedBy: "session_id" | "environment" | "cwd";
      if (typeof args.session_id === "string" && args.session_id.trim()) {
        id = findSession(db, args.session_id.trim());
        if (!id) throw new ToolError(`No session ${args.session_id} in the database yet. The dashboard scans every 30 seconds while it runs.`);
        resolvedBy = "session_id";
      } else {
        const fromEnv = ctx.env.CLAUDE_CODE_SESSION_ID;
        id = fromEnv ? findSession(db, fromEnv) : null;
        resolvedBy = "environment";
        if (!id) {
          const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : ctx.cwd;
          id = latestSessionIn(db, cwd);
          resolvedBy = "cwd";
          if (!id) throw new ToolError(`No sessions found for ${cwd}. Pass session_id.`);
        }
      }
      const d = q.sessionDetail(id);
      const s = (d.session ?? {}) as Record<string, unknown>;
      const own = d.totals ?? { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, messages: 0 };
      const children = d.children as { cost: number; tokens: number }[];
      const timeline = d.timeline as { ts: number }[];
      const parent = s.parent as { id: string; title: string | null } | undefined;
      const costUsd = sessionCost(db, id) ?? own.cost;
      // Lines its edits changed, its subagents' sessions included like the cost.
      const lines = [id, ...(d.children as { id: string }[]).map((c) => c.id)].map((sid) => sessionLines(db, sid, 0));
      const added = lines.reduce((a, l) => a + l.added, 0);
      const removed = lines.reduce((a, l) => a + l.removed, 0);
      return {
        sessionId: id,
        resolvedBy,
        provider: s.provider ?? null,
        title: clip(s.title as string | null, 120),
        project: s.project ?? null,
        branch: s.git_branch ?? null,
        parentSession: parent ? { id: parent.id, title: clip(parent.title, 120) } : undefined,
        started: iso((s.started_at as number | null) ?? timeline[0]?.ts),
        lastActivity: iso(timeline[timeline.length - 1]?.ts),
        costUsd: usd(costUsd),
        ownCostUsd: usd(own.cost),
        linesChanged: { added, removed, costPer100LinesUsd: usd(per100(costUsd, added + removed)) },
        tokens: tokensOf(own),
        modelCalls: own.messages,
        prompts: d.prompts.length,
        subagents: { count: children.length, costUsd: usd(children.reduce((a, c) => a + c.cost, 0)), tokens: children.reduce((a, c) => a + c.tokens, 0) },
        models: (d.models as { key: string | null; cost: number; tokens: number }[]).slice(0, 5).map((m) => ({ model: m.key ?? "(none)", costUsd: usd(m.cost), tokens: m.tokens })),
        note: COST_NOTE,
      };
    },
  };

  const branchCost: Tool = {
    name: "branch_cost",
    title: "Branch cost",
    description:
      "What the work on one git branch cost over its whole life: cost, tokens, sessions, models, the latest sessions and the files changed most. Without branch it takes the branch checked out in the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        branch: { type: "string", maxLength: 300, description: "The branch name. Default the branch checked out in the working directory." },
        project: { type: "string", maxLength: 1000, description: "The project path or folder name, when the branch name is used in several projects." },
      },
      additionalProperties: false,
    },
    run(args) {
      const { db } = store.get();
      const branch = typeof args.branch === "string" && args.branch ? args.branch : gitBranch(ctx.cwd);
      if (!branch) throw new ToolError(`No branch given, and ${ctx.cwd} has no branch checked out. Pass branch.`);
      const project = typeof args.project === "string" && args.project ? args.project : null;
      const here = new Set(ancestors(ctx.cwd));
      let rows = branches(db, {}).rows.filter((r: BranchRow) => r.branch === branch);
      if (project) rows = rows.filter((r) => r.project === project.replace(/[\\/]+$/, "") || r.projectLabel.toLowerCase() === project.toLowerCase());
      // The same branch name in several projects: the one the working directory is in, else the most expensive.
      const pick = rows.find((r) => r.project && here.has(r.project)) ?? rows[0];
      if (!pick) throw new ToolError(`No usage on branch ${branch}${project ? ` in ${project}` : ""} yet.`);
      const d = branchDetail(db, branchId(pick.branch, pick.project));
      return {
        branch: d.branch,
        project: d.project,
        longLived: d.longLived || undefined,
        costUsd: usd(d.totals.cost),
        tokens: d.totals.tokens,
        modelCalls: d.totals.messages,
        sessions: d.totals.sessions,
        prompts: d.totals.prompts,
        firstActivity: iso(d.totals.firstTs),
        lastActivity: iso(d.totals.lastTs),
        linesChanged: { added: d.lines.added, removed: d.lines.removed, files: d.lines.files, costPer100LinesUsd: usd(d.lines.costPer100) },
        models: d.models.slice(0, 5).map((m) => ({ model: m.key, costUsd: usd(m.cost), tokens: m.tokens, linesChanged: m.added + m.removed || undefined })),
        latestSessions: d.sessions.slice(0, 10).map((s) => ({
          id: s.id,
          title: clip(s.title, 100),
          provider: s.provider,
          costUsd: usd(s.cost),
          subagents: s.subagents || undefined,
          lastActivity: iso(s.lastTs),
        })),
        topEditedFiles: d.files.slice(0, 10).map((f) => ({ file: relativeTo(f.key, d.project), edits: f.edits })),
        sameBranchElsewhere: rows.length > 1 ? rows.filter((r) => r !== pick).slice(0, 5).map((r) => ({ project: r.project, costUsd: usd(r.cost) })) : undefined,
        note: COST_NOTE,
      };
    },
  };

  const limits: Tool = {
    name: "limits",
    title: "Plan limits",
    description:
      "How much of each subscription plan limit is used (Claude 5-hour and weekly windows, Codex, Copilot premium requests, …), when it resets, and how old the reading is. Readings come from the database the dashboard keeps while it runs. Providers are never asked.",
    inputSchema: { type: "object", additionalProperties: false },
    run() {
      const { db } = store.get();
      const out = limitWindows(db, ctx.host, now());
      return {
        windows: out,
        note: out.length
          ? "Readings older than 15 minutes are stale. The dashboard refreshes them every few minutes while it runs."
          : "No plan-limit readings stored in the last 30 days. Start the dashboard to record them.",
      };
    },
  };

  const budgets: Tool = {
    name: "budget_status",
    title: "Budget status",
    description: "How the spending caps set in the dashboard stand: today's and this month's spend against the daily, monthly and per-project caps, with the month's projected total. Counts this machine's user.",
    inputSchema: { type: "object", additionalProperties: false },
    run() {
      const { db } = store.get();
      const items = budgetRows(db, ctx.budgets, ctx.user, now());
      return {
        user: ctx.user,
        budgets: items,
        note: items.length ? COST_NOTE : "No budgets set. They are set in the dashboard under Settings, Budgets and alerts.",
      };
    },
  };

  const failures: Tool = {
    name: "failures",
    title: "Tool failures",
    description:
      "Why agent tool calls failed in a time range: failure causes (timeout, edit mismatch, not found, permission, exit code, …), the tools that fail most, and the latest failures with their error text (secrets redacted, shortened).",
    inputSchema: {
      type: "object",
      properties: {
        ...rangeProps("7d"),
        provider: FILTER_PROPS.provider!,
        project: FILTER_PROPS.project!,
        model: FILTER_PROPS.model!,
        tool: { type: "string", maxLength: 200, description: "Only this tool, e.g. Edit or Bash." },
        limit: limitProp(10, 50, "recent failures"),
      },
      additionalProperties: false,
    },
    run(args) {
      const { db, queries: q } = store.get();
      const t = now();
      const range = resolveRange(args, "7d", t);
      const f = filtersOf(q, args, range);
      const r = friction(db, f, "day");
      const tool = typeof args.tool === "string" && args.tool ? args.tool : null;
      const limit = limitOf(args, 10);
      const tools = r.tools.filter((x) => !tool || x.key === tool);
      const recent = r.recent.filter((x) => !tool || x.tool === tool).slice(0, limit);
      // Failed model requests (rate limits, overloads), when this version of the database counts them.
      const api = (r as { apiErrors?: { total: number; rate: number | null; classes: { cls: string; count: number }[] } }).apiErrors;
      return {
        range: rangeOut(range, t),
        filters: filtersOut(f),
        tool: tool ?? undefined,
        totals: tool
          ? undefined
          : { calls: r.totals.calls, failed: r.totals.errors, declined: r.totals.rejected, interruptedPrompts: r.totals.interrupts, errorRate: ratio(r.totals.errorRate) },
        causes: tool ? undefined : r.reasons.slice(0, 10).map((x) => ({ cause: x.reason, count: x.count, share: ratio(x.share), tools: x.tools.map((y) => y.tool) })),
        tools: tools.slice(0, 10).map((x) => ({ tool: x.key, calls: x.calls, failed: x.errors, declined: x.rejected, errorRate: ratio(x.errorRate), mainCause: x.topReason ?? undefined })),
        recent: recent.map((x) => ({
          time: iso(x.ts),
          tool: x.tool,
          cause: x.reason,
          error: clip(x.detail, 300),
          input: clip(x.input, 150),
          provider: x.provider,
          project: x.projectLabel !== "(none)" ? x.projectLabel : undefined,
          sessionId: x.sessionId,
        })),
        apiErrors: !tool && api?.total ? { failedRequests: api.total, rate: ratio(api.rate), classes: api.classes.slice(0, 5).map((c) => ({ class: c.cls, count: c.count })) } : undefined,
        note: tool ? "recent lists this tool's failures among the latest 200 failures in the range." : undefined,
      };
    },
  };

  const tips: Tool = {
    name: "tips",
    title: "Usage tips",
    description: "Rule-based suggestions to spend less from the usage in a time range (cache misses, context bloat, premium models on small prompts, tool loops, spikes, …), largest monthly impact first.",
    inputSchema: { type: "object", properties: { ...rangeProps("30d"), ...FILTER_PROPS, limit: limitProp(10, 30, "tips") }, additionalProperties: false },
    run(args) {
      const { db, queries: q, prices } = store.get();
      const t = now();
      const range = resolveRange(args, "30d", t);
      const f = filtersOf(q, args, range);
      const list = [...generateTips(db, f, prices)].sort((a, b) => b.impact - a.impact);
      const limit = limitOf(args, 10);
      return {
        range: rangeOut(range, t),
        filters: filtersOut(f),
        tips: list.slice(0, limit).map((tip) => {
          const text = tipText(tip.id, tip.params);
          const link = /^#\/(sessions|prompts)\/(.+)$/.exec(tip.link ?? "");
          return {
            id: tip.id,
            severity: tip.severity,
            category: tip.category,
            title: text.title,
            detail: text.detail,
            impactUsdPerMonth: usd(tip.impact) || undefined,
            sessionId: link?.[1] === "sessions" ? decodeURIComponent(link[2]!) : undefined,
            promptId: link?.[1] === "prompts" ? decodeURIComponent(link[2]!) : undefined,
          };
        }),
        moreTips: list.length > limit || undefined,
      };
    },
  };

  const tools = [usageSummary, breakdown, sessionCostTool, branchCost, limits, budgets, failures, tips];
  // The shared report code reports bad input as InputError: the agent sees it as a tool error it can correct.
  const asToolErrors = (t: Tool): Tool => ({
    ...t,
    run(args) {
      try {
        return t.run(args);
      } catch (e) {
        throw e instanceof InputError ? new ToolError(e.message) : e;
      }
    },
  });
  return { tools: tools.map(asToolErrors), close: () => store.close() };
}
