import type { Database, Statement } from "bun:sqlite";
import type { PriceBook } from "../pricing.ts";
import { projectResolver } from "../project.ts";
import type { IngestSink, LimitRecord, PromptRecord, SessionRecord, ToolRecord, UsageRecord } from "./types.ts";

export interface WriterStats {
  usage: number;
  prompts: number;
  tools: number;
}

/** IngestSink that upserts into SQLite. Callers wrap usage in a transaction. */
export class DbWriter implements IngestSink {
  readonly stats: WriterStats = { usage: 0, prompts: 0, tools: 0 };
  /** Maps each record's working directory to its project (repo root), cached for the writer's lifetime. */
  readonly project = projectResolver();
  private sSession: Statement;
  private sPrompt: Statement;
  private sUsage: Statement;
  private sTool: Statement;
  private sLimit: Statement;

  constructor(
    db: Database,
    private prices: PriceBook,
    private identity: { user: string; host: string },
  ) {
    this.sSession = db.prepare(`
      INSERT INTO sessions (id, provider, native_id, project, user, host, title, git_branch, client, client_version,
                            parent_session_id, agent, started_at, ended_at)
      VALUES ($id, $provider, $nativeId, $project, $user, $host, $title, $gitBranch, $client, $clientVersion,
              $parentSessionId, $agent, $startedAt, $endedAt)
      ON CONFLICT(id) DO UPDATE SET
        project           = COALESCE(sessions.project, excluded.project),
        title             = COALESCE(excluded.title, sessions.title),
        git_branch        = COALESCE(sessions.git_branch, excluded.git_branch),
        client            = COALESCE(sessions.client, excluded.client),
        client_version    = COALESCE(excluded.client_version, sessions.client_version),
        parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
        agent             = COALESCE(sessions.agent, excluded.agent),
        started_at        = MIN(COALESCE(sessions.started_at, excluded.started_at), COALESCE(excluded.started_at, sessions.started_at)),
        ended_at          = MAX(COALESCE(sessions.ended_at, excluded.ended_at), COALESCE(excluded.ended_at, sessions.ended_at))
    `);
    this.sPrompt = db.prepare(`
      INSERT INTO prompts (id, session_id, provider, ts, text, skill, is_command)
      VALUES ($id, $sessionId, $provider, $ts, $text, $skill, $isCommand)
      ON CONFLICT(id) DO UPDATE SET skill = COALESCE(prompts.skill, excluded.skill)
    `);
    this.sUsage = db.prepare(`
      INSERT INTO usage (id, provider, session_id, prompt_id, ts, project, user, host, model, skill, agent, is_subagent,
                         spawn_ref, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                         cache_write_1h_tokens, reasoning_tokens, total_tokens, cost_usd, cost_estimated, speed,
                         billing, premium_requests)
      VALUES ($id, $provider, $sessionId, $promptId, $ts, $project, $user, $host, $model, $skill, $agent, $isSubagent,
              $spawnRef, $input, $output, $cacheRead, $cacheWrite, $cacheWrite1h, $reasoning, $total, $cost,
              $estimated, $speed, $billing, $premiumRequests)
      ON CONFLICT(id) DO UPDATE SET
        -- Streaming transcripts can repeat a message with growing counts: keep the largest.
        input_tokens          = MAX(usage.input_tokens, excluded.input_tokens),
        output_tokens         = MAX(usage.output_tokens, excluded.output_tokens),
        cache_read_tokens     = MAX(usage.cache_read_tokens, excluded.cache_read_tokens),
        cache_write_tokens    = MAX(usage.cache_write_tokens, excluded.cache_write_tokens),
        cache_write_1h_tokens = MAX(usage.cache_write_1h_tokens, excluded.cache_write_1h_tokens),
        reasoning_tokens      = MAX(usage.reasoning_tokens, excluded.reasoning_tokens),
        total_tokens          = MAX(usage.total_tokens, excluded.total_tokens),
        cost_usd              = MAX(usage.cost_usd, excluded.cost_usd),
        prompt_id             = COALESCE(usage.prompt_id, excluded.prompt_id),
        skill                 = COALESCE(usage.skill, excluded.skill),
        billing               = COALESCE(usage.billing, excluded.billing),
        premium_requests      = MAX(usage.premium_requests, excluded.premium_requests)
    `);
    // Only a newer reading replaces the one kept, so rereading an old log can't roll a limit back.
    this.sLimit = db.prepare(`
      INSERT INTO plan_limits (provider, host, window_id, window_minutes, used_percent, resets_at, plan, observed_at)
      VALUES ($provider, $host, $windowId, $windowMinutes, $usedPercent, $resetsAt, $plan, $ts)
      ON CONFLICT(provider, host, window_id) DO UPDATE SET
        window_minutes = excluded.window_minutes, used_percent = excluded.used_percent,
        resets_at = excluded.resets_at, plan = excluded.plan, observed_at = excluded.observed_at
      WHERE excluded.observed_at >= plan_limits.observed_at
    `);
    this.sTool = db.prepare(`
      INSERT OR IGNORE INTO tool_calls (id, usage_id, session_id, prompt_id, provider, ts, project, user, tool,
                                        file_path, skill, agent, spawn_ref)
      VALUES ($id, $usageId, $sessionId, $promptId, $provider, $ts, $project, $user, $tool, $filePath, $skill,
              $agent, $spawnRef)
    `);
  }

  session(s: SessionRecord): void {
    this.sSession.run({
      id: s.id,
      provider: s.provider,
      nativeId: s.nativeId,
      project: this.project(s.project),
      user: this.identity.user,
      host: this.identity.host,
      title: s.title ?? null,
      gitBranch: s.gitBranch ?? null,
      client: s.client ?? null,
      clientVersion: s.clientVersion ?? null,
      parentSessionId: s.parentSessionId ?? null,
      agent: s.agent ?? null,
      startedAt: s.startedAt ?? null,
      endedAt: s.endedAt ?? null,
    });
  }

  prompt(p: PromptRecord): void {
    this.sPrompt.run({
      id: p.id,
      sessionId: p.sessionId,
      provider: p.provider,
      ts: p.ts,
      text: p.text,
      skill: p.skill,
      isCommand: p.isCommand ? 1 : 0,
    });
    this.stats.prompts++;
  }

  usage(u: UsageRecord): void {
    const total = u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite1h;
    if (total === 0) return;
    const priced = this.prices.cost(
      u.model,
      { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h },
      u.speed,
    );
    const hasReported = u.costUsd != null && Number.isFinite(u.costUsd);
    this.sUsage.run({
      id: u.id,
      provider: u.provider,
      sessionId: u.sessionId,
      promptId: u.promptId,
      ts: u.ts,
      project: this.project(u.project),
      user: u.user ?? this.identity.user,
      host: this.identity.host,
      model: u.model,
      skill: u.skill,
      agent: u.agent,
      isSubagent: u.isSubagent ? 1 : 0,
      spawnRef: u.spawnRef ?? null,
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      cacheWrite1h: u.cacheWrite1h,
      reasoning: u.reasoning,
      total,
      cost: hasReported ? u.costUsd! : priced.usd,
      estimated: hasReported ? 0 : priced.estimated ? 1 : 0,
      speed: u.speed ?? null,
      billing: u.billing ?? null,
      premiumRequests: u.premiumRequests ?? 0,
    });
    this.stats.usage++;
  }

  tool(t: ToolRecord): void {
    this.sTool.run({
      id: t.id,
      usageId: t.usageId,
      sessionId: t.sessionId,
      promptId: t.promptId,
      provider: t.provider,
      ts: t.ts,
      project: this.project(t.project),
      user: this.identity.user,
      tool: t.tool,
      filePath: t.filePath,
      skill: t.skill,
      agent: t.agent,
      spawnRef: t.spawnRef ?? null,
    });
    this.stats.tools++;
  }

  limit(l: LimitRecord): void {
    this.sLimit.run({
      provider: l.provider,
      host: this.identity.host,
      windowId: l.windowId,
      windowMinutes: l.windowMinutes,
      usedPercent: l.usedPercent,
      resetsAt: l.resetsAt,
      plan: l.plan,
      ts: l.ts,
    });
  }
}

/** Attributes subagent usage to the prompt/skill whose tool call spawned it. */
export function resolveSpawnRefs(db: Database): void {
  for (const table of ["usage", "tool_calls"]) {
    db.exec(`
      UPDATE ${table} SET
        prompt_id = (SELECT t.prompt_id FROM tool_calls t WHERE t.id = ${table}.spawn_ref),
        skill     = COALESCE(${table}.skill, (SELECT t.skill FROM tool_calls t WHERE t.id = ${table}.spawn_ref))
      WHERE spawn_ref IS NOT NULL AND prompt_id IS NULL
        AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.id = ${table}.spawn_ref)
    `);
  }
}

/** Re-prices every usage row (after pricing edits). Provider-reported costs (Cursor) are kept. */
export function recomputeCosts(db: Database, prices: PriceBook): number {
  const rows = db
    .query<
      { id: string; model: string | null; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cache_write_1h_tokens: number; speed: string | null },
      []
    >(
      `SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, speed
       FROM usage WHERE provider != 'cursor' OR cost_estimated = 1`,
    )
    .all();
  const upd = db.prepare("UPDATE usage SET cost_usd = ?, cost_estimated = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const c = prices.cost(
        r.model,
        { input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens, cacheWrite1h: r.cache_write_1h_tokens },
        r.speed,
      );
      upd.run(c.usd, c.estimated ? 1 : 0, r.id);
    }
  })();
  return rows.length;
}
