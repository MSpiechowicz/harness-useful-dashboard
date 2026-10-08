import type { Database, Statement } from "bun:sqlite";
import type { PriceBook } from "../pricing.ts";
import { readingParams, readingStatement } from "../plans.ts";
import { projectResolver } from "../project.ts";
import type { EditLinesRecord, IngestSink, LimitRecord, OutcomeRecord, PromptRecord, ResponseMetaRecord, SessionRecord, ToolRecord, UsageRecord } from "./types.ts";

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
  private sMeta: Statement;
  private sOutcome: Statement;
  private sOutcomeTool: Statement;
  private sLines: Statement;
  private sFailedLines: Statement;
  private sReading: Statement;

  constructor(
    db: Database,
    private prices: PriceBook,
    private identity: { user: string; host: string },
    /**
     * Detail older than this (epoch ms) is not stored: the text, paths and response times that retention trims. A full
     * rescan would otherwise bring them back each time, only for the next trim to take them out again.
     */
    private detailBefore = 0,
  ) {
    this.sSession = db.prepare(`
      INSERT INTO sessions (id, provider, native_id, project, user, host, title, git_branch, client, client_version,
                            parent_session_id, agent, brief, started_at, ended_at)
      VALUES ($id, $provider, $nativeId, $project, $user, $host, $title, $gitBranch, $client, $clientVersion,
              $parentSessionId, $agent, $brief, $startedAt, $endedAt)
      ON CONFLICT(id) DO UPDATE SET
        project           = COALESCE(sessions.project, excluded.project),
        title             = COALESCE(excluded.title, sessions.title),
        git_branch        = COALESCE(sessions.git_branch, excluded.git_branch),
        client            = COALESCE(sessions.client, excluded.client),
        client_version    = COALESCE(excluded.client_version, sessions.client_version),
        parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id),
        agent             = COALESCE(sessions.agent, excluded.agent),
        brief             = COALESCE(sessions.brief, excluded.brief),
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
        speed                 = COALESCE(usage.speed, excluded.speed),
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
    // An edit's lines: none once it is known to have failed, and the exact count from its result (sLines) is kept when
    // the call is read again. A further file's row ("<call>:f1") goes by its call's outcome. The model is the one
    // named, else its usage row's.
    const failed = "EXISTS (SELECT 1 FROM outcomes o WHERE o.id IN ($id, $callId) AND o.kind IN ('tool_error', 'tool_rejected'))";
    this.sTool = db.prepare(`
      INSERT INTO tool_calls (id, usage_id, session_id, prompt_id, provider, ts, project, user, tool,
                              file_path, skill, agent, spawn_ref, brief, model, lines_added, lines_removed)
      VALUES ($id, $usageId, $sessionId, $promptId, $provider, $ts, $project, $user, $tool, $filePath, $skill,
              $agent, $spawnRef, $brief, COALESCE($model, (SELECT u.model FROM usage u WHERE u.id = $usageId)),
              CASE WHEN ${failed} THEN NULL ELSE $linesAdded END, CASE WHEN ${failed} THEN NULL ELSE $linesRemoved END)
      ON CONFLICT(id) DO UPDATE SET
        skill         = COALESCE(tool_calls.skill, excluded.skill),
        prompt_id     = COALESCE(tool_calls.prompt_id, excluded.prompt_id),
        brief         = COALESCE(tool_calls.brief, excluded.brief),
        model         = COALESCE(tool_calls.model, excluded.model),
        lines_added   = CASE WHEN ${failed} THEN NULL ELSE COALESCE(tool_calls.lines_added, excluded.lines_added) END,
        lines_removed = CASE WHEN ${failed} THEN NULL ELSE COALESCE(tool_calls.lines_removed, excluded.lines_removed) END
      WHERE excluded.brief IS NOT NULL OR excluded.model IS NOT NULL OR excluded.lines_added IS NOT NULL
         OR excluded.skill IS NOT NULL OR excluded.prompt_id IS NOT NULL
    `);
    // Only an edit's count is replaced (it has one from its input): a result's diff never makes another call an edit.
    this.sLines = db.prepare(`UPDATE tool_calls SET lines_added = $added, lines_removed = $removed WHERE id = $id AND lines_added IS NOT NULL`);
    this.sFailedLines = db.prepare(`
      UPDATE tool_calls SET lines_added = NULL, lines_removed = NULL
      WHERE (id = $id OR (id > $id || ':f' AND id < $id || ':g')) AND lines_added IS NOT NULL
    `);
    this.sMeta = db.prepare(`
      INSERT INTO response_meta (usage_id, start_ts, end_ts, ttft_ms, effort, stop_reason)
      VALUES ($usageId, $startTs, $endTs, $ttftMs, $effort, $stopReason)
      ON CONFLICT(usage_id) DO UPDATE SET
        start_ts    = MIN(COALESCE(response_meta.start_ts, excluded.start_ts), COALESCE(excluded.start_ts, response_meta.start_ts)),
        end_ts      = MAX(COALESCE(response_meta.end_ts, excluded.end_ts), COALESCE(excluded.end_ts, response_meta.end_ts)),
        ttft_ms     = COALESCE(response_meta.ttft_ms, excluded.ttft_ms),
        effort      = COALESCE(response_meta.effort, excluded.effort),
        stop_reason = COALESCE(excluded.stop_reason, response_meta.stop_reason)
    `);
    this.sReading = readingStatement(db);
    // An outcome carries the tool of the call it ended, whichever of the two is written first.
    this.sOutcome = db.prepare(`
      INSERT INTO outcomes (id, provider, session_id, ts, project, user, host, model, agent, effort, kind, tool, reason,
                            detail, input, status)
      VALUES ($id, $provider, $sessionId, $ts, $project, $user, $host, $model, $agent, $effort, $kind,
              COALESCE((SELECT t.tool FROM tool_calls t WHERE t.id = $id), $tool), $reason, $detail, $input, $status)
      ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, model = COALESCE(outcomes.model, excluded.model),
        tool = COALESCE(outcomes.tool, excluded.tool), reason = excluded.reason,
        detail = COALESCE(excluded.detail, outcomes.detail), input = COALESCE(excluded.input, outcomes.input),
        status = COALESCE(excluded.status, outcomes.status)
    `);
    this.sOutcomeTool = db.prepare("UPDATE outcomes SET tool = $tool WHERE id = $id AND tool IS NULL");
  }

  session(s: SessionRecord): void {
    this.sSession.run({
      id: s.id,
      provider: s.provider,
      nativeId: s.nativeId,
      project: this.project(s.project),
      user: this.identity.user,
      host: this.identity.host,
      brief: this.isOld(s.endedAt ?? s.startedAt) ? null : (s.brief ?? null),
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
      filePath: this.isOld(t.ts) ? null : t.filePath,
      skill: t.skill,
      agent: t.agent,
      spawnRef: t.spawnRef ?? null,
      brief: this.isOld(t.ts) ? null : (t.brief ?? null),
      callId: t.id.replace(/:f\d+$/, ""),
      model: t.model ?? null,
      // Counts, not detail: kept however old the call is.
      linesAdded: t.linesAdded ?? null,
      linesRemoved: t.linesAdded != null ? (t.linesRemoved ?? 0) : null,
    });
    this.sOutcomeTool.run({ id: t.id, tool: t.tool });
    this.stats.tools++;
  }

  responseMeta(m: ResponseMetaRecord): void {
    if (this.isOld(m.endTs ?? m.startTs)) return;
    this.sMeta.run({
      usageId: m.usageId,
      startTs: m.startTs,
      endTs: m.endTs,
      ttftMs: m.ttftMs ?? null,
      effort: m.effort ?? null,
      stopReason: m.stopReason ?? null,
    });
  }

  outcome(o: OutcomeRecord): void {
    this.sOutcome.run({
      id: o.id,
      provider: o.provider,
      sessionId: o.sessionId,
      ts: o.ts,
      project: this.project(o.project),
      user: this.identity.user,
      host: this.identity.host,
      model: o.model,
      agent: o.agent,
      effort: o.effort ?? null,
      kind: o.kind,
      tool: o.tool ?? null,
      reason: o.reason ?? null,
      detail: this.isOld(o.ts) ? null : (o.detail ?? null),
      input: this.isOld(o.ts) ? null : (o.input ?? null),
      status: o.status ?? null,
    });
    // A failed edit changed nothing.
    if (o.kind === "tool_error" || o.kind === "tool_rejected") this.sFailedLines.run({ id: o.id });
  }

  editLines(e: EditLinesRecord): void {
    if (e.added == null) this.sFailedLines.run({ id: e.toolId });
    else this.sLines.run({ id: e.toolId, added: e.added, removed: e.removed ?? 0 });
  }

  /** Whether a record is older than the detail kept. */
  private isOld(ts: number | null | undefined): boolean {
    return ts != null && ts < this.detailBefore;
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
    this.sReading.run(
      readingParams(this.identity.host, {
        reportKey: `${l.provider}:logs`,
        provider: l.provider,
        plan: l.plan,
        windowId: l.windowId,
        windowMs: l.windowMinutes != null ? l.windowMinutes * 60_000 : null,
        usedFraction: l.usedPercent / 100,
        resetsAt: l.resetsAt,
        observedAt: l.ts,
      }),
    );
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

/**
 * Re-prices every usage row (after pricing edits). Provider-reported costs (Cursor, Cline, Roo Code, Kilo Code) are kept.
 * Cost is linear in the token counts, so each model (and fast mode) is one UPDATE with its rates: the same sum in the
 * same order as PriceBook.cost, rather than every row read into JS and written back one by one.
 */
export function recomputeCosts(db: Database, prices: PriceBook): number {
  const repriced = "(provider NOT IN ('cursor', 'cline', 'roo', 'kilo') OR cost_estimated = 1)";
  const models = db.query<{ model: string | null }, []>(`SELECT DISTINCT model FROM usage WHERE ${repriced}`).all();
  const upd = db.prepare(
    `UPDATE usage SET cost_usd = (input_tokens * ? + output_tokens * ? + cache_read_tokens * ? + cache_write_tokens * ? + cache_write_1h_tokens * ?) / 1000000.0 * ?,
                      cost_estimated = ?
     WHERE model IS ? AND (speed IS 'fast') = ? AND ${repriced}`,
  );
  let updated = 0;
  db.transaction(() => {
    for (const { model } of models) {
      const r = prices.rates(model);
      const rates = [r.input, r.output, r.cacheRead, r.cacheWrite, r.cacheWrite1h];
      for (const fast of [0, 1]) updated += upd.run(...rates, fast ? 2 : 1, r.estimated ? 1 : 0, model, fast).changes;
    }
  })();
  return updated;
}
