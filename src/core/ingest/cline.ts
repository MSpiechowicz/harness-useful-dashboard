import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { apiErrorOf } from "../apiErrors.ts";
import { failureOf, inputSummary } from "../failures.ts";
import { countLines, type LineCount, searchReplaceLines, unifiedDiffLines } from "./lines.ts";
import type { OpencodeFlavor } from "./opencode.ts";
import { type IngestSink, num, type Provider, truncate } from "./types.ts";

/**
 * Cline and its forks Roo Code and Kilo Code, each a provider of its own ("cline", "roo", "kilo"), in three formats
 * depending on the version:
 *  - Task folders (Cline up to 3.x, every Roo Code, Kilo Code up to 5.x): tasks/<id>/ui_messages.json, the task as the
 *    extension showed it, with an "api_req_started" message per model call carrying its tokens and cost. In VS Code
 *    (and its forks) under <globalStorage>/<extension id>/, for Cline's CLI under ~/.cline/data.
 *  - Cline 4's session store (~/.cline/data): sessions/<id>/<id>.messages.json, each assistant message with the
 *    model, tokens and cost of its turn, and db/sessions.db with the folder each session worked in.
 *  - Kilo Code 7 (~/.local/share/kilo/kilo.db): OpenCode's schema, read by the OpenCode reader (KILO below).
 * A configured folder can be an extension's own folder in globalStorage, a whole globalStorage folder, or one of the
 * extensions' data folders: findClineSources works out which.
 * The extensions price every call themselves (from the provider's bill when it reports one), and Roo and Kilo don't
 * record which model answered, so their cost is used as it is.
 */

export type ClineFamily = "cline" | "roo" | "kilo";

/** Each extension's folders in globalStorage (Roo Code's id changed over time), and the client it is. */
export const CLINE_EXTENSIONS: Record<ClineFamily, { ids: string[]; client: string }> = {
  cline: { ids: ["saoudrizwan.claude-dev"], client: "cline" },
  roo: { ids: ["rooveterinaryinc.roo-cline", "rooveterinaryinc.roo-code", "rooveterinaryinc.roo-code-nightly", "roovscode.roo-cline", "roovscode.roo-code"], client: "roo-code" },
  kilo: { ids: ["kilocode.kilo-code"], client: "kilo-code" },
};

export const KILO: OpencodeFlavor = { provider: "kilo", prefix: "kilo", client: "kilo-code", reportedCost: true };

export interface ClineTask {
  /** The task's folder: tasks/<id>. */
  dir: string;
  provider: ClineFamily;
  client: string;
  /** What the extension's own task list knows about it: the folder it worked in, its parent task, its title. */
  info: TaskInfo | undefined;
}

interface TaskInfo {
  cwd: string | null;
  parent: string | null;
  title: string | null;
}

export interface ClineSources {
  tasks: ClineTask[];
  /** Cline 4 data folders (with sessions/ and db/sessions.db). */
  sessionRoots: string[];
  /** Kilo Code 7 databases. */
  kiloDatabases: string[];
}

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** The task list an extension keeps: in VS Code's state database for the editor, or in its own files. */
function taskIndex(storage: string, extension: string | null): Map<string, TaskInfo> {
  const out = new Map<string, TaskInfo>();
  const add = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const h of items) {
      if (!h || typeof h.id !== "string") continue;
      out.set(h.id, {
        cwd: h.cwdOnTaskInitialization ?? h.workspace ?? null,
        parent: h.parentTaskId ?? null,
        title: typeof h.task === "string" ? h.task : null,
      });
    }
  };
  if (extension) {
    // <globalStorage>/state.vscdb: one JSON value per extension, with its taskHistory.
    const vscdb = join(storage, "state.vscdb");
    if (existsSync(vscdb)) {
      try {
        const db = new Database(vscdb, { readonly: true });
        try {
          const row = db.query<{ value: string }, [string]>("SELECT value FROM ItemTable WHERE lower(key) = lower(?)").get(extension);
          if (row) add(JSON.parse(row.value)?.taskHistory);
        } finally {
          db.close();
        }
      } catch {
        /* locked or another layout: the task folders still have the usage */
      }
    }
  }
  const root = extension ? join(storage, extension) : storage;
  add(readJson(join(root, "state", "taskHistory.json")));
  add(readJson(join(root, "tasks", "_index.json"))?.entries);
  return out;
}

/** What a configured folder holds for one extension: its folder in globalStorage, a whole globalStorage folder (its
 *  folder inside), its own data folder (Cline's ~/.cline/data, a custom storage path), Kilo Code 7's database. */
export function findClineSources(dir: string, family: ClineFamily): ClineSources {
  const found: ClineSources = { tasks: [], sessionRoots: [], kiloDatabases: [] };
  if (!existsSync(dir)) return found;
  const { ids, client } = CLINE_EXTENSIONS[family];
  const addTasks = (root: string, storage: string, extension: string | null) => {
    const tasksDir = join(root, "tasks");
    if (!existsSync(tasksDir)) return;
    const index = taskIndex(storage, extension);
    for (const id of subdirs(tasksDir)) {
      const taskDir = join(tasksDir, id);
      if (existsSync(join(taskDir, "ui_messages.json"))) found.tasks.push({ dir: taskDir, provider: family, client, info: index.get(id) });
    }
  };
  const name = basename(dir).toLowerCase();
  if (ids.includes(name)) addTasks(dir, join(dir, ".."), name);
  else {
    for (const id of ids) addTasks(join(dir, id), dir, id);
    addTasks(dir, dir, null);
  }
  if (family === "cline" && existsSync(join(dir, "sessions")) && existsSync(join(dir, "db", "sessions.db"))) found.sessionRoots.push(dir);
  if (family === "kilo") {
    try {
      for (const f of readdirSync(dir)) if (/^kilo(-[\w.-]+)?\.db$/.test(f)) found.kiloDatabases.push(join(dir, f));
    } catch {
      /* unreadable folder */
    }
  }
  return found;
}

/** Input tokens net of cache reads and writes: Roo and Kilo (since late 2025) and some providers report them with. */
export function netInput(tokensIn: number, cacheReads: number, cacheWrites: number): number {
  const cache = cacheReads + cacheWrites;
  return cache > 0 && tokensIn >= cache ? tokensIn - cache : tokensIn;
}


/** The model in use at a time: from model changes Cline logs, or the <model> Roo and Kilo tell the model it is. */
function modelTimeline(taskDir: string): { ts: number; model: string }[] {
  const out: { ts: number; model: string }[] = [];
  const meta = readJson(join(taskDir, "task_metadata.json"));
  for (const u of Array.isArray(meta?.model_usage) ? meta.model_usage : []) {
    if (typeof u?.model_id === "string") out.push({ ts: num(u.ts), model: u.model_id });
  }
  if (out.length) return out.sort((a, b) => a.ts - b.ts);
  const history = readJson(join(taskDir, "api_conversation_history.json"));
  for (const m of Array.isArray(history) ? history : []) {
    if (m?.role !== "user") continue;
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: any) => c?.text ?? "").join("\n") : "";
    const model = /<model>([^<]+)<\/model>/.exec(text)?.[1]?.trim();
    if (model) out.push({ ts: num(m.ts), model });
  }
  return out;
}

const modelAt = (timeline: { ts: number; model: string }[], ts: number) => {
  let model: string | null = null;
  for (const t of timeline) if (t.ts <= ts || !t.ts) model = t.model;
  return model ?? timeline[0]?.model ?? null;
};

/** Reads one task folder (ui_messages.json, whole: the extension rewrites it as the task goes on). */
export function ingestClineTask(task: ClineTask, sink: IngestSink, opts: { promptTextLimit: number }): number {
  const messages = readJson(join(task.dir, "ui_messages.json"));
  if (!Array.isArray(messages) || !messages.length) return 0;
  const taskId = basename(task.dir);
  const provider: Provider = task.provider;
  const cl = (id: string) => `${provider}:${id}`;
  const sessionId = cl(taskId);
  const project = task.info?.cwd ?? null;
  const parent = task.info?.parent ?? null;
  const agent = parent ? "subtask" : "main";
  const timeline = modelTimeline(task.dir);
  const first = messages.find((m) => typeof m?.ts === "number")?.ts ?? null;
  const last = [...messages].reverse().find((m) => typeof m?.ts === "number")?.ts ?? first;
  let promptId: string | null = null;
  let rows = 0;
  let firstText: string | null = null;

  for (const [i, m] of messages.entries()) {
    const ts = typeof m?.ts === "number" ? m.ts : null;
    if (ts == null) continue;
    // The task itself (Cline: say "task", Roo and Kilo: the first say "text"), then the user's follow-ups.
    const isPrompt = m.type === "say" && (m.say === "task" || m.say === "user_feedback" || (i === 0 && m.say === "text"));
    if (isPrompt && typeof m.text === "string" && m.text.trim() && !parent) {
      promptId = `${sessionId}:${ts}`;
      firstText ??= m.text;
      sink.prompt({ id: promptId, sessionId, provider, ts, text: truncate(m.text, opts.promptTextLimit), skill: null, isCommand: false });
      continue;
    }
    if (m.type === "say" && (m.say === "api_req_started" || m.say === "deleted_api_reqs" || m.say === "subagent_usage")) {
      let info: Record<string, any>;
      try {
        info = JSON.parse(m.text ?? "{}");
      } catch {
        continue;
      }
      // A call still under way has neither its cost nor a reason it stopped: it is read again once it's done.
      if (m.say === "api_req_started" && info.cost == null && info.cancelReason == null) continue;
      const cacheReads = num(info.cacheReads);
      const cacheWrites = num(info.cacheWrites);
      const usageId = `${sessionId}:${ts}${m.say === "api_req_started" ? "" : `:${m.say}`}`;
      sink.usage({
        id: usageId,
        provider,
        sessionId,
        promptId,
        ts,
        project,
        model: m.modelInfo?.modelId ?? modelAt(timeline, ts),
        skill: null,
        agent,
        isSubagent: parent != null,
        input: netInput(num(info.tokensIn), cacheReads, cacheWrites),
        output: num(info.tokensOut),
        cacheRead: cacheReads,
        cacheWrite: cacheWrites,
        cacheWrite1h: 0,
        reasoning: 0,
        costUsd: typeof info.cost === "number" ? info.cost : null,
        billing: typeof m.modelInfo?.providerId === "string" ? m.modelInfo.providerId : null,
      });
      rows++;
      if (info.cancelReason === "user_cancelled") {
        sink.outcome?.({ id: `${usageId}:interrupt`, provider, sessionId, ts, project, model: m.modelInfo?.modelId ?? modelAt(timeline, ts), agent, kind: "interrupt" });
      }
      continue;
    }
    // A model call that failed: the extension asks whether to retry, with the provider's error as the text.
    if (m.type === "ask" && m.ask === "api_req_failed") {
      sink.outcome?.({
        id: `${sessionId}:${ts}:api`,
        provider,
        sessionId,
        ts,
        project,
        model: m.modelInfo?.modelId ?? modelAt(timeline, ts),
        agent,
        ...apiErrorOf(null, null, typeof m.text === "string" ? m.text : null, opts.promptTextLimit),
      });
      continue;
    }
    // Tool calls the user was asked to approve, or that ran on their own.
    if ((m.type === "ask" || m.type === "say") && (m.ask === "tool" || m.say === "tool" || m.ask === "command" || m.ask === "use_mcp_server")) {
      if (m.partial) continue;
      let tool = m.ask === "command" ? "execute_command" : m.ask === "use_mcp_server" ? "use_mcp_tool" : "tool";
      let filePath: string | null = null;
      let lines: LineCount | null = null;
      if (m.ask === "tool" || m.say === "tool") {
        try {
          const t = JSON.parse(m.text ?? "{}");
          if (typeof t.tool === "string") tool = t.tool;
          if (typeof t.path === "string") filePath = t.path;
          lines = clineEditLines(tool, t);
        } catch {
          /* not JSON: keep the generic name */
        }
      }
      sink.tool({
        id: `${sessionId}:${ts}:${m.type}`, usageId: null, sessionId, promptId, provider, ts, project, tool, filePath, skill: null, agent,
        linesAdded: lines?.added ?? null, linesRemoved: lines?.removed ?? null,
      });
    }
  }

  sink.session({
    id: sessionId,
    provider,
    nativeId: taskId,
    project,
    title: truncate(task.info?.title ?? firstText, opts.promptTextLimit > 0 ? 200 : 0),
    client: task.client,
    parentSessionId: parent ? cl(parent) : null,
    agent: parent ? agent : null,
    startedAt: first,
    endedAt: last,
  });
  return rows;
}

/** The last time a task folder was active, for telling Cline 4's copy of an older task from what came after it. */
export function taskLastTs(dir: string): number {
  const messages = readJson(join(dir, "ui_messages.json"));
  if (!Array.isArray(messages)) return 0;
  for (let i = messages.length - 1; i >= 0; i--) if (typeof messages[i]?.ts === "number") return messages[i].ts;
  return 0;
}

interface SessionRow {
  session_id: string;
  source: string | null;
  cwd: string | null;
  workspace_root: string | null;
  parent_session_id: string | null;
  is_subagent: number | null;
  metadata_json: string | null;
  started_at: string | null;
  ended_at: string | null;
}

/** Cline 4's sessions by id, with the folder each worked in and its title. */
export function clineSessionIndex(root: string): Map<string, SessionRow> {
  const out = new Map<string, SessionRow>();
  try {
    const db = new Database(join(root, "db", "sessions.db"), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      for (const r of db.query<SessionRow, []>("SELECT session_id, source, cwd, workspace_root, parent_session_id, is_subagent, metadata_json, started_at, ended_at FROM sessions").all()) {
        out.set(r.session_id, r);
      }
    } finally {
      db.close();
    }
  } catch {
    /* no index yet: the message files still have the usage */
  }
  return out;
}

/** The message files of Cline 4's sessions: the lead agent's, and one per subagent. */
export function clineSessionFiles(root: string): { sessionId: string; agentId: string | null; path: string }[] {
  const out: { sessionId: string; agentId: string | null; path: string }[] = [];
  const dir = join(root, "sessions");
  for (const id of subdirs(dir)) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, id)).filter((f) => f.endsWith(".messages.json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const agentId = f === `${id}.messages.json` ? null : f.slice(0, -".messages.json".length);
      out.push({ sessionId: id, agentId, path: join(dir, id, f) });
    }
  }
  return out;
}

/**
 * The lines an edit changes: a written file's content, or the SEARCH/REPLACE blocks (or unified diff) it applies. Cline
 * 4 names the tool it called (write_to_file, replace_in_file), the task folders the approval they asked for
 * (newFileCreated, editedExistingFile, appliedDiff).
 */
export function clineEditLines(tool: string, input: Record<string, any>): LineCount | null {
  switch (tool) {
    case "write_to_file":
    case "newFileCreated":
      return { added: countLines(input.content), removed: 0 };
    case "replace_in_file":
    case "editedExistingFile":
    case "appliedDiff":
      return searchReplaceLines(input.diff) ?? unifiedDiffLines(input.diff) ?? { added: 0, removed: 0 };
    default:
      return null;
  }
}

const USER_INPUT_RE = /^\s*<user_input[^>]*>([\s\S]*?)<\/user_input>\s*$/;

function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  if (content.some((c) => c?.type === "tool_result")) return null;
  const text = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text as string).join("\n");
  return text || null;
}

/**
 * Reads one Cline 4 message file. `legacyUntil` is when the same task last ran in the older format, whose calls were
 * counted from its task folder: they're skipped here.
 */
export function ingestClineSession(
  file: { sessionId: string; agentId: string | null; path: string },
  row: SessionRow | undefined,
  sink: IngestSink,
  opts: { promptTextLimit: number; legacyUntil: number },
): number {
  const doc = readJson(file.path);
  const messages: any[] = Array.isArray(doc?.messages) ? doc.messages : [];
  if (!messages.length) return 0;
  const meta = (() => {
    try {
      return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
    } catch {
      return {};
    }
  })();
  const cl = (id: string) => `cline:${id}`;
  const isSub = file.agentId != null || row?.is_subagent === 1;
  const sessionId = cl(file.agentId ? `${file.sessionId}:${file.agentId}` : file.sessionId);
  const parent = file.agentId ? cl(file.sessionId) : row?.parent_session_id ? cl(row.parent_session_id) : null;
  const agent = isSub ? (file.agentId ?? "subagent") : "main";
  const project = row?.workspace_root ?? row?.cwd ?? null;
  const times = messages.map((m) => num(m?.ts)).filter((t) => t > 0);
  const started = times.length ? Math.min(...times) : Date.parse(row?.started_at ?? "") || null;
  let promptId: string | null = null;
  let lastTs = started ?? 0;
  let rows = 0;
  let firstText: string | null = null;

  const calls = new Map<string, { name: string; input: unknown }>();
  for (const [i, m] of messages.entries()) {
    if (m?.metadata?.displayOnly) continue;
    // Messages without a time take the one before them, a millisecond on, so they keep their order.
    const ts = num(m?.ts) || lastTs + 1;
    lastTs = ts;
    if (m?.role === "user") {
      const raw = userText(m.content);
      if (raw != null && !isSub) {
        const text = USER_INPUT_RE.exec(raw)?.[1] ?? raw;
        if (text.trim()) {
          promptId = `${sessionId}:${m.id ?? i}`;
          firstText ??= text;
          sink.prompt({ id: promptId, sessionId, provider: "cline", ts, text: truncate(text, opts.promptTextLimit), skill: null, isCommand: /^\s*\/[\w:-]+/.test(text) });
        }
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c?.type !== "tool_result" || !c.tool_use_id) continue;
        const kind = c.is_error ? "tool_error" : "tool_ok";
        const call = calls.get(String(c.tool_use_id));
        const error = c.is_error ? (typeof c.content === "string" ? c.content : userText(c.content) ?? "") : "";
        sink.outcome?.({
          id: cl(String(c.tool_use_id)),
          provider: "cline",
          sessionId,
          ts,
          project,
          model: null,
          agent,
          kind,
          ...failureOf(kind, call?.name ?? null, error, inputSummary(call?.input, opts.promptTextLimit), opts.promptTextLimit),
        });
      }
      continue;
    }
    if (m?.role !== "assistant") continue;
    const model = typeof m.modelInfo?.id === "string" ? m.modelInfo.id : (meta.modelId ?? null);
    const usageId = `${sessionId}:${m.id ?? ts}`;
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c?.type !== "tool_use" || !c.id || !c.name) continue;
      const input = c.input ?? {};
      calls.set(String(c.id), { name: String(c.name), input });
      const path = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : null;
      const lines = clineEditLines(String(c.name), input);
      sink.tool({
        id: cl(String(c.id)), usageId, sessionId, promptId, provider: "cline", ts, project, tool: String(c.name), filePath: path, skill: null, agent, model,
        linesAdded: lines?.added ?? null, linesRemoved: lines?.removed ?? null,
      });
    }
    const x = m.metrics;
    if (!x || ts <= opts.legacyUntil) continue;
    const cacheRead = num(x.cacheReadTokens);
    const cacheWrite = num(x.cacheWriteTokens);
    sink.usage({
      id: usageId,
      provider: "cline",
      sessionId,
      promptId,
      ts,
      project,
      model,
      skill: null,
      agent,
      isSubagent: isSub,
      // Cline 4 counts cache reads and writes in its input.
      input: Math.max(0, num(x.inputTokens) - cacheRead - cacheWrite),
      output: num(x.outputTokens),
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      reasoning: num(x.reasoningTokenCount),
      costUsd: typeof x.cost === "number" ? x.cost : null,
      billing: typeof m.modelInfo?.provider === "string" ? m.modelInfo.provider : null,
    });
    rows++;
  }

  sink.session({
    id: sessionId,
    provider: "cline",
    nativeId: file.agentId ? `${file.sessionId}:${file.agentId}` : file.sessionId,
    project,
    // The session's title is the lead agent's: a subagent is named after itself.
    title: file.agentId ?? truncate((typeof meta.title === "string" && meta.title) || firstText, opts.promptTextLimit > 0 ? 200 : 0),
    client: "cline",
    clientVersion: null,
    parentSessionId: parent,
    agent: isSub ? agent : null,
    startedAt: started,
    endedAt: lastTs || started,
  });
  return rows;
}

/** Size and change time of a file, to skip it while it hasn't changed. */
export function fileStamp(path: string): { size: number; mtime: number } | null {
  try {
    const st = statSync(path);
    return { size: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}
