import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";

interface CodexState {
  threadId: string | null;
  cwd: string | null;
  model: string | null;
  agent: string | null;
  parentId: string | null;
  /** "records": file has per-response token_usage_record lines; "counts": only cumulative token_count events. */
  mode: "records" | "counts" | null;
  lastTotal: number;
  promptId: string | null;
  skill: string | null;
}

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
        if (p.cwd) state.cwd = p.cwd;
        continue;
      }

      if (rec.type === "token_usage_record") {
        state.mode = "records";
        const u = p.usage ?? {};
        const cached = num(u.cached_input_tokens);
        sink.usage({
          id: `codex:${state.threadId}:${p.response_id ?? rec.ordinal ?? offset}`,
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
          sink.usage({
            id: `codex:${state.threadId}:${rec.ordinal ?? `o${offset}`}`,
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
          }),
        );
      }
    }
    sessions.flush(sink);
    return state;
  },
};
