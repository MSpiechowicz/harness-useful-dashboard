import { apiErrorOf } from "../apiErrors.ts";
import { failureOf, inputSummary, type PendingCalls, rememberCall, takeCall } from "../failures.ts";
import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";

/**
 * pi and omp (oh-my-pi, a fork of pi) write the same session format:
 * ~/.pi/agent/sessions/<project>/<started>_<uuid>.jsonl (omp: ~/.omp/agent/sessions/…), one JSON entry per line
 * (session header, messages, model changes, …). An omp subagent's transcript sits in a folder named after its
 * parent's file, `<started>_<uuid>/<AgentName>.jsonl`, and its header points back with `parentSession`.
 * Every assistant message carries its own usage, model, and the provider it was billed through
 * ("openai-codex", "github-copilot", "anthropic", …), which becomes the usage row's billing.
 *
 * pi's /fork and /clone start a new file that copies the earlier entries with their ids and times, so pi's records are
 * keyed by entry id and time rather than by session: a forked history counts once. pi also logs usage outside messages
 * (cache warming, compactions, branch summaries), which counts too.
 */
type PiHarness = "omp" | "pi";

interface OmpState {
  sessionId: string | null;
  cwd: string | null;
  /** Subagent name (the file's name), null in a main session. */
  agent: string | null;
  parentId: string | null;
  /** Model of the last model_change, for messages that don't name one. */
  model: string | null;
  /** What the last assistant message was billed through, for pi's usage logged outside messages. */
  billing?: string | null;
  promptId: string | null;
  skill: string | null;
  /** Thinking level of the last thinking_level_change. */
  effort?: string | null;
  /** Model of the last answer, which the tool results that follow belong to. */
  answeredBy?: string | null;
  /** A subagent's brief was kept: later "user" turns are messages from the parent, not the brief. */
  briefSeen?: boolean;
  /** Tool calls waiting for their results: what a failed one was given. */
  calls?: PendingCalls;
}

/** Failed tool results that only say the user or the harness stopped the call, not that it went wrong. */
const STOPPED_RE = /^Skipped due to|^The user (rejected|denied|doesn't want)|^Tool (call|execution) (was )?(aborted|cancelled|rejected)/i;

const SESSION_FILE_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_FILE_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]([^\\/]+)\.jsonl$/i;
/** Tools whose `path` argument is the file they work on (pi's edit too, omp's takes a patch). */
const FILE_TOOLS = new Set(["read", "write", "edit"]);
/** `edit` takes a patch that names each file it touches on a "[path#hash]" line. */
const PATCH_FILE_RE = /^\[([^\]#\n]+)(?:#[^\]\n]*)?\]$/gm;
const SKILL_URI_RE = /^skill:\/\/([\w.:@-]+)/;
const URI_RE = /^[a-z][\w+.-]*:\/\//i;

/**
 * The files a read or write names. omp's `path` can also be one of its own resources (agent://, artifact://,
 * https://, …), a directory, several files joined by ";", or carry a line range ("src/lib.rs:50-115").
 */
function filePaths(raw: string): string[] {
  return raw
    .split(";")
    .map((p) => p.trim().replace(/^file:\/\//i, ""))
    .filter((p) => p && !URI_RE.test(p))
    .map((p) => p.replace(/:\d+(-\d*)?$/, ""))
    .filter((p) => p !== "." && p !== ".." && !p.endsWith("/"));
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string);
  return parts.length ? parts.join("\n") : null;
}

function piFamilyParser(harness: PiHarness): LineParser<OmpState> {
  return {
    initialState(path) {
      const sub = SUBAGENT_FILE_RE.exec(path);
      return {
        sessionId: null,
        cwd: null,
        agent: sub ? sub[2]!.replace(/^_+/, "") || "subagent" : null,
        parentId: sub ? sub[1]! : null,
        model: null,
        promptId: null,
        skill: null,
      };
    },

    parse(lines, ctx: FileContext, state, sink: IngestSink) {
      const sessions = new SessionAccumulator();
      const sid = () => `${harness}:${state.sessionId}`;
      // A record's id: within the session for omp, by entry and time for pi (see above).
      const key = (entry: string, at: unknown) => (harness === "pi" ? `pi:${entry}:${typeof at === "number" ? at : String(at ?? "")}` : `${sid()}:${entry}`);
      const usageRow = (u: Record<string, any>, r: { id: string; ts: number; model: string | null; billing: string | null; agent: string; isSub: boolean }) => {
        // Both report input net of cache reads and output including reasoning, like the usage table. pi's 1-hour
        // cache writes are part of its cacheWrite.
        const write1h = num(u.cacheWrite1h);
        sink.usage({
          id: r.id,
          provider: harness,
          sessionId: sid(),
          promptId: state.promptId,
          ts: r.ts,
          project: state.cwd,
          model: r.model,
          skill: state.skill,
          agent: r.agent,
          isSubagent: r.isSub,
          input: num(u.input),
          output: num(u.output),
          cacheRead: num(u.cacheRead),
          cacheWrite: Math.max(0, num(u.cacheWrite) - write1h),
          cacheWrite1h: write1h,
          reasoning: num(u.reasoningTokens ?? u.reasoning),
          billing: r.billing,
          premiumRequests: num(u.premiumRequests),
        });
      };

      for (const { text, offset } of lines) {
        let rec: Record<string, any>;
        try {
          rec = JSON.parse(text);
        } catch {
          continue;
        }
        const ts = parseTs(rec.timestamp);

        if (rec.type === "session") {
          state.sessionId = rec.id ?? SESSION_FILE_RE.exec(ctx.path)?.[1] ?? null;
          state.cwd = rec.cwd ?? state.cwd;
          // omp's parentSession names the session a subagent works for. pi's names the file a fork was copied from,
          // which is history, not a parent.
          if (harness === "omp" && typeof rec.parentSession === "string") state.parentId = SESSION_FILE_RE.exec(rec.parentSession)?.[1] ?? state.parentId;
          if (state.sessionId) {
            sessions.touch(
              {
                id: sid(),
                provider: harness,
                nativeId: state.sessionId,
                project: state.cwd,
                title: typeof rec.title === "string" ? rec.title : null,
                client: harness,
                parentSessionId: state.parentId ? `${harness}:${state.parentId}` : null,
                agent: state.agent,
              },
              ts,
            );
          }
          continue;
        }
        if (!state.sessionId) continue;
        const sessionId = sid();
        const agent = state.agent ?? "main";
        const isSub = state.agent !== null;

        // omp renames a session with title_change, pi with session_info.
        const title = rec.type === "title_change" ? rec.title : rec.type === "session_info" ? rec.name : null;
        if (typeof title === "string" && title) {
          sessions.touch({ id: sessionId, provider: harness, nativeId: state.sessionId, title }, ts);
          continue;
        }
        if (rec.type === "thinking_level_change") {
          if (typeof rec.thinkingLevel === "string") state.effort = rec.thinkingLevel;
          continue;
        }
        if (rec.type === "model_change") {
          // omp names "openai-codex/gpt-6-sol" (messages name it bare), pi the provider and modelId apart.
          const model = typeof rec.modelId === "string" ? rec.modelId : typeof rec.model === "string" ? rec.model : null;
          if (model) state.model = model.slice(model.lastIndexOf("/") + 1);
          continue;
        }
        // pi's usage outside messages: cache warming ("usage"), and the model calls behind compactions and branch summaries.
        if ((rec.type === "usage" || rec.type === "compaction" || rec.type === "branch_summary") && rec.usage && typeof rec.usage === "object" && ts != null) {
          const billing = typeof rec.provider === "string" ? rec.provider : (state.billing ?? null);
          usageRow(rec.usage, { id: key(rec.id ?? `o${offset}`, ts), ts, model: typeof rec.model === "string" ? rec.model : state.model, billing, agent, isSub });
          continue;
        }
        if (rec.type !== "message" || !rec.message) continue;
        const m = rec.message as Record<string, any>;
        const entry = rec.id ?? `o${offset}`;
        if (ts != null) sessions.touch({ id: sessionId, provider: harness, nativeId: state.sessionId }, ts);

        if (m.role === "user") {
          // A subagent's "user" turn is its brief from the parent: kept with the session, never counted as a prompt.
          if (isSub && !state.briefSeen) {
            const brief = truncate(textOf(m.content), ctx.promptTextLimit);
            if (brief) {
              sessions.touch({ id: sessionId, provider: harness, nativeId: state.sessionId, brief }, ts);
              state.briefSeen = true;
            }
          }
          if (isSub || ts == null) continue;
          const promptText = textOf(m.content);
          const promptId = key(entry, m.timestamp ?? ts);
          state.promptId = promptId;
          state.skill = null;
          sink.prompt({
            id: promptId,
            sessionId,
            provider: harness,
            ts,
            text: truncate(promptText, ctx.promptTextLimit),
            skill: null,
            isCommand: /^\s*\/[\w:-]+/.test(promptText ?? ""),
          });
          continue;
        }
        if (m.role === "toolResult") {
          if (typeof m.toolCallId !== "string" || ts == null) continue;
          const id = harness === "pi" ? `pi:${m.toolCallId}` : `${sessionId}:${m.toolCallId}`;
          const call = takeCall(state.calls, id);
          const error = m.isError === true ? (textOf(m.content)?.trim() ?? "") : "";
          const kind = m.isError !== true ? "tool_ok" : STOPPED_RE.test(error) ? "tool_rejected" : "tool_error";
          const tool = typeof m.toolName === "string" ? m.toolName : call.tool;
          sink.outcome?.({
            id,
            provider: harness,
            sessionId,
            ts,
            project: state.cwd,
            model: state.answeredBy ?? state.model,
            agent,
            effort: state.effort ?? null,
            kind,
            ...failureOf(kind, tool, error, call.input, ctx.promptTextLimit),
          });
          continue;
        }
        if (m.role !== "assistant") continue;

        const content: any[] = Array.isArray(m.content) ? m.content : [];
        for (const [i, c] of content.entries()) {
          if (c?.type !== "toolCall" || typeof c.name !== "string") continue;
          const path = typeof c.arguments?.path === "string" ? (c.arguments.path as string) : null;
          const skill = path ? SKILL_URI_RE.exec(path)?.[1] : null;
          if (skill) state.skill = skill;
          const files =
            c.name === "edit" && typeof c.arguments?.input === "string"
              ? [...(c.arguments.input as string).matchAll(PATCH_FILE_RE)].flatMap((f) => filePaths(f[1]!))
              : FILE_TOOLS.has(c.name) && path ? filePaths(path) : [];
          // One row per call; a patch over several files adds a row for each further file.
          const callId = harness === "pi" && c.id ? `pi:${c.id}` : `${sessionId}:${c.id ?? `${entry}:${i}`}`;
          if (c.id) rememberCall((state.calls ??= {}), callId, c.name, inputSummary(c.arguments, ctx.promptTextLimit) ?? (ctx.promptTextLimit > 0 ? (files[0] ?? null) : null));
          (files.length ? files : [null]).forEach((filePath, n) =>
            sink.tool({
              id: n === 0 ? callId : `${callId}:f${n}`,
              usageId: key(entry, m.timestamp ?? ts),
              sessionId,
              promptId: state.promptId,
              provider: harness,
              ts: ts ?? Date.now(),
              project: state.cwd,
              tool: c.name,
              filePath,
              skill: state.skill,
              agent,
            }),
          );
        }

        const billing = typeof m.provider === "string" ? m.provider : null;
        if (billing) state.billing = billing;
        // A response the provider failed: its message says why ("429 …", "usage limit has been reached (code=…)").
        if (m.stopReason === "error" && ts != null) {
          const at = parseTs(m.timestamp) ?? ts;
          sink.outcome?.({
            id: `${key(entry, m.timestamp ?? ts)}:api`,
            provider: harness,
            sessionId,
            ts: at,
            project: state.cwd,
            model: typeof m.model === "string" ? m.model : state.model,
            agent,
            effort: state.effort ?? null,
            ...apiErrorOf(null, typeof m.status === "number" ? m.status : null, typeof m.errorMessage === "string" ? m.errorMessage : null, ctx.promptTextLimit),
          });
        }
        const u = m.usage;
        if (!u || typeof u !== "object") continue;
        // The model that answered, when it differs from the one asked for (pi's responseModel).
        const model = typeof m.responseModel === "string" ? m.responseModel : typeof m.model === "string" ? m.model : state.model;
        const usageId = key(entry, m.timestamp ?? ts);
        const at = ts ?? parseTs(m.timestamp) ?? Date.now();
        if (model) state.answeredBy = model;
        usageRow(u, { id: usageId, ts: at, model, billing, agent, isSub });
        // The message carries its own request start, completion and time to first token.
        const start = typeof m.timestamp === "number" ? m.timestamp : null;
        sink.responseMeta?.({
          usageId,
          startTs: start,
          endTs: typeof m.completedAt === "number" ? m.completedAt : start != null && typeof m.duration === "number" ? start + m.duration : at,
          ttftMs: typeof m.ttft === "number" ? m.ttft : null,
          effort: state.effort ?? null,
          stopReason: typeof m.stopReason === "string" ? m.stopReason : null,
        });
        if (m.stopReason === "aborted" && !String(m.errorMessage ?? "").includes("silent_abort")) {
          sink.outcome?.({ id: `${usageId}:interrupt`, provider: harness, sessionId, ts: at, project: state.cwd, model, agent, effort: state.effort ?? null, kind: "interrupt" });
        }
      }
      sessions.flush(sink);
      return state;
    },
  };
}

export const ompParser = piFamilyParser("omp");
export const piParser = piFamilyParser("pi");
