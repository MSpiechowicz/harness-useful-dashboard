import type { Database, Statement } from "bun:sqlite";
import type { PriceBook } from "../pricing.ts";
import { withoutSnapshotDate } from "../models.ts";
import { readingParams, readingStatement } from "../plans.ts";
import { projectResolver } from "../project.ts";
import { localDayStart, rollupCutoff } from "../rollup.ts";
import type {
  CompactionRecord,
  EditLinesRecord,
  GitEventRecord,
  IngestSink,
  LimitRecord,
  OutcomeRecord,
  PromptRecord,
  ResponseMetaRecord,
  SessionRecord,
  ToolRecord,
  UsageRecord,
} from "./types.ts";

export interface WriterStats {
  usage: number;
  prompts: number;
  tools: number;
}

/** The longest branch name a commit or pull request keeps, whatever source read it. */
const MAX_BRANCH = 200;

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
  private sRolledDay: Statement;
  private sHasCalls: Statement;
  private sSupersede: Statement;
  private sGitEvent: Statement;
  private sDropGitEvent: Statement;
  private sCompaction: Statement;
  private sDropPrompt: Statement;
  private sMoveUsage: Statement;
  private sMoveTools: Statement;

  constructor(
    db: Database,
    private prices: PriceBook,
    private identity: { user: string; host: string },
    /**
     * Detail older than this (epoch ms) is not stored: the text, paths and response times that retention trims. A full
     * rescan would otherwise bring them back each time, only for the next trim to take them out again.
     */
    private detailBefore = 0,
    /**
     * Successful tool calls older than this (epoch ms) may be rolled up into daily counts already (rollup.ts): a rescan
     * must not write them again next to their count.
     */
    private rollupBefore = rollupCutoff(),
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
    this.sRolledDay = db.prepare("SELECT 1 FROM outcome_days WHERE session_id = $sessionId AND ts = $day AND host = $host LIMIT 1");

    // A session's own calls from Copilot's session store are keyed "<session>:u:…", its shutdown totals "…|…". The
    // totals give up their tokens only once there are calls to carry them.
    const hasCalls = "SELECT 1 FROM usage WHERE id > $sessionId || ':u:' AND id < $sessionId || ':u;' LIMIT 1";
    this.sHasCalls = db.prepare(hasCalls);
    this.sSupersede = db.prepare(`
      UPDATE usage SET input_tokens = 0, output_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0,
                       cache_write_1h_tokens = 0, reasoning_tokens = 0, total_tokens = 0, cost_usd = 0
      WHERE session_id = $sessionId AND provider = 'copilot' AND instr(id, '|') > 0 AND total_tokens > 0
        AND EXISTS (${hasCalls})
    `);

    // The same commit or PR seen again (a rescan, another session that pushed it) keeps the first sighting.
    const first = (col: string) => `CASE WHEN excluded.ts < git_events.ts THEN excluded.${col} ELSE git_events.${col} END`;
    this.sGitEvent = db.prepare(`
      INSERT INTO git_events (id, kind, provider, session_id, ts, project, user, host, agent, branch, sha, subject, repo,
                              number, url)
      VALUES ($id, $kind, $provider, $sessionId, $ts, $project, $user, $host, $agent, $branch, $sha, $subject, $repo,
              $number, $url)
      ON CONFLICT(id) DO UPDATE SET
        provider   = ${first("provider")},
        session_id = ${first("session_id")},
        agent      = ${first("agent")},
        ts         = MIN(git_events.ts, excluded.ts),
        project    = COALESCE(git_events.project, excluded.project),
        user       = COALESCE(git_events.user, excluded.user),
        branch     = COALESCE(git_events.branch, excluded.branch),
        sha        = COALESCE(git_events.sha, excluded.sha),
        subject    = COALESCE(git_events.subject, excluded.subject),
        repo       = COALESCE(git_events.repo, excluded.repo),
        number     = COALESCE(git_events.number, excluded.number),
        url        = COALESCE(git_events.url, excluded.url)
    `);

    this.sDropGitEvent = db.prepare("DELETE FROM git_events WHERE id = $id");

    // A reported cost is never replaced by an estimate.
    this.sCompaction = db.prepare(`
      INSERT INTO compactions (id, provider, session_id, ts, project, user, host, model, agent, trigger, pre_tokens,
                               post_tokens, duration_ms, cost_usd, estimated)
      VALUES ($id, $provider, $sessionId, $ts, $project, $user, $host, $model, $agent, $trigger, $preTokens,
              $postTokens, $durationMs, $cost, $estimated)
      ON CONFLICT(id) DO UPDATE SET
        model       = COALESCE(compactions.model, excluded.model),
        trigger     = COALESCE(excluded.trigger, compactions.trigger),
        pre_tokens  = COALESCE(excluded.pre_tokens, compactions.pre_tokens),
        post_tokens = COALESCE(excluded.post_tokens, compactions.post_tokens),
        duration_ms = COALESCE(excluded.duration_ms, compactions.duration_ms),
        cost_usd    = CASE WHEN compactions.estimated = 0 AND excluded.estimated = 1 THEN compactions.cost_usd ELSE excluded.cost_usd END,
        estimated   = MIN(compactions.estimated, excluded.estimated)
    `);

    this.sDropPrompt = db.prepare("DELETE FROM prompts WHERE id = $id");
    this.sMoveUsage = db.prepare("UPDATE usage SET prompt_id = $previous WHERE prompt_id = $id");
    this.sMoveTools = db.prepare("UPDATE tool_calls SET prompt_id = $previous WHERE prompt_id = $id");
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
    // Totals of a session whose calls were read one by one keep only their premium requests: the calls carry the tokens.
    const superseded = u.rollup === true && this.sHasCalls.get({ sessionId: u.sessionId }) != null;
    if (superseded) u = { ...u, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: 0 };

    const total = u.input + u.output + u.cacheRead + u.cacheWrite + u.cacheWrite1h;
    if (total === 0 && !superseded) return;

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
      model: withoutSnapshotDate(u.model),
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
    // The upsert keeps the larger counts of a row written before the session's calls came in.
    if (superseded) this.supersedeRollups(u.sessionId);
    this.stats.usage++;
  }

  supersedeRollups(sessionId: string): void {
    this.sSupersede.run({ sessionId });
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
      model: withoutSnapshotDate(t.model ?? null),
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
    // A successful call of a session-day already counted in outcome_days (rollup.ts) is in that count.
    if (o.kind === "tool_ok" && o.ts < this.rollupBefore) {
      const rolled = this.sRolledDay.get({ sessionId: o.sessionId, day: localDayStart(o.ts), host: this.identity.host });
      if (rolled) return;
    }

    this.sOutcome.run({
      id: o.id,
      provider: o.provider,
      sessionId: o.sessionId,
      ts: o.ts,
      project: this.project(o.project),
      user: this.identity.user,
      host: this.identity.host,
      model: withoutSnapshotDate(o.model),
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

  /**
   * A commit keyed by its project and sha, a PR by its repository and number, else either by the call that made it.
   * One known by neither is dropped. The subject is detail, kept only when newer than the detail cutoff.
   */
  gitEvent(e: GitEventRecord): void {
    const project = this.project(e.project);
    let id: string | null;
    if (e.kind === "commit") id = e.sha ? `commit:${project ?? ""}:${e.sha}` : e.callId ? `commit:${e.callId}` : null;
    else id = e.repo && e.number != null ? `pr:${e.repo.toLowerCase()}#${e.number}` : e.callId ? `pr:${e.callId}` : null;
    if (!id) return;

    // A commit read before without its sha (keyed by its call) is this one: one row, under its sha.
    if (e.kind === "commit" && e.sha && e.callId) this.sDropGitEvent.run({ id: `commit:${e.callId}` });

    this.sGitEvent.run({
      id,
      kind: e.kind,
      provider: e.provider,
      sessionId: e.sessionId,
      ts: e.ts,
      project,
      user: this.identity.user,
      host: this.identity.host,
      agent: e.agent,
      branch: e.branch?.slice(0, MAX_BRANCH) ?? null,
      sha: e.sha ?? null,
      subject: this.isOld(e.ts) ? null : (e.subject ?? null),
      repo: e.repo ?? null,
      number: e.number ?? null,
      url: e.url ?? null,
    });
  }

  /**
   * A compaction's cost, unless the harness reports one, is an estimate: the context read once at the cache-read rate
   * and the summary written at the output rate, at the model's prices. recomputeCosts re-prices it.
   */
  compaction(c: CompactionRecord): void {
    const reported = c.costUsd != null && Number.isFinite(c.costUsd);
    const r = this.prices.rates(c.model);
    const estimate = ((c.preTokens ?? 0) * r.cacheRead + (c.postTokens ?? 0) * r.output) / 1_000_000;

    this.sCompaction.run({
      id: c.id,
      provider: c.provider,
      sessionId: c.sessionId,
      ts: c.ts,
      project: this.project(c.project),
      user: this.identity.user,
      host: this.identity.host,
      model: withoutSnapshotDate(c.model),
      agent: c.agent,
      trigger: c.trigger,
      preTokens: c.preTokens,
      postTokens: c.postTokens,
      durationMs: c.durationMs,
      cost: reported ? c.costUsd! : estimate,
      estimated: reported ? 0 : 1,
    });
  }

  /**
   * A record stored as a prompt that is none: it goes, and the usage and tool calls it had move to `previous`. A prompt
   * named as its own previous one stays as it is: dropping it would leave its usage pointing at nothing.
   */
  notPrompt(id: string, previous: string | null): void {
    if (id === previous) return;

    this.sDropPrompt.run({ id });
    this.sMoveUsage.run({ id, previous });
    this.sMoveTools.run({ id, previous });
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
 * Re-prices every usage row (after pricing edits), and the estimated compaction costs. Provider-reported costs (Cursor,
 * Cline, Roo Code, Kilo Code) are kept.
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
  const compactionModels = db.query<{ model: string | null }, []>("SELECT DISTINCT model FROM compactions WHERE estimated = 1").all();
  const updCompaction = db.prepare(
    "UPDATE compactions SET cost_usd = (COALESCE(pre_tokens, 0) * ? + COALESCE(post_tokens, 0) * ?) / 1000000.0 WHERE model IS ? AND estimated = 1",
  );
  let updated = 0;
  db.transaction(() => {
    for (const { model } of models) {
      const r = prices.rates(model);
      const rates = [r.input, r.output, r.cacheRead, r.cacheWrite, r.cacheWrite1h];
      for (const fast of [0, 1]) updated += upd.run(...rates, fast ? 2 : 1, r.estimated ? 1 : 0, model, fast).changes;
    }

    // Estimated compaction costs (CompactionRecord), the same sum as DbWriter.compaction. Not counted in what is returned.
    for (const { model } of compactionModels) {
      const r = prices.rates(model);
      updCompaction.run(r.cacheRead, r.output, model);
    }
  })();
  return updated;
}
