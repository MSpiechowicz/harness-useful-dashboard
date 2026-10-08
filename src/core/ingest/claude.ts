import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { apiErrorOf } from "../apiErrors.ts";
import { failureOf, inputSummary, type PendingCalls, rememberCall, takeCall } from "../failures.ts";
import { countLines, diffLines, hunkLines, type LineCount, sumLines } from "./lines.ts";
import {
  type FileContext,
  type IngestSink,
  type LineParser,
  num,
  parseTs,
  SessionAccumulator,
  truncate,
} from "./types.ts";

/** Built-in Claude Code slash commands; any other slash command is treated as a skill/custom command. */
export const CLAUDE_BUILTIN_COMMANDS = new Set([
  "add-dir", "agents", "artifacts", "bashes", "bug", "clear", "color", "compact", "config", "context", "cost",
  "doctor", "effort", "exit", "export", "fast", "feedback", "help", "hooks", "ide", "init", "install-github-app",
  "keybindings", "login", "logout", "mcp", "memory", "model", "output-style", "permissions", "plugin", "plugins",
  "privacy-settings", "quit", "release-notes", "reload-plugins", "remote", "rename", "resume", "rewind", "sandbox",
  "status", "statusline", "tasks", "terminal-setup", "theme", "todos", "upgrade", "usage", "vim", "workflows",
]);

const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "NotebookRead"]);

interface ClaudeState {
  promptId: string | null;
  skill: string | null;
  /** Subagent identity, derived from the file location / meta.json. */
  agent: string | null;
  spawnRef: string | null;
  /** Model of the last response, which the tool results that follow belong to. */
  model?: string | null;
  effort?: string | null;
  /** Time of the last user record (a prompt or tool results), where the next response starts. */
  inputTs?: number | null;
  /** The response being streamed, and when it started. */
  responseId?: string | null;
  responseStart?: number | null;
  responseEnd?: number | null;
  /** Tool calls waiting for their results: what a failed one was given. */
  calls?: PendingCalls;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** A failed tool result that only says the user (or a permission rule) stopped the call. */
const REJECTED_RE = /^The user doesn't want to (proceed|take this action)|tool use was rejected|^Permission to use .* (has been|was) denied|^<tool_use_error>Blocked/i;

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[]).map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as ContentBlock[];
  if (blocks.some((b) => b?.type === "tool_result")) return null;
  const parts = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text!);
  return parts.length ? parts.join("\n") : null;
}

const NON_PROMPT_PREFIXES = [
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<task-notification>",
  "<system-reminder>",
  "[Request interrupted",
  "Caveat: The messages below were generated",
];

export interface ParsedPrompt {
  text: string;
  command: string | null;
}

/** Returns the user-visible prompt text, or null when a user record is not a human prompt. */
export function parseClaudePrompt(content: unknown): ParsedPrompt | null {
  const raw = textOf(content);
  if (!raw) return null;
  const text = raw.trim();
  if (!text || NON_PROMPT_PREFIXES.some((p) => text.startsWith(p))) return null;
  const cmd = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
    return { text: `/${cmd[1]}${args ? " " + args : ""}`, command: cmd[1]! };
  }
  return { text, command: null };
}

/** The lines an edit tool call changes, from its input. Its result's patch, when there is one, is exact (below). */
export function claudeEditLines(tool: string, input: Record<string, any>): LineCount | null {
  switch (tool) {
    case "Edit":
      // replace_all changes every occurrence: the result's patch counts them.
      return diffLines(input.old_string, input.new_string);
    case "MultiEdit":
      return sumLines((Array.isArray(input.edits) ? input.edits : []).map((e: any) => diffLines(e?.old_string, e?.new_string))) ?? { added: 0, removed: 0 };
    case "Write":
      return { added: countLines(input.content), removed: 0 };
    case "NotebookEdit":
      // A replaced cell's old source isn't in the call: only its new lines count.
      return { added: input.edit_mode === "delete" ? 0 : countLines(input.new_source), removed: 0 };
    default:
      return null;
  }
}

/**
 * The exact lines from an edit's result (`toolUseResult`): the hunks of its `structuredPatch`, or, for a new file
 * (whose patch is empty), its content.
 */
function resultLines(r: unknown): LineCount | null {
  if (!r || typeof r !== "object") return null;
  const x = r as Record<string, any>;
  if (typeof x.filePath !== "string" || !Array.isArray(x.structuredPatch)) return null;
  return hunkLines(x.structuredPatch) ?? (x.type === "create" ? { added: countLines(x.content), removed: 0 } : null);
}

/** The tools that start a subagent (Task in older Claude Code versions). */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);
/** A text input's first line, if it has any words. */
const firstText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().split("\n")[0]!.trim() || null : null);

function subagentInfo(path: string): { agent: string | null; spawnRef: string | null } {
  const name = basename(path);
  if (!name.startsWith("agent-")) return { agent: null, spawnRef: null };
  const metaPath = path.replace(/\.jsonl$/, ".meta.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { agentType?: string; toolUseId?: string };
      return { agent: meta.agentType || "subagent", spawnRef: meta.toolUseId ? `claude:${meta.toolUseId}` : null };
    } catch {
      /* fall through */
    }
  }
  return { agent: "subagent", spawnRef: null };
}

/** The name of the plugin a skill folder belongs to: its `.claude-plugin/plugin.json`, a level or two up. */
const pluginNames = new Map<string, string | null>();
function pluginOf(skillsDir: string): string | null {
  if (pluginNames.has(skillsDir)) return pluginNames.get(skillsDir)!;
  let name: string | null = null;
  for (let dir = dirname(skillsDir), i = 0; i < 3 && !name; dir = dirname(dir), i++) {
    try {
      const v = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
      if (typeof v.name === "string" && v.name) name = v.name;
    } catch {
      /* not this level */
    }
  }
  pluginNames.set(skillsDir, name);
  return name;
}

/**
 * The skill a subagent's agent is built from: its instructions (the first part of its system prompt) point into one
 * skill's folder, as a plugin's agents follow their skill's brief. Named as the Skill tool names it ("plugin:skill").
 */
export function agentSkill(systemPrompt: unknown): string | null {
  const own = Array.isArray(systemPrompt) ? systemPrompt[0] : systemPrompt;
  if (typeof own !== "string") return null;
  const m = /((?:\/[^\s`'"()]+?)?\/skills)\/([A-Za-z0-9_.-]+)\//.exec(own);
  if (!m) return null;
  const plugin = m[1]!.startsWith("/") ? pluginOf(m[1]!) : null;
  return plugin ? `${plugin}:${m[2]}` : m[2]!;
}

export const claudeParser: LineParser<ClaudeState> = {
  initialState(path) {
    return { promptId: null, skill: null, ...subagentInfo(path) };
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
      const nativeSession: string | undefined = rec.sessionId ?? rec.session_id;
      if (!nativeSession) continue;
      const sessionId = `claude:${nativeSession}`;
      const ts = parseTs(rec.timestamp);
      const sidechain = rec.isSidechain === true || state.agent !== null;
      const agent = sidechain ? state.agent ?? "subagent" : "main";

      if (rec.type === "ai-title" || rec.type === "custom-title" || rec.type === "summary") {
        const title = rec.customTitle ?? rec.aiTitle ?? rec.summary;
        if (typeof title === "string" && !sidechain) sessions.touch({ id: sessionId, provider: "claude", nativeId: nativeSession, title });
        continue;
      }
      // A request the API turned down that Claude Code then retried (older versions log each attempt).
      if (rec.type === "system" && rec.subtype === "api_error" && ts != null) {
        const e = rec.error ?? {};
        const body = e.error?.error ?? e.error ?? {};
        const message = [body.message, e.message, rec.cause?.message, rec.cause?.code].find((v) => typeof v === "string" && v.trim()) ?? null;
        sink.outcome?.({
          id: `${sessionId}:${rec.uuid ?? ts}:api`,
          provider: "claude",
          sessionId,
          ts,
          project: rec.cwd ?? null,
          model: state.model ?? null,
          agent,
          effort: state.effort ?? null,
          ...apiErrorOf(typeof body.type === "string" ? body.type : null, typeof e.status === "number" ? e.status : null, message, ctx.promptTextLimit),
        });
        continue;
      }
      // A subagent's own instructions, logged before it starts: the skill its agent is built from is its skill.
      if (rec.type === "attachment" && rec.attachment?.type === "prompt_snapshot") {
        if (state.agent !== null && !state.skill) state.skill = agentSkill(rec.attachment.systemPrompt);
        continue;
      }
      if (rec.type !== "user" && rec.type !== "assistant") continue;

      if (!sidechain) {
        sessions.touch(
          {
            id: sessionId,
            provider: "claude",
            nativeId: nativeSession,
            project: rec.cwd ?? null,
            gitBranch: rec.gitBranch && rec.gitBranch !== "HEAD" ? rec.gitBranch : null,
            client: rec.entrypoint ?? "cli",
            clientVersion: rec.version ?? null,
          },
          ts,
        );
      } else if (ts != null) {
        sessions.touch({ id: sessionId, provider: "claude", nativeId: nativeSession }, ts);
      }

      if (rec.type === "user") {
        if (ts != null) {
          state.inputTs = ts;
          const blocks: ContentBlock[] = Array.isArray(rec.message?.content) ? rec.message.content : [];
          const texts = typeof rec.message?.content === "string" ? [rec.message.content as string] : blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "");
          const outcome = { provider: "claude" as const, sessionId, ts, project: rec.cwd ?? null, model: state.model ?? null, agent, effort: state.effort ?? null };
          const results = blocks.filter((b) => b?.type === "tool_result" && b.tool_use_id);
          for (const b of blocks) {
            if (b?.type !== "tool_result" || !b.tool_use_id) continue;
            const id = `claude:${b.tool_use_id}`;
            const call = takeCall(state.calls, id);
            const error = b.is_error ? resultText(b.content).trim() : "";
            const kind = !b.is_error ? "tool_ok" : REJECTED_RE.test(error) ? "tool_rejected" : "tool_error";
            sink.outcome?.({ ...outcome, id, kind, ...failureOf(kind, call.tool, error, call.input, ctx.promptTextLimit) });
            // The record's toolUseResult belongs to its only result.
            const lines = kind === "tool_ok" && results.length === 1 ? resultLines(rec.toolUseResult) : null;
            if (lines) sink.editLines?.({ toolId: id, ...lines });
          }
          if (texts.some((t) => t.trim().startsWith("[Request interrupted by user"))) {
            sink.outcome?.({ ...outcome, id: `${sessionId}:${rec.uuid ?? ts}:interrupt`, kind: "interrupt" });
          }
        }
        if (sidechain || rec.isMeta || ts == null) continue;
        const parsed = parseClaudePrompt(rec.message?.content);
        if (!parsed) continue;
        const isBuiltin = parsed.command !== null && CLAUDE_BUILTIN_COMMANDS.has(parsed.command);
        const skill = parsed.command && !isBuiltin ? parsed.command : null;
        const promptId = `${sessionId}:${rec.promptId ?? rec.uuid}`;
        state.promptId = promptId;
        state.skill = skill;
        sink.prompt({
          id: promptId,
          sessionId,
          provider: "claude",
          ts,
          text: truncate(parsed.text, ctx.promptTextLimit),
          skill,
          isCommand: parsed.command !== null,
        });
        continue;
      }

      // assistant
      const msg = rec.message ?? {};
      // A request that failed for good: Claude Code shows its error as a reply ("API Error: 529 …", "Request timed out",
      // "Login expired"), with the error's name and status beside it. The reply's model is "<synthetic>", so the error
      // goes to the model the session was using.
      if (rec.isApiErrorMessage === true && ts != null) {
        sink.outcome?.({
          id: `${sessionId}:${rec.uuid ?? ts}:api`,
          provider: "claude",
          sessionId,
          ts,
          project: rec.cwd ?? null,
          model: state.model ?? null,
          agent,
          effort: state.effort ?? null,
          ...apiErrorOf(
            typeof rec.error === "string" ? rec.error : typeof rec.apiErrorCode === "string" ? rec.apiErrorCode : null,
            typeof rec.apiErrorStatus === "number" ? rec.apiErrorStatus : null,
            textOf(msg.content),
            ctx.promptTextLimit,
          ),
        });
      }
      const usage = msg.usage;
      if (!usage || ts == null) continue;
      const usageId = `claude:${msg.id ?? rec.requestId ?? rec.uuid}`;
      const promptId = sidechain ? null : state.promptId;
      const project = rec.cwd ?? null;
      const skillAtStart = state.skill;

      const cc = usage.cache_creation;
      const write1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
      const write5m = cc ? num(cc.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens);
      // Older logs only report the aggregate; make sure nothing is lost if the split doesn't add up.
      const aggregate = num(usage.cache_creation_input_tokens);
      const cacheWrite = cc && write5m + write1h < aggregate ? aggregate - write1h : write5m;

      sink.usage({
        id: usageId,
        provider: "claude",
        sessionId,
        promptId,
        ts,
        project,
        model: msg.model ?? null,
        skill: skillAtStart,
        agent,
        isSubagent: sidechain,
        spawnRef: sidechain ? state.spawnRef : null,
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite,
        cacheWrite1h: write1h,
        reasoning: num(usage.output_tokens_details?.thinking_tokens),
        speed: typeof usage.speed === "string" ? usage.speed : null,
      });

      // One response is logged as a line per content block: it started when its input arrived (or the response
      // before it ended) and ended with its last line.
      if (state.responseId !== usageId) {
        const prevEnd = state.responseEnd ?? null;
        state.responseId = usageId;
        state.responseStart = Math.max(state.inputTs ?? 0, prevEnd ?? 0) || null;
      }
      state.responseEnd = ts;
      if (msg.model !== "<synthetic>") state.model = msg.model ?? state.model ?? null;
      if (typeof rec.effort === "string") state.effort = rec.effort;
      sink.responseMeta?.({
        usageId,
        startTs: state.responseStart ?? null,
        endTs: ts,
        effort: typeof rec.effort === "string" ? rec.effort : null,
        stopReason: typeof msg.stop_reason === "string" ? msg.stop_reason : null,
      });

      const content: ContentBlock[] = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (block?.type !== "tool_use" || !block.name) continue;
        const input = block.input ?? {};
        let filePath: string | null = null;
        if (FILE_TOOLS.has(block.name)) {
          const p = input.file_path ?? input.notebook_path ?? input.path;
          filePath = typeof p === "string" ? p : null;
        }
        const toolName = block.name.startsWith("mcp__") ? block.name.split("__").slice(0, 2).join("__") : block.name;
        const toolId = `claude:${block.id ?? `${usageId}:${block.name}`}`;
        const lines = claudeEditLines(block.name, input);
        // Streaming repeats a response's lines: a call seen again is still the one waiting.
        if (block.id) rememberCall((state.calls ??= {}), toolId, block.name, inputSummary(input, ctx.promptTextLimit));
        sink.tool({
          id: toolId,
          usageId,
          sessionId,
          promptId,
          provider: "claude",
          ts,
          project,
          tool: toolName,
          filePath,
          skill: state.skill,
          agent,
          spawnRef: sidechain ? state.spawnRef : null,
          // A subagent's run is named by what the call that started it asked of it.
          brief: SPAWN_TOOLS.has(block.name) ? truncate(firstText(input.description) ?? firstText(input.prompt), Math.min(200, ctx.promptTextLimit)) : null,
          model: msg.model ?? null,
          linesAdded: lines?.added ?? null,
          linesRemoved: lines?.removed ?? null,
        });
        if (block.name === "Skill" && typeof input.skill === "string") state.skill = input.skill;
      }
    }
    sessions.flush(sink);
    return state;
  },
};
