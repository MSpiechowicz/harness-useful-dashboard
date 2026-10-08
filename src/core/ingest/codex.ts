import { apiErrorOf } from "../apiErrors.ts";
import { failureOf, inputSummary } from "../failures.ts";
import { patchLines } from "./lines.ts";
import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";
import { emitGitEvents, vcsCall } from "./vcs.ts";

interface CodexState {
  threadId: string | null;
  cwd: string | null;
  /** The branch the session started on (session_meta), for a commit whose output doesn't name one. */
  branch?: string | null;
  model: string | null;
  agent: string | null;
  parentId: string | null;
  /** "records": file has per-response token_usage_record lines; "counts": only cumulative token_count events. */
  mode: "records" | "counts" | null;
  lastTotal: number;
  promptId: string | null;
  skill: string | null;
  /** Reasoning effort of the current turn. */
  effort?: string | null;
  /** Time of the last input to the model (a prompt or a tool's output), and when the last response ended. */
  inputTs?: number | null;
  responseEnd?: number | null;
  /** The file reports tool outcomes as item_completed events, so the older *_end events are not counted too. */
  itemOutcomes?: boolean;
  /** A subagent's brief was kept: later user messages come from its parent, not the brief. */
  briefSeen?: boolean;
}

/** item_completed item types that are tool calls, and how their status maps to an outcome. */
const TOOL_ITEMS = new Set(["CommandExecution", "McpToolCall", "FileChange", "CollabAgentToolCall"]);
const ITEM_OUTCOME: Record<string, "tool_ok" | "tool_error" | "tool_rejected"> = { completed: "tool_ok", failed: "tool_error", declined: "tool_rejected" };

const SKILL_PATH_RE = /[\\/]skills[\\/]([\w.:@-]+)[\\/]SKILL\.md/;
const SKILL_TAG_RE = /<skill>\s*<name>([^<]+)<\/name>/;
const TOOL_CALL_RE = /tools\.(\w+)\s*\(/g;
const PATCH_FILE_RE = /\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g;

function agentFromSource(source: unknown): { agent: string | null; parentId: string | null } {
  if (!source || typeof source !== "object") return { agent: null, parentId: null };
  const sub = (source as Record<string, any>).subagent;
  if (!sub) return { agent: null, parentId: null };
  if (typeof sub === "string") return { agent: sub, parentId: null };
  if (sub.thread_spawn) {
    const ts = sub.thread_spawn;
    const name = ts.agent_role ?? ts.agent_nickname ?? (typeof ts.agent_path === "string" ? ts.agent_path.split("/").pop() : null);
    return { agent: name ?? "subagent", parentId: ts.parent_thread_id ?? null };
  }
  if (typeof sub.other === "string") return { agent: sub.other, parentId: null };
  const key = Object.keys(sub)[0];
  return { agent: key ?? "subagent", parentId: null };
}

function userMessageText(item: Record<string, any>): { text: string | null; skill: string | null } {
  const content: any[] = Array.isArray(item.content) ? item.content : [];
  const texts: string[] = [];
  let skill: string | null = null;
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string") texts.push(c.text);
    if (c?.type === "skill" && typeof c.name === "string") skill = c.name;
  }
  return { text: texts.join("\n") || null, skill };
}

const texts = (content: unknown): string =>
  Array.isArray(content) ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n") : "";

/** A command as it was run: the shell's script rather than the shell (["bash", "-lc", "…"]), or the parsed commands. */
function commandOf(x: Record<string, any>): string | null {
  const parsed = Array.isArray(x.parsed_cmd) ? x.parsed_cmd.map((c: any) => c?.cmd).filter((c: unknown) => typeof c === "string") : [];
  if (parsed.length) return parsed.join(" && ");
  if (typeof x.command === "string") return x.command;
  return Array.isArray(x.command) && x.command.length ? String(x.command[x.command.length - 1]) : null;
}

/**
 * The tool a finished Codex call was (its results are keyed apart from its calls, so the tool is not found by id), what
 * it was given and the error it gave: a command's exit code and output, a patch's or an MCP tool's error.
 */
function codexCall(x: Record<string, any>, type: string): { tool: string | null; input: string | null; error: string } {
  const output = (o: Record<string, any>) => [o.stderr, o.aggregated_output ?? o.formatted_output ?? o.stdout].find((v) => typeof v === "string" && v.trim()) ?? "";
  if (type === "CommandExecution" || type === "exec_command_end") {
    const code = typeof x.exit_code === "number" && x.exit_code !== 0 ? `Exit code ${x.exit_code}\n` : "";
    return { tool: "exec_command", input: commandOf(x), error: code + output(x) };
  }
  if (type === "FileChange" || type === "patch_apply_end") {
    const files = x.changes && typeof x.changes === "object" ? Object.keys(x.changes) : [];
    return { tool: "apply_patch", input: files[0] ?? null, error: output(x) };
  }
  if (type === "McpToolCall" || type === "mcp_tool_call_end") {
    const inv = type === "McpToolCall" ? x : (x.invocation ?? {});
    const r = x.result ?? {};
    const err = r.Err ?? x.error;
    const error = typeof err === "string" ? err : typeof err?.message === "string" ? err.message : texts(r.content ?? r.Ok?.content);
    const tool = typeof inv.server === "string" && typeof inv.tool === "string" ? `mcp__${inv.server}__${inv.tool}` : null;
    return { tool, input: inputSummary(inv.arguments), error };
  }
  return { tool: typeof x.tool === "string" ? x.tool : null, input: null, error: typeof x.error === "string" ? x.error : "" };
}

function skillFrom(text: string): string | null {
  return SKILL_TAG_RE.exec(text)?.[1]?.trim() ?? SKILL_PATH_RE.exec(text)?.[1] ?? null;
}

export const codexParser: LineParser<CodexState> = {
  initialState() {
    return {
      threadId: null, cwd: null, model: null, agent: null, parentId: null,
      mode: null, lastTotal: -1, promptId: null, skill: null,
    };
  },

  parse(lines, ctx: FileContext, state, sink: IngestSink) {
    const sessions = new SessionAccumulator();
    if (state.mode === null && lines.some((l) => l.text.includes('"token_usage_record"'))) state.mode = "records";

    for (const { text, offset } of lines) {
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(text);
      } catch {
        continue;
      }
      const p = rec.payload ?? {};
      const ts = parseTs(rec.timestamp);

      if (rec.type === "session_meta") {
        // Spawned subagent rollouts embed the parent's session_meta after their own; the first one owns the file.
        if (state.threadId) continue;
        state.threadId = p.id ?? p.session_id ?? null;
        state.cwd = p.cwd ?? state.cwd;
        state.branch = typeof p.git?.branch === "string" ? p.git.branch : null;
        const sub = agentFromSource(p.source);
        state.agent = sub.agent;
        state.parentId = sub.parentId ?? (sub.agent ? p.parent_thread_id ?? null : null);
        if (state.threadId) {
          sessions.touch(
            {
              id: `codex:${state.threadId}`,
              provider: "codex",
              nativeId: state.threadId,
              project: state.cwd,
              gitBranch: p.git?.branch ?? null,
              client: p.originator ?? (typeof p.source === "string" ? p.source : null),
              clientVersion: p.cli_version ?? null,
              parentSessionId: state.parentId ? `codex:${state.parentId}` : null,
              agent: state.agent,
            },
            parseTs(p.timestamp) ?? ts,
          );
        }
        continue;
      }
      if (!state.threadId) continue;
      const sessionId = `codex:${state.threadId}`;
      const isSub = state.agent !== null;
      const agent = state.agent ?? "main";
      if (ts != null) sessions.touch({ id: sessionId, provider: "codex", nativeId: state.threadId }, ts);

      if (rec.type === "turn_context") {
        if (p.model) state.model = p.model;
        const effort = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort;
        if (typeof effort === "string") state.effort = effort;
        if (p.cwd) state.cwd = p.cwd;
        continue;
      }

      if (rec.type === "token_usage_record") {
        state.mode = "records";
        const u = p.usage ?? {};
        const cached = num(u.cached_input_tokens);
        const usageId = `codex:${state.threadId}:${p.response_id ?? rec.ordinal ?? offset}`;
        // Written as the response ends. It started with the last input, or when the response before it ended.
        sink.responseMeta?.({
          usageId,
          startTs: Math.max(state.inputTs ?? 0, state.responseEnd ?? 0) || null,
          endTs: ts,
          effort: state.effort ?? null,
        });
        if (ts != null) state.responseEnd = ts;
        sink.usage({
          id: usageId,
          provider: "codex",
          sessionId,
          promptId: state.promptId,
          ts: ts ?? Date.now(),
          project: state.cwd,
          model: state.model,
          skill: state.skill,
          agent,
          isSubagent: isSub,
          input: Math.max(0, num(u.input_tokens) - cached),
          output: num(u.output_tokens),
          cacheRead: cached,
          cacheWrite: num(u.cache_write_input_tokens),
          cacheWrite1h: 0,
          reasoning: num(u.reasoning_output_tokens),
        });
        continue;
      }

      if (rec.type === "event_msg") {
        if (p.type === "token_count") {
          // The plan's rate limits ride along with every token count, also in files billed per record.
          if (p.rate_limits && ts != null) {
            for (const windowId of ["primary", "secondary"] as const) {
              const w = p.rate_limits[windowId];
              if (!w || typeof w.used_percent !== "number") continue;
              const resetsAt =
                typeof w.resets_at === "number" ? w.resets_at * 1000 : typeof w.resets_in_seconds === "number" ? ts + w.resets_in_seconds * 1000 : null;
              sink.limit?.({
                provider: "codex",
                windowId,
                windowMinutes: typeof w.window_minutes === "number" ? w.window_minutes : null,
                usedPercent: w.used_percent,
                resetsAt,
                plan: typeof p.rate_limits.plan_type === "string" ? p.rate_limits.plan_type : null,
                ts,
              });
            }
          }
          if (state.mode === "records" || !p.info) continue;
          state.mode = "counts";
          const total = num(p.info.total_token_usage?.total_tokens);
          if (total === state.lastTotal) continue; // repeated snapshot, nothing new billed
          state.lastTotal = total;
          const u = p.info.last_token_usage ?? {};
          const cached = num(u.cached_input_tokens);
          const usageId = `codex:${state.threadId}:${rec.ordinal ?? `o${offset}`}`;
          // Counts are logged after the tools ran, so there is no response time here.
          sink.responseMeta?.({ usageId, startTs: null, endTs: null, effort: state.effort ?? null });
          sink.usage({
            id: usageId,
            provider: "codex",
            sessionId,
            promptId: state.promptId,
            ts: ts ?? Date.now(),
            project: state.cwd,
            model: state.model,
            skill: state.skill,
            agent,
            isSubagent: isSub,
            input: Math.max(0, num(u.input_tokens) - cached),
            output: num(u.output_tokens),
            cacheRead: cached,
            cacheWrite: num(u.cache_write_input_tokens),
            cacheWrite1h: 0,
            reasoning: num(u.reasoning_output_tokens),
          });
          continue;
        }

        const outcome = { provider: "codex" as const, sessionId, ts: ts ?? Date.now(), project: state.cwd, model: state.model, agent, effort: state.effort ?? null };
        // A shell command that worked and commits or opens a PR: what its output says came of it.
        const shellGit = (x: Record<string, any>, callId: string) => {
          const vcs = vcsCall(x.command ?? commandOf(x), ctx.promptTextLimit);
          if (!vcs) return;
          const output = [x.aggregated_output, x.stdout, x.formatted_output].find((v) => typeof v === "string" && v);
          const call = { provider: "codex" as const, sessionId, ts: outcome.ts, project: state.cwd, agent, branch: state.branch ?? null, callId: `${sessionId}:${callId}` };
          emitGitEvents(sink, vcs, output, call, ctx.promptTextLimit);
        };

        if (p.type === "item_completed" && TOOL_ITEMS.has(p.item?.type)) {
          state.itemOutcomes = true;
          const kind = ITEM_OUTCOME[p.item.status];
          if (kind) {
            const call = codexCall(p.item, p.item.type);
            sink.outcome?.({
              ...outcome,
              id: `codex:${state.threadId}:${p.item.id ?? `o${offset}`}`,
              kind,
              tool: call.tool,
              ...failureOf(kind, call.tool, call.error, call.input, ctx.promptTextLimit),
            });
          }
          const exitCode = p.item.exit_code;
          if (kind === "tool_ok" && p.item.type === "CommandExecution" && (exitCode == null || exitCode === 0)) {
            shellGit(p.item, p.item.id ?? `o${offset}`);
          }
          continue;
        }
        if ((p.type === "exec_command_end" || p.type === "patch_apply_end" || p.type === "mcp_tool_call_end") && !state.itemOutcomes) {
          const failed = p.type === "exec_command_end" ? num(p.exit_code) !== 0 : p.type === "patch_apply_end" ? p.success === false : !!p.result?.Err;
          const kind = failed ? "tool_error" : "tool_ok";
          const call = codexCall(p, p.type);
          // A patch that didn't apply changed nothing: its call's lines are dropped.
          if (failed && p.type === "patch_apply_end" && p.call_id) sink.editLines?.({ toolId: `codex:${state.threadId}:${p.call_id}:0`, added: null, removed: null });
          sink.outcome?.({
            ...outcome,
            id: `codex:${state.threadId}:${p.call_id ?? `o${offset}`}:end`,
            kind,
            tool: call.tool,
            ...failureOf(kind, call.tool, call.error, call.input, ctx.promptTextLimit),
          });
          if (!failed && p.type === "exec_command_end") shellGit(p, p.call_id ?? `o${offset}`);
          continue;
        }
        // A failed model request: "error" ends the turn, "stream_error" is an attempt Codex retries ("Reconnecting… 2/5").
        // Newer versions name the cause (codex_error_info: "usage_limit_exceeded", { http_connection_failed: { http_status_code } }).
        if ((p.type === "error" || p.type === "stream_error") && ts != null) {
          const info = p.codex_error_info;
          const code = typeof info === "string" ? info : info && typeof info === "object" ? (Object.keys(info)[0] ?? null) : null;
          const inner = code && info && typeof info === "object" ? info[code] : null;
          const status = typeof inner?.http_status_code === "number" ? inner.http_status_code : null;
          const message = [p.message, p.additional_details].filter((v) => typeof v === "string" && v.trim()).join(": ") || null;
          sink.outcome?.({ ...outcome, id: `codex:${state.threadId}:${rec.ordinal ?? `o${offset}`}:api`, ...apiErrorOf(code, status, message, ctx.promptTextLimit) });
          continue;
        }
        if (p.type === "turn_aborted") {
          if (p.reason === "interrupted") sink.outcome?.({ ...outcome, id: `${sessionId}:${p.turn_id ?? `o${offset}`}:interrupt`, kind: "interrupt" });
          continue;
        }

        let promptText: string | null = null;
        let promptSkill: string | null = null;
        let promptKey: string | null = null;
        if (p.type === "item_completed" && p.item?.type === "UserMessage") {
          const r = userMessageText(p.item);
          promptText = r.text;
          promptSkill = r.skill;
          promptKey = p.item.id ?? p.turn_id ?? null;
        } else if (p.type === "user_message" && typeof p.message === "string") {
          promptText = p.message;
          promptKey = rec.ordinal != null ? String(rec.ordinal) : `o${offset}`;
        }
        if (promptKey && ts != null) state.inputTs = ts;
        // A spawned thread's first user message is its brief from the parent: kept with the session, never a prompt.
        if (promptKey && isSub && !state.briefSeen && promptText?.trim()) {
          sessions.touch({ id: sessionId, provider: "codex", nativeId: state.threadId, brief: truncate(promptText, ctx.promptTextLimit) }, ts);
          state.briefSeen = true;
        }
        if (promptKey && ts != null && !isSub) {
          const skill = promptSkill ?? (promptText ? skillFrom(promptText) : null);
          const promptId = `${sessionId}:${promptKey}`;
          state.promptId = promptId;
          state.skill = skill;
          sink.prompt({
            id: promptId,
            sessionId,
            provider: "codex",
            ts,
            text: truncate(promptText, ctx.promptTextLimit),
            skill,
            isCommand: /^\s*[/$][\w-]+/.test(promptText ?? ""),
          });
        }
        continue;
      }

      if (rec.type === "response_item") {
        if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
          if (ts != null) state.inputTs = ts;
          continue;
        }
        if (p.type === "message" && p.role === "user" && !state.skill) {
          // Skill bodies are injected as user messages in some Codex versions.
          const body = Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? "").join("\n") : "";
          const s = body.includes("<skill>") ? skillFrom(body) : null;
          if (s) state.skill = s;
          continue;
        }
        if (p.type !== "function_call" && p.type !== "custom_tool_call" && p.type !== "local_shell_call") continue;
        const args: string = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.action ?? "");
        const callId = p.call_id ?? p.id ?? `o${offset}`;
        const s = skillFrom(args);
        if (s) state.skill = s;

        // Code-mode "exec" calls wrap real tool invocations in JS; surface those instead.
        const inner = p.name === "exec" ? [...args.matchAll(TOOL_CALL_RE)].map((m) => m[1]!) : [];
        const toolNames = inner.length ? inner : [p.name ?? p.type];
        const files = [...args.matchAll(PATCH_FILE_RE)].map((m) => m[1]!.trim());
        // The lines of every patch in the call go on its first apply_patch row (the command that ran one, else).
        const lines = patchLines(args);
        const linesAt = Math.max(0, toolNames.indexOf("apply_patch"));
        toolNames.forEach((tool, i) => {
          sink.tool({
            id: `codex:${state.threadId}:${callId}:${i}`,
            usageId: null,
            sessionId,
            promptId: state.promptId,
            provider: "codex",
            ts: ts ?? Date.now(),
            project: state.cwd,
            tool,
            filePath: tool === "apply_patch" && files.length ? files[0]! : null,
            skill: state.skill,
            agent,
            model: state.model,
            linesAdded: i === linesAt ? (lines?.added ?? null) : null,
            linesRemoved: i === linesAt ? (lines?.removed ?? null) : null,
          });
        });
        files.slice(1).forEach((f, i) =>
          sink.tool({
            id: `codex:${state.threadId}:${callId}:f${i}`,
            usageId: null,
            sessionId,
            promptId: state.promptId,
            provider: "codex",
            ts: ts ?? Date.now(),
            project: state.cwd,
            tool: "apply_patch",
            filePath: f,
            skill: state.skill,
            agent,
            model: state.model,
            // An edit of its own, its lines counted on the call's first row.
            linesAdded: lines ? 0 : null,
            linesRemoved: lines ? 0 : null,
          }),
        );
      }
    }
    sessions.flush(sink);
    return state;
  },
};
