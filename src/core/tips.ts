import type { Database } from "bun:sqlite";
import { normalizeModel, type PriceBook } from "./pricing.ts";
import { type Filters, projectLabel, READ_TOOLS, whereClause } from "./queries.ts";

export type Severity = "info" | "warn" | "critical";

/** Tips carry an id + params; the UI owns the (translated) wording. */
export interface Tip {
  id: string;
  severity: Severity;
  params: Record<string, string | number | null>;
  /** Optional in-app link, e.g. "#/sessions/<id>". */
  link?: string;
  /** Rough monthly USD impact used for ordering. */
  impact: number;
}

const PREMIUM = /fable|mythos|opus|gpt-6|o3-pro/;

export function generateTips(db: Database, f: Filters, prices: PriceBook): Tip[] {
  const w = whereClause(f);
  const and = (cond: string) => (w.sql ? `${w.sql} AND ${cond}` : `WHERE ${cond}`);
  const q = <T>(sql: string, extra: Record<string, string | number> = {}) => db.query<T, any>(sql).all({ ...w.params, ...extra });
  const one = <T>(sql: string, extra: Record<string, string | number> = {}) => db.query<T, any>(sql).get({ ...w.params, ...extra });

  const t = one<{
    cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number;
    reasoning: number; messages: number; estCost: number; subCost: number; minTs: number; maxTs: number;
  }>(
    `SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
            COALESCE(SUM(cache_read_tokens),0) AS cacheRead, COALESCE(SUM(cache_write_tokens),0) AS cacheWrite,
            COALESCE(SUM(cache_write_1h_tokens),0) AS cacheWrite1h, COALESCE(SUM(reasoning_tokens),0) AS reasoning,
            COUNT(*) AS messages,
            COALESCE(SUM(CASE WHEN cost_estimated = 1 THEN cost_usd ELSE 0 END),0) AS estCost,
            COALESCE(SUM(CASE WHEN is_subagent = 1 THEN cost_usd ELSE 0 END),0) AS subCost,
            MIN(ts) AS minTs, MAX(ts) AS maxTs
     FROM usage u ${w.sql}`,
  )!;
  if (!t || t.messages === 0) return [];
  const tips: Tip[] = [];
  const spanDays = Math.max(1, (t.maxTs - t.minTs) / 86_400_000);
  const monthly = (usd: number) => (usd / spanDays) * 30;
  const pct = (x: number) => Math.round(x * 100);

  // 1. Cache hit rate
  const promptTokens = t.input + t.cacheRead + t.cacheWrite + t.cacheWrite1h;
  const hit = promptTokens ? t.cacheRead / promptTokens : 0;
  if (promptTokens > 1_000_000 && hit < 0.6) {
    tips.push({ id: "low-cache-hit", severity: hit < 0.35 ? "critical" : "warn", params: { rate: pct(hit) }, link: "#/cache", impact: monthly(t.cost * (0.6 - hit)) });
  }

  // 2. Cache writes dominating spend
  const writes = q<{ model: string | null; w5: number; w1: number }>(
    `SELECT model, SUM(cache_write_tokens) AS w5, SUM(cache_write_1h_tokens) AS w1 FROM usage u ${and("provider != 'cursor'")} GROUP BY model`,
  ).reduce((sum, r) => {
    const { price } = prices.lookup(r.model);
    return sum + (r.w5 * (price.cacheWrite5m ?? price.input * 1.25) + r.w1 * (price.cacheWrite1h ?? price.input * 2)) / 1e6;
  }, 0);
  if (t.cost > 1 && writes / t.cost > 0.3) {
    tips.push({ id: "cache-write-heavy", severity: "warn", params: { share: pct(writes / t.cost), has1h: t.cacheWrite1h > t.cacheWrite ? 1 : 0 }, link: "#/cache", impact: monthly(writes * 0.3) });
  }

  // 3. Context bloat: very large average prompt per call
  const avgContext = promptTokens / t.messages;
  if (avgContext > 120_000) {
    tips.push({ id: "context-bloat", severity: avgContext > 250_000 ? "critical" : "warn", params: { avg: Math.round(avgContext) }, link: "#/sessions", impact: monthly(t.cost * 0.2) });
  }

  // 4. Premium models used for small prompts
  const small = q<{ model: string; prompts: number; cost: number }>(
    `SELECT model, COUNT(*) AS prompts, SUM(cost) AS cost FROM (
       SELECT prompt_id, MAX(model) AS model, SUM(output_tokens) AS output, COUNT(*) AS msgs, SUM(cost_usd) AS cost
       FROM usage u ${and("prompt_id IS NOT NULL")} GROUP BY prompt_id
     ) WHERE output < 1500 AND msgs <= 3 GROUP BY model`,
  ).filter((r) => PREMIUM.test(normalizeModel(r.model)));
  const smallCost = small.reduce((a, r) => a + r.cost, 0);
  const smallCount = small.reduce((a, r) => a + r.prompts, 0);
  if (smallCount >= 10 && smallCost > 0.5) {
    const top = small.sort((a, b) => b.cost - a.cost)[0]!;
    tips.push({ id: "premium-small-prompts", severity: "info", params: { count: smallCount, cost: round2(smallCost), model: normalizeModel(top.model) }, link: "#/prompts", impact: monthly(smallCost * 0.6) });
  }

  // 5. Project concentration
  const projects = q<{ project: string | null; cost: number }>(`SELECT project, SUM(cost_usd) AS cost FROM usage u ${w.sql} GROUP BY project ORDER BY cost DESC LIMIT 2`);
  if (projects.length > 1 && t.cost > 1 && projects[0]!.cost / t.cost > 0.5 && !f.project) {
    tips.push({ id: "project-concentration", severity: "info", params: { project: projectLabel(projects[0]!.project), share: pct(projects[0]!.cost / t.cost) }, link: "#/projects", impact: 0 });
  }

  // 6. Subagent share
  if (t.cost > 1 && t.subCost / t.cost > 0.3) {
    tips.push({ id: "subagent-share", severity: "info", params: { share: pct(t.subCost / t.cost) }, link: "#/agents", impact: monthly(t.subCost * 0.2) });
  }

  // 7. Codex guardian / auto-review overhead
  const guardian = one<{ cost: number }>(`SELECT COALESCE(SUM(cost_usd),0) AS cost FROM usage u ${and("agent = 'guardian'")}`)!.cost;
  if (t.cost > 1 && guardian / t.cost > 0.08) {
    tips.push({ id: "guardian-overhead", severity: "info", params: { share: pct(guardian / t.cost), cost: round2(guardian) }, link: "#/agents", impact: monthly(guardian * 0.5) });
  }

  // 8. Spike: most recent day vs trailing 7-day average
  const days = q<{ day: string; cost: number }>(
    `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS cost FROM usage u ${w.sql} GROUP BY day ORDER BY day DESC LIMIT 8`,
  );
  if (days.length >= 4) {
    const [latest, ...prev] = days;
    const avg = prev.reduce((a, d) => a + d.cost, 0) / prev.length;
    if (avg > 0.5 && latest!.cost > avg * 2) {
      tips.push({ id: "spike", severity: latest!.cost > avg * 4 ? "critical" : "warn", params: { day: latest!.day, ratio: round1(latest!.cost / avg), cost: round2(latest!.cost) }, link: "#/trends", impact: latest!.cost - avg });
    }
  }

  // 9. Outlier prompts
  const promptCosts = q<{ prompt_id: string; cost: number }>(
    `SELECT prompt_id, SUM(cost_usd) AS cost FROM usage u ${and("prompt_id IS NOT NULL")} GROUP BY prompt_id ORDER BY cost`,
  );
  if (promptCosts.length >= 20) {
    const median = promptCosts[Math.floor(promptCosts.length / 2)]!.cost;
    const top = promptCosts[promptCosts.length - 1]!;
    if (median > 0 && top.cost > median * 15 && top.cost > 1) {
      const text = db.query<{ text: string | null }, [string]>("SELECT text FROM prompts WHERE id = ?").get(top.prompt_id)?.text ?? "";
      tips.push({ id: "outlier-prompt", severity: "info", params: { cost: round2(top.cost), ratio: Math.round(top.cost / median), text: text.slice(0, 80) }, link: `#/prompts/${encodeURIComponent(top.prompt_id)}`, impact: 0 });
    }
  }

  // 10. Tool loops
  const { model: _model, ...toolFilters } = f;
  const tw = whereClause(toolFilters, "t");
  const loops = db
    .query<{ prompt_id: string; calls: number }, any>(
      `SELECT prompt_id, COUNT(*) AS calls FROM tool_calls t ${tw.sql ? tw.sql + " AND" : "WHERE"} prompt_id IS NOT NULL
       GROUP BY prompt_id HAVING calls > 150 ORDER BY calls DESC`,
    )
    .all(tw.params);
  if (loops.length) {
    tips.push({ id: "tool-loops", severity: "warn", params: { count: loops.length, max: loops[0]!.calls }, link: `#/prompts/${encodeURIComponent(loops[0]!.prompt_id)}`, impact: 0 });
  }

  // 11. Same file read over and over in one session
  const reread = db
    .query<{ file_path: string; session_id: string; n: number }, any>(
      `SELECT file_path, session_id, COUNT(*) AS n FROM tool_calls t ${tw.sql ? tw.sql + " AND" : "WHERE"} tool IN (${READ_TOOLS}) AND file_path IS NOT NULL
       GROUP BY session_id, file_path HAVING n >= 8 ORDER BY n DESC LIMIT 1`,
    )
    .get(tw.params);
  if (reread) {
    tips.push({ id: "repeated-reads", severity: "info", params: { file: reread.file_path.split(/[\\/]/).pop() ?? reread.file_path, count: reread.n }, link: `#/sessions/${encodeURIComponent(reread.session_id)}`, impact: 0 });
  }

  // 12. Reasoning-heavy output
  if (t.output > 500_000 && t.reasoning / t.output > 0.5) {
    tips.push({ id: "reasoning-heavy", severity: "info", params: { share: pct(t.reasoning / t.output) }, link: "#/models", impact: monthly(t.cost * 0.1) });
  }

  // 13. Long sessions
  const long = one<{ id: string; msgs: number; cost: number; title: string | null }>(
    `SELECT u.session_id AS id, COUNT(*) AS msgs, SUM(u.cost_usd) AS cost, MAX(s.title) AS title
     FROM usage u LEFT JOIN sessions s ON s.id = u.session_id ${w.sql}
     GROUP BY u.session_id HAVING msgs > 400 ORDER BY cost DESC LIMIT 1`,
  );
  if (long) {
    tips.push({ id: "long-session", severity: "info", params: { messages: long.msgs, cost: round2(long.cost), title: long.title ?? "" }, link: `#/sessions/${encodeURIComponent(long.id)}`, impact: monthly(long.cost * 0.2) });
  }

  // 14. Unknown model prices
  if (t.cost > 0 && t.estCost / t.cost > 0.15) {
    const models = q<{ model: string | null }>(`SELECT model FROM usage u ${and("cost_estimated = 1")} GROUP BY model ORDER BY SUM(cost_usd) DESC LIMIT 3`)
      .map((r) => normalizeModel(r.model))
      .join(", ");
    tips.push({ id: "estimated-pricing", severity: "info", params: { share: pct(t.estCost / t.cost), models }, link: "#/settings", impact: 0 });
  }

  const rank: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };
  return tips.sort((a, b) => rank[a.severity] - rank[b.severity] || b.impact - a.impact);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
