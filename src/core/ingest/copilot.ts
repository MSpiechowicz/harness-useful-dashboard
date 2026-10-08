import { failureOf, inputSummary, type PendingCalls, rememberCall, takeCall } from "../failures.ts";
import { countLines, diffLines, type LineCount, patchLines, unifiedDiffLines } from "./lines.ts";
import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";
import { emitGitEvents, vcsCall } from "./vcs.ts";

/**
 * GitHub Copilot CLI logs each session as events, one JSON object per line, in
 * ~/.copilot/session-state/<session id>/events.jsonl (or $COPILOT_HOME): session.start with the folder, branch and
 * model, user.message, assistant.message with the tools it asked for, tool.execution_complete, model changes.
 *
 * Tokens per model call are never written to disk (assistant.usage is an ephemeral event). What is: session.shutdown,
 * written when a session ends or is left for another, with the session's tokens and premium requests per model and per
 * agent so far. A resumed session's next shutdown counts on from the one before (same sessionStartTime), so only what
 * grew since becomes a row. A session that ended without a shutdown (a crash, a kill) has no tokens on disk.
 * Copilot bills premium requests, not tokens: the rows are billed through "github-copilot" and priced API-equivalent.
 * Newer versions also keep every model call in session-store.db (copilotStore.ts): a session found there has its
 * tokens from those calls, and its shutdown rows keep only their premium requests.
 */

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  premium: number;
}

interface CopilotState {
  sessionId: string | null;
  cwd: string | null;
  branch?: string | null;
  model: string | null;
  promptId: string | null;
  /** The model of the last answer, which the tool results that follow belong to. */
  answeredBy?: string | null;
  calls?: PendingCalls;
  /** sessionStartTime of the last shutdown, and its totals per agent and model. */
  runStart?: number | null;
  totals?: Record<string, Totals>;
}

const SESSION_RE = /session-state[\\/]([^\\/]+)[\\/]events\.jsonl$/;
/** Tools whose `path` argument is the file they work on. */
const FILE_TOOLS = new Set(["view", "create", "edit", "str_replace", "str_replace_editor", "insert", "write", "read"]);
/** Tools that run a shell command (`command`), whose output may report a commit or a pull request. */
const SHELL_TOOLS = new Set(["bash", "shell", "powershell"]);
/** Failed calls the user turned down or stopped rather than ones that went wrong. */
const STOPPED_RE = /^(?:rejected|denied|cancell?ed|aborted)$|\b(?:user )?(?:rejected|denied|declined)\b|\bcancell?ed by the user\b/i;

/** The lines an edit changes, from its arguments: the old and new text, a new file's text, or a patch. */
export function copilotEditLines(tool: string, args: Record<string, any>): LineCount | null {
  const command = tool === "str_replace_editor" ? args.command : tool;
  switch (command) {
    case "edit":
    case "str_replace":
      return diffLines(args.old_str, args.new_str);
    case "create":
      return { added: countLines(args.file_text), removed: 0 };
    case "insert":
      return { added: countLines(args.new_str), removed: 0 };
    case "apply_patch":
      return patchLines(typeof args.input === "string" ? args.input : JSON.stringify(args)) ?? { added: 0, removed: 0 };
    default:
      return null;
  }
}

/** A model as priced: long-context variants ("-1m", "-1m-internal") are priced as their model. */
export function copilotModel(name: string): string {
  return name.replace(/-1m(-internal)?$/, "");
}

const KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "premium"] as const;

function totalsOf(m: Record<string, any>): Totals {
  const u = m?.usage ?? {};
  return {
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
    premium: num(m?.requests?.cost),
  };
}

export const copilotParser: LineParser<CopilotState> = {
  initialState(path) {
    return { sessionId: SESSION_RE.exec(path)?.[1] ?? null, cwd: null, model: null, promptId: null };
  },

  parse(lines, ctx: FileContext, state, sink: IngestSink) {
    const sessions = new SessionAccumulator();
    for (const { text } of lines) {
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(text);
      } catch {
        continue;
      }
      const d = (rec?.data ?? {}) as Record<string, any>;
      const ts = parseTs(rec?.timestamp);
      if (rec?.type === "session.start" && typeof d.sessionId === "string") state.sessionId = d.sessionId;
      if (!state.sessionId || ts == null || typeof rec.type !== "string") continue;
      const sessionId = `copilot:${state.sessionId}`;
      const agent = typeof rec.agentId === "string" && rec.agentId ? rec.agentId : "main";
      const base = { id: sessionId, provider: "copilot" as const, nativeId: state.sessionId };

      switch (rec.type) {
        case "session.start":
        case "session.resume": {
          const c = d.context ?? {};
          state.cwd = (typeof c.cwd === "string" && c.cwd) || (typeof c.gitRoot === "string" && c.gitRoot) || state.cwd;
          if (typeof d.selectedModel === "string") state.model = d.selectedModel;
          if (typeof c.branch === "string" && c.branch) state.branch = c.branch;
          sessions.touch(
            {
              ...base,
              project: state.cwd,
              gitBranch: typeof c.branch === "string" ? c.branch : null,
              client: "copilot-cli",
              clientVersion: typeof d.copilotVersion === "string" ? d.copilotVersion : null,
            },
            ts,
          );
          break;
        }
        case "session.model_change":
          if (typeof d.newModel === "string") state.model = d.newModel;
          break;
        case "user.message": {
          sessions.touch(base, ts);
          const content = typeof d.content === "string" ? d.content : null;
          if (agent !== "main" || !content?.trim()) break;
          state.promptId = `${sessionId}:${rec.id ?? ts}`;
          sink.prompt({ id: state.promptId, sessionId, provider: "copilot", ts, text: truncate(content, ctx.promptTextLimit), skill: null, isCommand: /^\s*\/[\w:-]+/.test(content) });
          break;
        }
        case "assistant.message": {
          sessions.touch(base, ts);
          state.answeredBy = typeof d.model === "string" ? d.model : state.model;
          for (const r of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
            if (typeof r?.toolCallId !== "string" || typeof r.name !== "string") continue;
            const args = r.arguments && typeof r.arguments === "object" ? r.arguments : {};
            const id = `${sessionId}:${r.toolCallId}`;
            const vcs = SHELL_TOOLS.has(r.name) ? vcsCall(args.command, ctx.promptTextLimit, r.name === "powershell" ? "windows" : "posix") : null;
            rememberCall((state.calls ??= {}), id, r.name, inputSummary(args, ctx.promptTextLimit), vcs);
            const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
            const lines = copilotEditLines(r.name, args);
            sink.tool({
              id, usageId: null, sessionId, promptId: state.promptId, provider: "copilot", ts, project: state.cwd, tool: r.name,
              filePath: FILE_TOOLS.has(r.name) ? path : null, skill: null, agent, model: state.answeredBy ?? state.model,
              linesAdded: lines?.added ?? null, linesRemoved: lines?.removed ?? null,
            });
          }
          break;
        }
        case "tool.execution_complete": {
          if (typeof d.toolCallId !== "string") break;
          const id = `${sessionId}:${d.toolCallId}`;
          const call = takeCall(state.calls, id);
          const error = d.success === false ? `${d.error?.message ?? ""}` : "";
          const kind = d.success !== false ? "tool_ok" : STOPPED_RE.test(String(d.error?.code ?? "")) || STOPPED_RE.test(error) ? "tool_rejected" : "tool_error";
          sink.outcome?.({
            id,
            provider: "copilot",
            sessionId,
            ts,
            project: state.cwd,
            model: typeof d.model === "string" ? d.model : (state.answeredBy ?? state.model),
            agent,
            kind,
            ...failureOf(kind, call.tool, error, call.input, ctx.promptTextLimit),
          });
          // An edit's result shows its diff: exact where the arguments were not.
          const diff = d.result?.detailedContent;
          const exact = kind === "tool_ok" && typeof diff === "string" && diff.includes("@@") ? unifiedDiffLines(diff) : null;
          if (exact) sink.editLines?.({ toolId: id, ...exact });
          // A commit or PR the call made, read from its result's text, else its detailed text.
          if (kind === "tool_ok" && call.vcs) {
            const output = typeof d.result?.content === "string" ? d.result.content : d.result?.detailedContent;
            const gitCall = { provider: "copilot" as const, sessionId, ts, project: state.cwd, agent, branch: state.branch ?? null, callId: id };
            emitGitEvents(sink, call.vcs, output, gitCall, ctx.promptTextLimit);
          }
          break;
        }
        case "abort":
          sink.outcome?.({ id: `${sessionId}:${rec.id ?? ts}:interrupt`, provider: "copilot", sessionId, ts, project: state.cwd, model: state.answeredBy ?? state.model, agent, kind: "interrupt" });
          break;
        case "session.shutdown":
          sessions.touch(base, ts);
          shutdown(rec, d, ts, sessionId, state, sink);
          break;
      }
    }
    sessions.flush(sink);
    return state;
  },
};

/** A shutdown's totals per agent and model, written as what grew since the last one of the same run. */
function shutdown(rec: Record<string, any>, d: Record<string, any>, ts: number, sessionId: string, state: CopilotState, sink: IngestSink): void {
  const agents: [string, Record<string, any>][] =
    d.agentMetrics && typeof d.agentMetrics === "object" && Object.keys(d.agentMetrics).length
      ? Object.entries(d.agentMetrics)
      : [["main", { modelMetrics: d.modelMetrics }]];
  const runStart = typeof d.sessionStartTime === "number" ? d.sessionStartTime : null;
  // A new run (another start time) counts from zero.
  if (runStart == null || runStart !== state.runStart) state.totals = {};
  state.runStart = runStart;
  const totals = (state.totals ??= {});
  const rows: { key: string; agent: string; isSub: boolean; model: string; delta: Totals }[] = [];
  for (const [agentKey, a] of agents) {
    const metrics = a?.modelMetrics && typeof a.modelMetrics === "object" ? (a.modelMetrics as Record<string, any>) : {};
    for (const [name, m] of Object.entries(metrics)) {
      // "auto" is whichever model the session was on. Long-context variants are priced as their model.
      const model = copilotModel(name === "auto" && typeof d.currentModel === "string" ? d.currentModel : name);
      const key = `${agentKey}|${name}`;
      const cur = totalsOf(m);
      const prev = totals[key];
      // Totals only grow within a run: one that shrank started over.
      const grew = prev && KEYS.every((k) => cur[k] >= prev[k]);
      const delta = Object.fromEntries(KEYS.map((k) => [k, grew ? cur[k] - prev![k] : cur[k]])) as unknown as Totals;
      totals[key] = cur;
      if (KEYS.every((k) => delta[k] === 0)) continue;
      const isSub = agentKey !== "main";
      rows.push({ key, agent: isSub ? (typeof a.agentName === "string" && a.agentName) || agentKey : "main", isSub, model, delta });
    }
  }
  for (const r of rows) {
    sink.usage({
      id: `${sessionId}:${rec.id ?? ts}:${r.key}`,
      provider: "copilot",
      sessionId,
      promptId: state.promptId,
      ts,
      project: state.cwd,
      model: r.model,
      skill: null,
      agent: r.agent,
      isSubagent: r.isSub,
      // Copilot's input includes the cache reads and writes.
      input: Math.max(0, r.delta.input - r.delta.cacheRead - r.delta.cacheWrite),
      output: r.delta.output,
      cacheRead: r.delta.cacheRead,
      cacheWrite: r.delta.cacheWrite,
      cacheWrite1h: 0,
      reasoning: r.delta.reasoning,
      billing: "github-copilot",
      premiumRequests: r.delta.premium,
      // Session totals: once the session's calls are read from the store, only the premium requests are kept.
      rollup: true,
    });
  }
}
