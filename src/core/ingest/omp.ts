import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";

/**
 * omp (oh-my-pi) sessions: ~/.omp/agent/sessions/<project>/<started>_<uuid>.jsonl, one JSON entry per line
 * (session header, messages, model changes, …). A subagent's transcript sits in a folder named after its
 * parent's file, `<started>_<uuid>/<AgentName>.jsonl`, and its header points back with `parentSession`.
 * Every assistant message carries its own usage, model, and the provider it was billed through
 * ("openai-codex", "github-copilot", "anthropic", …), which becomes the usage row's billing.
 */
interface OmpState {
  sessionId: string | null;
  cwd: string | null;
  /** Subagent name (the file's name), null in a main session. */
  agent: string | null;
  parentId: string | null;
  /** Model of the last model_change, for messages that don't name one. */
  model: string | null;
  promptId: string | null;
  skill: string | null;
}

const SESSION_FILE_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SUBAGENT_FILE_RE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[\\/]([^\\/]+)\.jsonl$/i;
/** Tools whose `path` argument is the file they work on. */
const FILE_TOOLS = new Set(["read", "write"]);
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

export const ompParser: LineParser<OmpState> = {
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
    const sid = () => `omp:${state.sessionId}`;

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
        if (typeof rec.parentSession === "string") state.parentId = SESSION_FILE_RE.exec(rec.parentSession)?.[1] ?? state.parentId;
        if (state.sessionId) {
          sessions.touch(
            {
              id: sid(),
              provider: "omp",
              nativeId: state.sessionId,
              project: state.cwd,
              title: typeof rec.title === "string" ? rec.title : null,
              client: "omp",
              parentSessionId: state.parentId ? `omp:${state.parentId}` : null,
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

      if (rec.type === "title_change" && typeof rec.title === "string") {
        sessions.touch({ id: sessionId, provider: "omp", nativeId: state.sessionId, title: rec.title }, ts);
        continue;
      }
      if (rec.type === "model_change" && typeof rec.model === "string") {
        state.model = rec.model.slice(rec.model.lastIndexOf("/") + 1); // "openai-codex/gpt-6-sol": messages name it bare
        continue;
      }
      if (rec.type !== "message" || !rec.message) continue;
      const m = rec.message as Record<string, any>;
      const entry = rec.id ?? `o${offset}`;
      if (ts != null) sessions.touch({ id: sessionId, provider: "omp", nativeId: state.sessionId }, ts);

      if (m.role === "user") {
        if (isSub || ts == null) continue; // a subagent's "user" turn is its brief from the parent
        const promptText = textOf(m.content);
        const promptId = `${sessionId}:${entry}`;
        state.promptId = promptId;
        state.skill = null;
        sink.prompt({
          id: promptId,
          sessionId,
          provider: "omp",
          ts,
          text: truncate(promptText, ctx.promptTextLimit),
          skill: null,
          isCommand: /^\s*\/[\w:-]+/.test(promptText ?? ""),
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
        const callId = `${sessionId}:${c.id ?? `${entry}:${i}`}`;
        (files.length ? files : [null]).forEach((filePath, n) =>
          sink.tool({
            id: n === 0 ? callId : `${callId}:f${n}`,
            usageId: `${sessionId}:${entry}`,
            sessionId,
            promptId: state.promptId,
            provider: "omp",
            ts: ts ?? Date.now(),
            project: state.cwd,
            tool: c.name,
            filePath,
            skill: state.skill,
            agent,
          }),
        );
      }

      const u = m.usage;
      if (!u || typeof u !== "object") continue;
      sink.usage({
        id: `${sessionId}:${entry}`,
        provider: "omp",
        sessionId,
        promptId: state.promptId,
        ts: ts ?? parseTs(m.timestamp) ?? Date.now(),
        project: state.cwd,
        model: typeof m.model === "string" ? m.model : state.model,
        skill: state.skill,
        agent,
        isSubagent: isSub,
        // omp reports input net of cache reads, and output including reasoning, like the usage table.
        input: num(u.input),
        output: num(u.output),
        cacheRead: num(u.cacheRead),
        cacheWrite: num(u.cacheWrite),
        cacheWrite1h: 0,
        reasoning: num(u.reasoningTokens),
        billing: typeof m.provider === "string" ? m.provider : null,
        premiumRequests: num(u.premiumRequests),
      });
    }
    sessions.flush(sink);
    return state;
  },
};
