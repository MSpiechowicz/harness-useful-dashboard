import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type IngestSink, num, parseTs, truncate } from "./types.ts";

/**
 * Zed's own agent keeps its threads in SQLite: <data dir>/threads/threads.db (~/.local/share/zed on Linux,
 * ~/Library/Application Support/Zed on macOS, %LOCALAPPDATA%\Zed on Windows). One row per thread, its `data` a JSON
 * document, zstd-compressed in current versions (`data_type` "zstd", older rows "json"):
 *  - version "0.3.0": messages tagged {"User": …} / {"Agent": …}, the thread's model, and cumulative_token_usage, the
 *    sum of every model call the thread made (tool loops, retries, summaries)
 *  - "0.2.0" / "0.1.0": messages with a role, segments, tool_uses and tool_results lists
 * Zed records no time per message or per model call, only when the thread was created and last updated, so a thread
 * is one usage row, dated when it started. Its token counts grow as the thread goes on and the row keeps the largest.
 * Threads that ran other agents (Claude Code, Codex) through Zed are in those agents' own logs, read as theirs.
 */

/** The threads database in a Zed data folder. */
export function zedDatabases(dir: string): string[] {
  const path = join(dir, "threads", "threads.db");
  return existsSync(path) ? [path] : [];
}

/** Rows updated a little before the last read are read again: a write in progress then may have been half-seen. */
const OVERLAP_MS = 5 * 60_000;

interface ThreadRow {
  id: string;
  summary: string | null;
  updated_at: string;
  data_type: string;
  data: Uint8Array | string;
  parent_id: string | null;
  folder_paths: string | null;
  created_at: string | null;
}

const zed = (id: string) => `zed:${id}`;

function decode(row: ThreadRow): Record<string, any> | null {
  try {
    const bytes = typeof row.data === "string" ? new TextEncoder().encode(row.data) : row.data;
    const text = new TextDecoder().decode(row.data_type === "zstd" ? Bun.zstdDecompressSync(bytes) : bytes);
    const doc = JSON.parse(text);
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/** Text of a message's content: [{"Text": "…"}, {"Mention": …}, …] in 0.3.0, segments in older versions. */
function textOf(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((c: any) => (typeof c?.Text === "string" ? c.Text : c?.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

interface Turn {
  role: "user" | "agent";
  id: string | null;
  text: string;
  tools: { id: string; name: string }[];
  results: { id: string; isError: boolean }[];
}

/** Every message as a user prompt or an agent reply with its tool calls and their results, whatever the version. */
function turnsOf(doc: Record<string, any>): Turn[] {
  const messages: any[] = Array.isArray(doc.messages) ? doc.messages : [];
  const turns: Turn[] = [];
  for (const [i, m] of messages.entries()) {
    if (m?.User) {
      turns.push({ role: "user", id: typeof m.User.id === "string" ? m.User.id : String(i), text: textOf(m.User.content), tools: [], results: [] });
    } else if (m?.Agent) {
      const content: any[] = Array.isArray(m.Agent.content) ? m.Agent.content : [];
      const tools = content.filter((c) => c?.ToolUse?.id && c.ToolUse.name).map((c) => ({ id: String(c.ToolUse.id), name: String(c.ToolUse.name) }));
      const results = Object.values((m.Agent.tool_results ?? {}) as Record<string, any>).map((r) => ({ id: String(r?.tool_use_id), isError: r?.is_error === true }));
      turns.push({ role: "agent", id: null, text: "", tools, results });
    } else if (typeof m?.role === "string") {
      // 0.1.0 / 0.2.0. In 0.1.0 a tool's results sit on the user message after the call.
      const tools = (Array.isArray(m.tool_uses) ? m.tool_uses : []).filter((t: any) => t?.id && t.name).map((t: any) => ({ id: String(t.id), name: String(t.name) }));
      const results = (Array.isArray(m.tool_results) ? m.tool_results : []).map((r: any) => ({ id: String(r?.tool_use_id), isError: r?.is_error === true }));
      const user = m.role === "user" && !m.is_hidden;
      turns.push({ role: user ? "user" : "agent", id: user ? String(m.id ?? i) : null, text: user ? textOf(m.segments) || (typeof m.text === "string" ? m.text : "") : "", tools, results });
    }
  }
  return turns;
}

/**
 * Reads the threads updated since `since` (epoch ms, 0 for everything) from one Zed database into the sink. Returns
 * the latest update time seen, to start from next time.
 */
export function ingestZed(path: string, sink: IngestSink, opts: { since: number; promptTextLimit: number }): number {
  const src = new Database(path, { readonly: true });
  try {
    src.exec("PRAGMA busy_timeout = 5000");
    const columns = new Set(src.query<{ name: string }, []>("PRAGMA table_info(threads)").all().map((c) => c.name));
    const optional = (col: string) => (columns.has(col) ? col : `NULL AS ${col}`);
    const rows = src
      .query<ThreadRow, []>(
        `SELECT id, summary, updated_at, data_type, data, ${optional("parent_id")}, ${optional("folder_paths")}, ${optional("created_at")} FROM threads`,
      )
      .all();
    let latest = opts.since;

    for (const row of rows) {
      const updated = parseTs(row.updated_at);
      if (updated == null || updated < opts.since - OVERLAP_MS) continue;
      latest = Math.max(latest, updated);
      const doc = decode(row);
      if (!doc) continue;

      const started = parseTs(row.created_at) ?? updated;
      const sessionId = zed(row.id);
      const parent = row.parent_id ?? doc.subagent_context?.parent_thread_id ?? null;
      const isSub = parent != null;
      const agent = isSub ? "subagent" : "main";
      const project = row.folder_paths?.split("\n").find((p) => p.trim()) ?? null;
      const model = typeof doc.model?.model === "string" ? doc.model.model : null;

      sink.session({
        id: sessionId,
        provider: "zed",
        nativeId: row.id,
        project,
        title: typeof doc.title === "string" && doc.title ? doc.title : row.summary,
        client: "zed",
        parentSessionId: parent ? zed(parent) : null,
        agent: isSub ? agent : null,
        startedAt: started,
        endedAt: updated,
      });

      // Messages carry no time: prompts keep their order a millisecond apart from the thread's start.
      let promptId: string | null = null;
      let firstPrompt: string | null = null;
      for (const [i, turn] of turnsOf(doc).entries()) {
        const ts = started + i;
        if (turn.role === "user" && !isSub && turn.text.trim()) {
          promptId = `${sessionId}:${turn.id}`;
          firstPrompt ??= promptId;
          sink.prompt({
            id: promptId,
            sessionId,
            provider: "zed",
            ts,
            text: truncate(turn.text, opts.promptTextLimit),
            skill: null,
            isCommand: /^\s*\/[\w:-]+/.test(turn.text),
          });
        }
        for (const t of turn.tools) {
          sink.tool({ id: zed(t.id), usageId: sessionId, sessionId, promptId, provider: "zed", ts, project, tool: t.name, filePath: null, skill: null, agent });
        }
        for (const r of turn.results) {
          sink.outcome?.({ id: zed(r.id), provider: "zed", sessionId, ts, project, model, agent, kind: r.isError ? "tool_error" : "tool_ok" });
        }
      }

      // Zed doesn't split a thread's usage by prompt: it counts toward the thread's first one.
      const u = doc.cumulative_token_usage ?? {};
      sink.usage({
        id: sessionId,
        provider: "zed",
        sessionId,
        promptId: firstPrompt,
        ts: started,
        project,
        model,
        skill: null,
        agent,
        isSubagent: isSub,
        // Net of cache reads and writes, as every provider Zed talks to reports it.
        input: num(u.input_tokens),
        output: num(u.output_tokens),
        cacheRead: num(u.cache_read_input_tokens),
        cacheWrite: num(u.cache_creation_input_tokens),
        cacheWrite1h: 0,
        reasoning: 0,
        speed: typeof doc.speed === "string" ? doc.speed : null,
        billing: typeof doc.model?.provider === "string" ? doc.model.provider : null,
      });
      if (typeof doc.thinking_effort === "string") sink.responseMeta?.({ usageId: sessionId, startTs: null, endTs: null, effort: doc.thinking_effort });
    }
    return latest;
  } finally {
    src.close();
  }
}
