import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileToolId, filePromptId, fileUsageId, safePart, sessionId as chatSessionId, toolIdIn } from "./copilotChatIds.ts";
import { countLines, diffLines, type LineCount, patchLines } from "./lines.ts";
import { type IngestSink, num, truncate } from "./types.ts";

/**
 * GitHub Copilot Chat in VS Code (and its forks) keeps each chat session as a log of changes:
 * <user folder>/workspaceStorage/<hash>/chatSessions/<session>.jsonl for a folder or workspace window (the folder's
 * workspace.json names it), <user folder>/globalStorage/emptyWindowChatSessions/<session>.jsonl for a window without one.
 * Replaying the log gives the session as the chat view had it. Per request it holds the output tokens of the whole
 * request but the input tokens of its last model call only, so its usage row is partial: the telemetry
 * (OpenTelemetry spans) has every call, and replaces the row of a request it covers.
 */

/** A session file bigger than this is not read (it is read whole). */
export const MAX_CHAT_FILE_BYTES = 64 * 1024 * 1024;

/**
 * VS Code stamps a request done a moment before its last model call's span ends (tens of milliseconds in practice): the
 * telemetry of a request may reach this far past the end the chat session file gives it.
 */
export const REPLACE_SLACK_MS = 5_000;

const GITHUB_COPILOT = "github-copilot";

export interface CopilotChatFile {
  path: string;
  /** The local folder the window had open, if any. */
  project: string | null;
}

/** A workspace.json is a few lines: anything bigger, or no regular file (a pipe would block the read), is no workspace. */
const MAX_WORKSPACE_JSON_BYTES = 64 * 1024;

const readJson = (path: string): any => {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_WORKSPACE_JSON_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

const jsonlFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".jsonl")).map((d) => join(dir, d.name));
  } catch {
    return [];
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** A local path from a file:// URI, else null (remote windows, other schemes). */
function localPath(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "file:" || url.hostname) return null;

  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  // A Windows drive: /c:/Users/me becomes C:\Users\me.
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}:${(drive[2] ?? "\\").replace(/\//g, "\\")}`;
  return path;
}

/** The folder a window had open: its "folder", else the folder of its .code-workspace file. */
export function workspaceProject(workspaceJson: unknown): string | null {
  if (!isObject(workspaceJson)) return null;
  if (workspaceJson.folder != null) return localPath(workspaceJson.folder);

  const file = localPath(workspaceJson.workspace);
  if (!file) return null;

  const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  if (cut < 0) return null;
  if (cut === 0) return file.slice(0, 1);

  const dir = file.slice(0, cut);
  return /^[A-Z]:$/.test(dir) ? `${dir}\\` : dir;
}

/** The chat session files of one VS Code user folder. */
export function findCopilotChatFiles(userDir: string): CopilotChatFile[] {
  if (!existsSync(userDir)) return [];
  const out: CopilotChatFile[] = [];

  const storage = join(userDir, "workspaceStorage");
  for (const hash of subdirs(storage)) {
    const files = jsonlFiles(join(storage, hash, "chatSessions"));
    if (!files.length) continue;

    const project = workspaceProject(readJson(join(storage, hash, "workspace.json")));
    for (const path of files) out.push({ path, project });
  }

  for (const path of jsonlFiles(join(userDir, "globalStorage", "emptyWindowChatSessions"))) out.push({ path, project: null });
  return out;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The container a path leads to, without its last element; null where the path does not fit the state. */
function parentAt(root: unknown, path: unknown[]): Record<string, any> | any[] | null {
  let node: any = root;
  for (const key of path.slice(0, -1)) {
    node = child(node, key);
    if (typeof node !== "object" || node === null) return null;
  }
  return node;
}

function child(node: any, key: unknown): unknown {
  if (Array.isArray(node)) return Number.isInteger(key) && (key as number) >= 0 ? node[key as number] : undefined;
  if (isObject(node) && typeof key === "string" && !UNSAFE_KEYS.has(key)) return Object.hasOwn(node, key) ? node[key] : undefined;
  return undefined;
}

const validPath = (k: unknown): k is (string | number)[] =>
  Array.isArray(k) && k.length > 0 && k.every((e) => (typeof e === "string" && !UNSAFE_KEYS.has(e)) || (Number.isInteger(e) && (e as number) >= 0));

function setAt(state: unknown, path: (string | number)[], value: unknown): void {
  const parent = parentAt(state, path);
  const last = path[path.length - 1]!;

  if (Array.isArray(parent)) {
    if (typeof last === "number" && last <= parent.length) parent[last] = value;
  } else if (parent && typeof last === "string") {
    parent[last] = value;
  }
}

function appendAt(state: unknown, path: (string | number)[], items: unknown[], length: number | null): void {
  const parent = parentAt(state, path);
  const last = path[path.length - 1]!;
  const target = parent ? child(parent, last) : undefined;

  if (Array.isArray(target)) {
    // An edit of the chat cuts the list back first (a message sent again), then adds to it.
    if (length != null && length < target.length) target.length = length;
    for (const item of items) target.push(item);
    return;
  }

  // A list that was not there yet starts with these items.
  if (target !== undefined || !items.length) return;
  if (Array.isArray(parent)) {
    if (typeof last === "number" && last <= parent.length) parent[last] = [...items];
  } else if (parent && typeof last === "string") {
    parent[last] = [...items];
  }
}

/** A value removed: a list's element is left undefined (the list keeps its length), an object's key goes. */
function deleteAt(state: unknown, path: (string | number)[]): void {
  const parent = parentAt(state, path);
  const last = path[path.length - 1]!;

  if (Array.isArray(parent)) {
    if (typeof last === "number" && last < parent.length) parent[last] = undefined;
  } else if (parent && typeof last === "string" && Object.hasOwn(parent, last)) {
    delete parent[last];
  }
}

/**
 * Replays a session file: a snapshot (kind 0), values set at a path (1), items appended to a list (2, after cutting the
 * list to length `i` if it has one: no items then is a plain cut), a value removed (3).
 */
export function replayChatSession(text: string): Record<string, any> | null {
  let state: Record<string, any> | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      // The last line is cut off while the file is being written.
      continue;
    }
    if (!isObject(entry)) continue;

    if (entry.kind === 0) {
      if (isObject(entry.v)) state = entry.v;
      continue;
    }
    if (!state || !validPath(entry.k)) continue;

    if (entry.kind === 1) setAt(state, entry.k, entry.v);
    else if (entry.kind === 2) {
      const length = Number.isInteger(entry.i) && entry.i >= 0 ? (entry.i as number) : null;
      if (entry.v === undefined && length != null) appendAt(state, entry.k, [], length);
      else if (Array.isArray(entry.v)) appendAt(state, entry.k, entry.v, length);
    } else if (entry.kind === 3) deleteAt(state, entry.k);
  }
  return state;
}

/** A model name worth keeping: "auto" is the picker's choice, not the model that answered. */
function realModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim();
  if (!name || name === "auto" || name === "copilot/auto") return null;
  return name;
}

function modelOf(request: Record<string, any>): string | null {
  const resolved = realModel(request.result?.metadata?.resolvedModel);
  if (resolved) return resolved;

  const rounds = request.result?.metadata?.toolCallRounds;
  if (!Array.isArray(rounds)) return null;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const model = realModel(rounds[i]?.modelId);
    if (model) return model;
  }
  return null;
}

/** The tool call id the telemetry has too: the file adds "__vscode-<n>" to it. */
export const callIdOf = (id: unknown): string => (typeof id === "string" ? id.replace(/__vscode-\d+$/, "") : "");

const FILE_PATH_TOOLS = new Set(["read_file", "create_file", "replace_string_in_file", "insert_edit_into_file", "edit_notebook_file"]);

function parseArguments(raw: unknown): Record<string, any> {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/m;

function filePathOf(tool: string, args: Record<string, any>): string | null {
  if (tool === "apply_patch") return typeof args.input === "string" ? (PATCH_FILE_RE.exec(args.input)?.[1] ?? null) : null;
  if (tool === "multi_replace_string_in_file") {
    const first = Array.isArray(args.replacements) ? args.replacements[0] : null;
    return typeof first?.filePath === "string" ? first.filePath : null;
  }
  if (!FILE_PATH_TOOLS.has(tool)) return null;
  if (typeof args.filePath === "string") return args.filePath;
  if (typeof args.path === "string") return args.path;
  return null;
}

function editLines(tool: string, args: Record<string, any>): LineCount | null {
  if (tool === "replace_string_in_file") return diffLines(args.oldString, args.newString);
  if (tool === "create_file") return { added: countLines(args.content), removed: 0 };
  if (tool === "apply_patch") return patchLines(args.input);
  return null;
}

/** A request's own model calls, the latest date the file has in it: the end of a request that has no total time. */
function lastDate(request: Record<string, any>): number {
  let last = num(request.modelState?.completedAt);

  const rounds = request.result?.metadata?.toolCallRounds;
  if (Array.isArray(rounds)) for (const round of rounds) last = Math.max(last, num(round?.timestamp));
  return last;
}

/**
 * Reads one chat session file whole (it is rewritten as the chat goes on). Returns the usage rows written.
 *
 * A request is done at its start plus its total time, else at the latest date the file has in it, else not known. That
 * interval ("response_meta" of the partial row) is what the telemetry's model calls are matched to (otlp/write.ts),
 * and the window in which a complete row of the telemetry means the request is read already: its partial row, and
 * the tool calls the telemetry has, are not written, and one left from before goes.
 */
export function ingestCopilotChatFile(file: CopilotChatFile, sink: IngestSink, opts: { promptTextLimit: number }): number {
  const size = statSync(file.path).size;
  if (size > MAX_CHAT_FILE_BYTES) throw new Error(`chat session file too large (${Math.round(size / 1024 / 1024)} MB, limit ${MAX_CHAT_FILE_BYTES / 1024 / 1024} MB)`);

  const state = replayChatSession(readFileSync(file.path, "utf8"));
  if (!state) return 0;

  const nativeId = typeof state.sessionId === "string" && state.sessionId ? state.sessionId : basename(file.path, ".jsonl");
  const sessionId = chatSessionId(nativeId);
  const project = file.project;

  const requests: Record<string, any>[] = (Array.isArray(state.requests) ? state.requests : []).filter(
    (r: any) => isObject(r) && typeof r.requestId === "string" && r.requestId && typeof r.timestamp === "number" && Number.isFinite(r.timestamp),
  );

  // What was read of requests the file no longer holds goes.
  if (Array.isArray(state.requests)) sink.dropRequests?.(sessionId, new Set(requests.map((r) => safePart(r.requestId))));
  if (!requests.length) return 0;

  // A request's window runs to the next request's start, or to its own end if that is sooner.
  const starts = [...new Set(requests.map((r) => r.timestamp as number))].sort((a, b) => a - b);
  const nextStart = new Map<number, number>();
  for (let i = 0; i + 1 < starts.length; i++) nextStart.set(starts[i]!, starts[i + 1]!);

  let rows = 0;
  let firstText: string | null = null;
  let endedAt = 0;

  for (const request of requests) {
    const ts = request.timestamp as number;
    const promptText = typeof request.message?.text === "string" ? request.message.text : "";

    const elapsed = request.result?.timings?.totalElapsed;
    const stamp = lastDate(request);
    const doneAt = typeof elapsed === "number" && Number.isFinite(elapsed) && elapsed >= 0 ? ts + elapsed : stamp > 0 ? stamp : null;

    // Not past its own end (plus what the telemetry runs over): a request just begun is no part of this one.
    const next = nextStart.get(ts) ?? Number.POSITIVE_INFINITY;
    const to = doneAt != null ? Math.min(next, doneAt + REPLACE_SLACK_MS + 1) : next;
    const replaced = sink.covered?.(sessionId, ts, to) ?? false;

    let promptId: string | null = null;
    if (promptText.trim()) {
      promptId = filePromptId(nativeId, request.requestId);
      firstText ??= promptText;
      sink.prompt({ id: promptId, sessionId, provider: "copilot-chat", ts, text: truncate(promptText, opts.promptTextLimit), skill: null, isCommand: /^\s*\/[\w:-]+/.test(promptText) });

      // The telemetry's calls of this request came without its prompt: the cost of a prompt is its calls'.
      sink.linkPrompt?.(sessionId, promptId, ts, to);
    }

    const model = modelOf(request);
    const input = num(request.promptTokens);
    const output = num(request.completionTokens);
    const writesUsage = !replaced && (input > 0 || output > 0);
    const usageId = fileUsageId(nativeId, request.requestId);
    const credits = typeof request.copilotCredits === "number" && Number.isFinite(request.copilotCredits) && request.copilotCredits >= 0 ? request.copilotCredits : 0;

    endedAt = Math.max(endedAt, ts, num(request.responseTimestamp), stamp);

    if (writesUsage) {
      sink.usage({
        id: usageId,
        provider: "copilot-chat",
        sessionId,
        promptId,
        ts,
        project,
        model,
        skill: null,
        agent: "main",
        isSubagent: false,
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        costUsd: null,
        billing: GITHUB_COPILOT,
        credits,
        partial: true,
      });
      rows++;
    }

    if (writesUsage || replaced) {
      // The request's interval. A request the telemetry covers keeps it with no usage row: later calls of the request
      // that arrive after this reading find their request (and its prompt) by it.
      sink.responseMeta?.({ usageId, startTs: ts, endTs: doneAt });
    }
    if (replaced) {
      sink.dropPartial?.(usageId);
      continue;
    }

    const rounds = request.result?.metadata?.toolCallRounds;
    for (const [r, round] of (Array.isArray(rounds) ? rounds : []).entries()) {
      const roundTs = num(round?.timestamp) || ts;
      endedAt = Math.max(endedAt, roundTs);

      for (const [i, call] of (Array.isArray(round?.toolCalls) ? round.toolCalls : []).entries()) {
        if (typeof call?.name !== "string" || !call.name) continue;
        const callId = callIdOf(call.id);
        const args = parseArguments(call.arguments);
        const lines = editLines(call.name, args);

        sink.tool({
          id: callId ? toolIdIn(sessionId, callId, "") : fileToolId(nativeId, request.requestId, r, i),
          usageId: writesUsage ? usageId : null,
          sessionId,
          promptId,
          provider: "copilot-chat",
          ts: roundTs,
          project,
          tool: call.name,
          filePath: filePathOf(call.name, args),
          skill: null,
          agent: "main",
          model: realModel(round?.modelId) ?? model,
          linesAdded: lines?.added ?? null,
          linesRemoved: lines?.removed ?? null,
        });
      }
    }
  }

  const created = num(state.creationDate);
  const firstTs = starts[0]!;
  const title = typeof state.customTitle === "string" && state.customTitle.trim() ? state.customTitle.trim() : firstText;

  sink.session({
    id: sessionId,
    provider: "copilot-chat",
    nativeId,
    project,
    title: truncate(title, opts.promptTextLimit > 0 ? 200 : 0),
    client: "copilot-chat",
    clientVersion: null,
    startedAt: created > 0 ? Math.min(created, firstTs) : firstTs,
    endedAt,
  });

  // Telemetry that came before the file knows the session but not its folder.
  if (project) sink.fillProject?.(sessionId, project);
  return rows;
}
