import type { Database } from "bun:sqlite";
import { storedApiClass } from "./apiErrors.ts";
import { type BudgetConfig, budgetStatus, windowName } from "./budgets.ts";
import { memo } from "./cache.ts";
import { storedReason } from "./failures.ts";
import { type LimitSource, storedReports } from "./limits.ts";
import { normalizeModel } from "./models.ts";
import { projectLabel, type Queries } from "./queries.ts";
import { tagUsage } from "./tagUsage.ts";
import { UNTAGGED } from "./tags.ts";

/**
 * The Prometheus text exposition format (0.0.4) for GET /metrics: all-time totals as counters, plan limits, budgets
 * and live sessions as gauges. The totals come from a few GROUP BY queries kept until the data changes, so a scrape
 * every 15 seconds costs next to nothing. Plan limits are read from the readings the app stored, never asked of a
 * provider here.
 */
export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type Labels = Record<string, string>;
type Sample = [Labels, number];

interface Family {
  name: string;
  help: string;
  type: "counter" | "gauge";
  samples: Sample[];
}

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const escapeHelp = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

function render(families: Family[]): string {
  const out: string[] = [];
  for (const f of families) {
    out.push(`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`);
    for (const [labels, value] of f.samples) {
      if (!Number.isFinite(value)) continue;
      const l = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",");
      out.push(`${f.name}${l ? `{${l}}` : ""} ${value}`);
    }
  }
  return out.join("\n") + "\n";
}

/** Adds up rows that land on the same label set (two models that normalize to one id, two folders with one name). */
class Sums {
  private map = new Map<string, Sample>();
  add(labels: Labels, value: number): void {
    const key = JSON.stringify(labels);
    const hit = this.map.get(key);
    if (hit) hit[1] += value;
    else this.map.set(key, [labels, value]);
  }
  samples(): Sample[] {
    return [...this.map.values()].sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0])));
  }
}

/** The totals since the first row. Cached on the data's version: the label sets are what costs, not the rendering. */
function counters(db: Database, projectLabels: boolean): string {
  return memo(db, `metrics:${projectLabels}`, () => computeCounters(db, projectLabels), 60 * 60_000);
}

function computeCounters(db: Database, projectLabels: boolean): string {
  const project = (p: string | null): Labels => (projectLabels ? { project: projectLabel(p) } : {});
  const all = <T>(sql: string) => db.query<T, []>(sql).all();

  const tokens = new Sums();
  const cost = new Sums();
  const requests = new Sums();
  for (const r of all<{ provider: string; model: string | null; project: string | null; user: string | null; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number; n: number }>(
    // The output a row keeps includes its reasoning: split here so the types add up to the total.
    `SELECT provider, model, project, user, SUM(input_tokens) AS input, SUM(MAX(output_tokens - reasoning_tokens, 0)) AS output,
            SUM(reasoning_tokens) AS reasoning, SUM(cache_read_tokens) AS cacheRead, SUM(cache_write_tokens + cache_write_1h_tokens) AS cacheWrite,
            SUM(cost_usd) AS cost, COUNT(*) AS n
     FROM usage GROUP BY provider, model, project, user`,
  )) {
    const base = { provider: r.provider, model: normalizeModel(r.model), ...project(r.project), user: r.user ?? "" };
    for (const [type, v] of [["input", r.input], ["output", r.output], ["cache_read", r.cacheRead], ["cache_write", r.cacheWrite], ["reasoning", r.reasoning]] as const) tokens.add({ ...base, type }, v);
    cost.add(base, r.cost);
    requests.add(base, r.n);
  }

  const sessions = new Sums();
  const prompts = new Sums();
  for (const r of all<{ provider: string; project: string | null; user: string | null; sessions: number; prompts: number }>(
    `SELECT provider, project, user, COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT prompt_id) AS prompts FROM usage GROUP BY provider, project, user`,
  )) {
    const base = { provider: r.provider, ...project(r.project), user: r.user ?? "" };
    sessions.add(base, r.sessions);
    prompts.add(base, r.prompts);
  }

  const calls = new Sums();
  const failures = new Sums();
  const OUTCOME = { tool_ok: "ok", tool_error: "error", tool_rejected: "declined" } as const;
  for (const r of all<{ provider: string; tool: string | null; kind: keyof typeof OUTCOME; reason: string | null; n: number }>(
    `SELECT provider, tool, kind, reason, COUNT(*) AS n FROM outcomes WHERE kind IN ('tool_ok', 'tool_error', 'tool_rejected') GROUP BY provider, tool, kind, reason`,
  )) {
    const tool = r.tool ?? "unknown";
    calls.add({ provider: r.provider, tool, outcome: OUTCOME[r.kind] }, r.n);
    if (r.kind !== "tool_ok") failures.add({ provider: r.provider, tool, reason: storedReason(r.kind, r.reason) }, r.n);
  }

  const apiErrors = new Sums();
  for (const r of all<{ provider: string; model: string | null; reason: string | null; n: number }>(
    `SELECT provider, model, reason, COUNT(*) AS n FROM outcomes WHERE kind = 'api_error' GROUP BY provider, model, reason`,
  )) {
    apiErrors.add({ provider: r.provider, model: normalizeModel(r.model), class: storedApiClass(r.reason) }, r.n);
  }

  const added = new Sums();
  const removed = new Sums();
  for (const r of all<{ provider: string; model: string | null; project: string | null; added: number; removed: number }>(
    `SELECT provider, model, project, SUM(lines_added) AS added, SUM(lines_removed) AS removed FROM tool_calls WHERE lines_added IS NOT NULL GROUP BY provider, model, project`,
  )) {
    const base = { provider: r.provider, model: normalizeModel(r.model), ...project(r.project) };
    added.add(base, r.added);
    removed.add(base, r.removed);
  }

  // A session with several tags counts in each, so the series add up to more than the total.
  const tags = tagUsage(db, {}).rows.filter((r) => r.key !== UNTAGGED).map((r): Sample => [{ tag: r.key }, r.cost]);

  const reset = " A re-pricing or trimmed history can lower it: use rate() or increase(), which handle the reset.";
  const family = (name: string, help: string, s: Sums | Sample[]): Family => ({ name, help, type: "counter", samples: Array.isArray(s) ? s : s.samples() });
  return render([
    family("harness_tokens_total", `Tokens used, by type. Output leaves out reasoning, which has its own type.${reset}`, tokens),
    family("harness_cost_usd_total", `Cost in USD at API-equivalent prices.${reset}`, cost),
    family("harness_requests_total", "Model calls made.", requests),
    family("harness_sessions_total", "Sessions with usage.", sessions),
    family("harness_prompts_total", "Prompts that led to model calls.", prompts),
    family("harness_tool_calls_total", "Tool calls, by how they ended: ok, error or declined.", calls),
    family("harness_tool_failures_total", "Tool calls that failed or were declined, by reason.", failures),
    family("harness_api_errors_total", "Model requests that failed, by class (rate_limit, overloaded, server_error, timeout, network, auth, billing, context_length, other).", apiErrors),
    family("harness_lines_added_total", "Lines the agents' edits added.", added),
    family("harness_lines_removed_total", "Lines the agents' edits removed.", removed),
    family("harness_tag_cost_usd_total", `Cost in USD of the sessions that carry each tag. A session with several tags counts in each, and tagging again moves cost between tags.${reset}`, tags),
  ]);
}

export interface MetricsInput {
  db: Database;
  queries: Queries;
  budgets: BudgetConfig;
  projectLabels: boolean;
  user: string;
  host: string;
  version: string;
  /** When the last scan finished, epoch ms. */
  lastScanAt: number | null;
  now?: number;
}

const LIMIT_SOURCES: LimitSource[] = ["claude", "omp", "codex", "pi", "opencode", "copilot"];

/** The plan windows' use and reset times from the readings stored last, as gauges. */
function limitFamilies(db: Database, host: string, now: number): Family[] {
  const used = new Map<string, Sample>();
  const resets = new Map<string, Sample>();
  for (const source of LIMIT_SOURCES) {
    for (const rep of storedReports(db, host, source, now)) {
      for (const w of rep.windows) {
        const name = windowName(w.windowMs, w.label) || w.id;
        const labels = { provider: rep.provider, plan: rep.plan ?? "", window: w.scope ? `${name}_${w.scope.toLowerCase().replace(/\W+/g, "_")}` : name };
        const key = JSON.stringify(labels);
        used.set(key, [labels, Math.min(1, Math.max(0, w.usedFraction))]);
        if (w.resetsAt != null) resets.set(key, [labels, w.resetsAt / 1000]);
      }
    }
  }
  return [
    { name: "harness_plan_limit_used_ratio", help: "How much of a plan limit window is used, from 0 to 1, as of the last reading the app stored.", type: "gauge", samples: [...used.values()] },
    { name: "harness_plan_limit_resets_at_seconds", help: "When a plan limit window resets, in Unix seconds.", type: "gauge", samples: [...resets.values()] },
  ];
}

export function metricsText(i: MetricsInput): string {
  const now = i.now ?? Date.now();
  const budget = (name: string, help: string, pick: "spent" | "cap"): Family => ({
    name,
    help,
    type: "gauge",
    samples: budgetStatus(i.db, i.budgets, i.user, new Date(now))
      // With project labels off, a project's cap has no name to carry.
      .filter((b) => b.scope !== "project" || i.projectLabels)
      .map((b): Sample => [{ scope: b.scope, ...(b.scope === "project" ? { project: projectLabel(b.project) } : {}) }, b[pick]]),
  });
  // Sessions of the last hour by what they are doing: the Live view's own count, kept for 15 seconds.
  const status = memo(i.db, "metrics:live", () => {
    const counts = { working: 0, idle: 0, error: 0 };
    for (const s of i.queries.live({}, 60, now).sessions) counts[s.status]++;
    return counts;
  }, 15_000);
  return (
    counters(i.db, i.projectLabels) +
    render([
      ...limitFamilies(i.db, i.host, now),
      budget("harness_budget_spent_usd", "Spent so far this day, this month or this month in a project, for each cap that is set.", "spent"),
      budget("harness_budget_cap_usd", "The cap set for the day, the month or a project's month.", "cap"),
      { name: "harness_live_sessions", help: "Sessions active in the last hour, by what they are doing now.", type: "gauge", samples: Object.entries(status).map(([s, n]): Sample => [{ status: s }, n]) },
      { name: "harness_last_scan_timestamp_seconds", help: "When the last scan of the logs finished, in Unix seconds.", type: "gauge", samples: i.lastScanAt ? [[{}, i.lastScanAt / 1000]] : [] },
      { name: "harness_build_info", help: "The dashboard's version, always 1.", type: "gauge", samples: [[{ version: i.version }, 1]] },
    ])
  );
}
