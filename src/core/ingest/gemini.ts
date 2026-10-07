import { readFileSync } from "node:fs";
import { join } from "node:path";
import { failureOf, inputSummary } from "../failures.ts";
import { type FileContext, type IngestSink, type LineParser, num, parseTs, SessionAccumulator, truncate } from "./types.ts";

/**
 * Gemini CLI records each chat under ~/.gemini/tmp/<project>/chats/ (or $GEMINI_CLI_HOME/.gemini):
 *  - since v0.39, session-<started>-<id>.jsonl: a header line (sessionId, projectHash, startTime), then the messages.
 *    A message is written again, whole, each time it changes (its tokens arrive, a tool call ends), so the last copy
 *    of an id wins. `$set` lines change the header (the summary, used as the title), `$rewindTo` and `$patch` lines
 *    edit the history as the CLI shows it, which leaves what was spent as it was: they are skipped.
 *  - before, session-<started>-<id>.json: the same header and messages as one JSON object, rewritten on each change.
 *    A resumed old session is copied into a .jsonl next to it: both read into the same rows.
 * A subagent's chat sits in a folder named after its parent session: chats/<parent id>/<id>.jsonl.
 * The project folder is named after the project (before v0.29 its path's SHA-256) and holds .project_root, the path.
 *
 * Every "gemini" message carries the model and its response's tokens as the API counted them: `input` includes the
 * cached part, `thoughts` and `tool` (tool-use prompt tokens) come on top of output and input.
 */

interface GeminiState {
  sessionId: string | null;
  cwd: string | null;
  /** The parent session's id, for a subagent's chat. */
  parentId: string | null;
  isSub: boolean;
  promptId: string | null;
  /** When the last message was logged: the start of the response that follows. */
  lastTs: number | null;
  briefSeen?: boolean;
}

const CHAT_RE = /^(.*)[\\/]tmp[\\/]([^\\/]+)[\\/]chats[\\/](?:([^\\/]+)[\\/])?[^\\/]+\.jsonl?$/;
/** Tools whose path argument is the file they work on. */
const FILE_TOOLS = new Set(["read_file", "write_file", "replace", "edit"]);
const CANCELLED_RE = /^Request cancelled/i;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The project a chat folder belongs to: its .project_root, else its entry in projects.json. */
function projectRoot(root: string, slug: string): string | null {
  const own = readText(join(root, "tmp", slug, ".project_root"))?.trim();
  if (own) return own;
  try {
    const projects = JSON.parse(readText(join(root, "projects.json")) ?? "{}")?.projects ?? {};
    for (const [path, name] of Object.entries(projects)) if (name === slug) return path;
  } catch {
    /* no registry */
  }
  return null;
}

function initialState(path: string): GeminiState {
  const m = CHAT_RE.exec(path);
  return {
    sessionId: null,
    cwd: m ? projectRoot(m[1]!, m[2]!) : null,
    parentId: m?.[3] ?? null,
    isSub: m?.[3] != null,
    promptId: null,
    lastTs: null,
  };
}

/** Text of a message's content: a string, or parts of which the text ones count. */
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const text = parts.filter((p) => typeof p?.text === "string").map((p) => p.text as string).join("\n");
  return text || null;
}

/** What a finished tool call said: the error, else its output. */
function resultText(call: Record<string, any>): string {
  const parts = Array.isArray(call.result) ? call.result : call.result ? [call.result] : [];
  for (const p of parts) {
    const r = p?.functionResponse?.response;
    if (typeof r?.error === "string") return r.error;
    if (typeof r?.output === "string") return r.output;
    if (typeof p?.text === "string") return p.text;
  }
  return typeof call.resultDisplay === "string" ? call.resultDisplay : "";
}

/** Reads one record: the header, a `$set`, or a message. */
function record(rec: Record<string, any>, ctx: { promptTextLimit: number }, state: GeminiState, sink: IngestSink, sessions: SessionAccumulator): void {
  const sid = () => `gemini:${state.sessionId}`;
  const touch = (extra: Record<string, unknown>, ts: number | null) =>
    sessions.touch({ id: sid(), provider: "gemini", nativeId: state.sessionId!, ...extra }, ts);

  if (typeof rec.sessionId === "string" && typeof rec.projectHash === "string") {
    state.sessionId = rec.sessionId;
    if (rec.kind === "subagent") state.isSub = true;
    touch(
      {
        project: state.cwd,
        title: typeof rec.summary === "string" && rec.summary ? rec.summary : null,
        client: "gemini-cli",
        parentSessionId: state.parentId ? `gemini:${state.parentId}` : null,
        agent: state.isSub ? "subagent" : null,
      },
      parseTs(rec.startTime),
    );
    for (const m of Array.isArray(rec.messages) ? rec.messages : []) record(m, ctx, state, sink, sessions);
    return;
  }
  if (!state.sessionId) return;
  if (rec.$set && typeof rec.$set === "object") {
    const set = rec.$set as Record<string, any>;
    if (typeof set.summary === "string" && set.summary) touch({ title: set.summary }, null);
    // An older way to write the whole history again.
    for (const m of Array.isArray(set.messages) ? set.messages : []) record(m, ctx, state, sink, sessions);
    return;
  }
  if (typeof rec.id !== "string" || typeof rec.type !== "string" || "$patch" in rec) return;

  const ts = parseTs(rec.timestamp);
  if (ts == null) return;
  const sessionId = sid();
  const agent = state.isSub ? "subagent" : "main";
  const start = state.lastTs;
  state.lastTs = ts;
  touch({}, ts);

  if (rec.type === "user") {
    const text = textOf(rec.displayContent ?? rec.content);
    // A subagent's first message is its brief from the parent, never a prompt of the user's.
    if (state.isSub) {
      if (!state.briefSeen && text) {
        touch({ brief: truncate(text, ctx.promptTextLimit) }, ts);
        state.briefSeen = true;
      }
      return;
    }
    if (!text?.trim()) return;
    state.promptId = `${sessionId}:${rec.id}`;
    sink.prompt({ id: state.promptId, sessionId, provider: "gemini", ts, text: truncate(text, ctx.promptTextLimit), skill: null, isCommand: /^\s*\/[\w:-]+/.test(text) });
    return;
  }
  if (rec.type === "info" && CANCELLED_RE.test(textOf(rec.content) ?? "")) {
    sink.outcome?.({ id: `${sessionId}:${rec.id}:interrupt`, provider: "gemini", sessionId, ts, project: state.cwd, model: null, agent, kind: "interrupt" });
    return;
  }
  if (rec.type !== "gemini") return;

  const model = typeof rec.model === "string" ? rec.model : null;
  const usageId = `${sessionId}:${rec.id}`;
  for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
    if (typeof call?.id !== "string" || typeof call.name !== "string") continue;
    const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
    const path = [args.file_path, args.absolute_path, args.path].find((p) => typeof p === "string") as string | undefined;
    const id = `${sessionId}:${call.id}`;
    const at = parseTs(call.timestamp) ?? ts;
    sink.tool({ id, usageId, sessionId, promptId: state.promptId, provider: "gemini", ts: at, project: state.cwd, tool: call.name, filePath: FILE_TOOLS.has(call.name) ? (path ?? null) : null, skill: null, agent });
    const kind = call.status === "success" ? "tool_ok" : call.status === "error" ? "tool_error" : call.status === "cancelled" ? "tool_rejected" : null;
    if (!kind) continue; // still running: its outcome comes with a later copy
    sink.outcome?.({
      id,
      provider: "gemini",
      sessionId,
      ts: at,
      project: state.cwd,
      model,
      agent,
      kind,
      ...failureOf(kind, call.name, kind === "tool_ok" ? "" : resultText(call), inputSummary(args, ctx.promptTextLimit), ctx.promptTextLimit),
    });
  }

  const t = rec.tokens;
  if (!t || typeof t !== "object") return;
  const cached = num(t.cached);
  const thoughts = num(t.thoughts);
  sink.usage({
    id: usageId,
    provider: "gemini",
    sessionId,
    promptId: state.promptId,
    ts,
    project: state.cwd,
    model,
    skill: null,
    agent,
    isSubagent: state.isSub,
    // Input net of the cached part, with the tool-use prompt on top. Output includes the thoughts, like the usage table.
    input: Math.max(0, num(t.input) - cached) + num(t.tool),
    output: num(t.output) + thoughts,
    cacheRead: cached,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: thoughts,
  });
  sink.responseMeta?.({ usageId, startTs: start, endTs: ts });
}

export const geminiParser: LineParser<GeminiState> = {
  initialState,

  parse(lines, ctx: FileContext, state, sink) {
    const sessions = new SessionAccumulator();
    for (const { text } of lines) {
      let rec: Record<string, any>;
      try {
        rec = JSON.parse(text);
      } catch {
        continue;
      }
      if (rec && typeof rec === "object") record(rec, ctx, state, sink, sessions);
    }
    sessions.flush(sink);
    return state;
  },
};

/** Reads a chat in the older format: one JSON object, read whole whenever it changes. */
export function ingestGeminiJson(path: string, sink: IngestSink, opts: { promptTextLimit: number }): void {
  let doc: any;
  try {
    doc = JSON.parse(readText(path) ?? "null");
  } catch {
    return; // caught while being rewritten: read again once it changes
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  const sessions = new SessionAccumulator();
  record(doc, opts, initialState(path), sink, sessions);
  sessions.flush(sink);
}
