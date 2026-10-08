import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { apiErrorOf } from "../apiErrors.ts";
import { failureOf, inputSummary } from "../failures.ts";
import { countLines, diffLines, type LineCount, patchLines, sumLines, unifiedDiffLines } from "./lines.ts";
import { type IngestSink, num, type Provider, truncate } from "./types.ts";
import { emitGitEvents, vcsCall } from "./vcs.ts";

/**
 * OpenCode keeps its sessions in a SQLite database in its data folder (~/.local/share/opencode/opencode.db, or
 * opencode-<channel>.db for preview builds) since v1.2, which moved the older JSON files into it. Three tables
 * matter, each row's `data` a JSON document:
 *  - session: directory, title, parent_id (a subagent's session points at the one that started it), version
 *  - message: a user prompt, or an assistant reply with its model, the provider it was billed through, and tokens
 *  - part: a message's pieces: prompt text, tool calls, and a step-finish for every model call with its tokens
 * The database is opened read-only and read from where the last scan left off (rows updated since then).
 */

/** The OpenCode databases in a data folder. */
export function opencodeDatabases(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^opencode(-[\w.-]+)?\.db$/.test(f))
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** Size and change time of the database together with its write-ahead log, where recent writes are until checkpointed. */
export function sqliteStamp(path: string): { size: number; mtime: number } {
  let size = 0;
  let mtime = 0;
  for (const f of [path, `${path}-wal`]) {
    try {
      const st = statSync(f);
      size += st.size;
      mtime = Math.max(mtime, Math.floor(st.mtimeMs));
    } catch {
      /* no log: everything is in the database */
    }
  }
  return { size, mtime };
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  version: string | null;
  agent?: string | null;
  time_created: number | null;
  time_updated: number | null;
}

const json = (s: unknown): Record<string, any> => {
  try {
    return typeof s === "string" ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

/** Before v1.4, OpenCode's output count included reasoning. Since, reasoning is reported apart. */
function outputExcludesReasoning(version: string | null): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 4);
}

/** Files an apply_patch names: "*** Add File: path", "*** Update File: path", "*** Delete File: path". */
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const counted = (x: Record<string, any> | null | undefined): LineCount | null =>
  typeof x?.additions === "number" && typeof x.deletions === "number" ? { added: x.additions, removed: x.deletions } : null;

/**
 * The lines a finished edit, write or patch changed. Its metadata counts them when the version does (`filediff`,
 * `files`) or carries the diff, else they come from its input: the old and new text, a patch, or a file's content.
 */
export function opencodeEditLines(tool: string, input: Record<string, any>, metadata: Record<string, any> | null | undefined): LineCount | null {
  const md = metadata ?? {};
  switch (tool) {
    case "edit":
      return counted(md.filediff) ?? unifiedDiffLines(md.diff) ?? diffLines(input.oldString, input.newString);
    case "multiedit":
      return (
        sumLines((Array.isArray(md.results) ? md.results : []).map((r: any) => counted(r?.filediff ?? r?.metadata?.filediff))) ??
        sumLines((Array.isArray(input.edits) ? input.edits : []).map((e: any) => diffLines(e?.oldString, e?.newString))) ?? { added: 0, removed: 0 }
      );
    case "write":
      return counted(md.filediff) ?? { added: countLines(input.content), removed: 0 };
    case "apply_patch":
    case "patch":
      return sumLines((Array.isArray(md.files) ? md.files : []).map(counted)) ?? unifiedDiffLines(md.diff) ?? patchLines(input.patchText);
    default:
      return null;
  }
}

/** A subagent session is titled "<description> (@<agent> subagent)". */
const SUBAGENT_TITLE_RE = /\(@([\w.-]+) subagent\)\s*$/;
/** A message's errors that are a failed model request (not the user stopping it, nor the reply running too long). */
const API_ERRORS = new Set(["APIError", "ProviderAuthError", "ContextOverflowError", "UnknownError"]);
/** Rows updated a little before the last read are read again: a write in progress then may have been half-seen. */
const OVERLAP_MS = 5 * 60_000;

/**
 * Who wrote the database. Kilo Code 7 keeps its sessions in the same schema (kilo.db): read as the Cline family's,
 * under ids of its own, with the cost Kilo worked out for each model call.
 */
export interface OpencodeFlavor {
  provider: Provider;
  prefix: string;
  client: string;
  reportedCost: boolean;
}
const OPENCODE: OpencodeFlavor = { provider: "opencode", prefix: "opencode", client: "opencode", reportedCost: false };

/**
 * Reads what changed in one OpenCode database since `since` (epoch ms, 0 for everything) into the sink. Returns the
 * latest update time seen, to start from next time.
 */
export function ingestOpencode(path: string, sink: IngestSink, opts: { since: number; promptTextLimit: number; flavor?: OpencodeFlavor }): number {
  const flavor = opts.flavor ?? OPENCODE;
  const oc = (id: string) => `${flavor.prefix}:${id}`;
  const src = new Database(path, { readonly: true });
  try {
    src.exec("PRAGMA busy_timeout = 5000");
    const from = Math.max(0, opts.since - OVERLAP_MS);
    const sessions = new Map(src.query<SessionRow, []>("SELECT * FROM session").all().map((s) => [s.id, s]));
    const messages = src
      .query<{ id: string; session_id: string; time_created: number; time_updated: number; data: string }, [number]>(
        "SELECT id, session_id, time_created, time_updated, data FROM message WHERE time_updated >= ? ORDER BY time_created",
      )
      .all(from);
    const partsOf = src.prepare<{ id: string; time_created: number; data: string }, [string]>(
      "SELECT id, time_created, data FROM part WHERE message_id = ? ORDER BY time_created, id",
    );
    // The task tool call that started a subagent session: its usage counts toward that call's prompt.
    const spawnCall = src.prepare<{ data: string }, [string, string]>("SELECT data FROM part WHERE session_id = ? AND data LIKE ? LIMIT 1");
    const spawnRefs = new Map<string, string | null>();
    const spawnRefOf = (child: SessionRow): string | null => {
      if (!child.parent_id) return null;
      if (!spawnRefs.has(child.id)) {
        const row = spawnCall.get(child.parent_id, `%"sessionId":"${child.id}"%`);
        const callID = row ? json(row.data).callID : null;
        spawnRefs.set(child.id, typeof callID === "string" ? oc(callID) : null);
      }
      return spawnRefs.get(child.id)!;
    };

    let latest = opts.since;
    const seenSessions = new Set<string>();
    const skillOf = new Map<string, string>();

    for (const row of messages) {
      latest = Math.max(latest, row.time_updated);
      const session = sessions.get(row.session_id);
      const m = json(row.data);
      const sessionId = oc(row.session_id);
      const isSub = !!session?.parent_id;
      const agent = isSub ? (session?.agent ?? SUBAGENT_TITLE_RE.exec(session?.title ?? "")?.[1] ?? "subagent") : "main";
      const project = (typeof m.path?.cwd === "string" ? m.path.cwd : null) ?? session?.directory ?? null;
      if (session && !seenSessions.has(session.id)) {
        seenSessions.add(session.id);
        sink.session({
          id: sessionId,
          provider: flavor.provider,
          nativeId: session.id,
          project: session.directory,
          title: session.title,
          client: flavor.client,
          clientVersion: session.version,
          parentSessionId: session.parent_id ? oc(session.parent_id) : null,
          agent: isSub ? agent : null,
          startedAt: session.time_created,
          endedAt: session.time_updated,
        });
      }
      const ts = typeof m.time?.created === "number" ? m.time.created : row.time_created;
      const parts = partsOf.all(row.id).map((p) => ({ id: p.id, ts: p.time_created, ...json(p.data) }) as Record<string, any>);

      if (m.role === "user") {
        // A subagent's "user" message is its brief from the session that started it, not a prompt.
        if (isSub) continue;
        const text = parts
          .filter((p) => p.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
          .map((p) => p.text as string)
          .join("\n");
        sink.prompt({
          id: oc(row.id),
          sessionId,
          provider: flavor.provider,
          ts,
          text: truncate(text || null, opts.promptTextLimit),
          skill: null,
          isCommand: /^\s*\/[\w:-]+/.test(text),
        });
        continue;
      }
      if (m.role !== "assistant") continue;
      // Still answering: it is read again once it's done (its update time moves on).
      if (!m.time?.completed && !m.error) continue;

      const promptId = !isSub && typeof m.parentID === "string" ? oc(m.parentID) : null;
      const spawnRef = session ? spawnRefOf(session) : null;
      const steps = parts.filter((p) => p.type === "step-finish" && p.tokens);
      const usageId = steps[0] ? oc(steps[0].id) : oc(row.id);

      const model = typeof m.modelID === "string" ? m.modelID : null;
      if (m.error?.name === "MessageAbortedError") {
        sink.outcome?.({ id: `${oc(row.id)}:interrupt`, provider: flavor.provider, sessionId, ts, project, model, agent, kind: "interrupt" });
      } else if (typeof m.error?.name === "string" && API_ERRORS.has(m.error.name)) {
        // The provider failed the request: APIError carries its status and message, the others their message.
        const e = m.error.data ?? {};
        const code = m.error.name === "APIError" || m.error.name === "UnknownError" ? null : m.error.name;
        sink.outcome?.({
          id: `${oc(row.id)}:api`,
          provider: flavor.provider,
          sessionId,
          ts: typeof m.time?.completed === "number" ? m.time.completed : ts,
          project,
          model,
          agent,
          ...apiErrorOf(code, typeof e.statusCode === "number" ? e.statusCode : null, typeof e.message === "string" ? e.message : null, opts.promptTextLimit),
        });
      }

      for (const p of parts) {
        if (p.type !== "tool" || typeof p.tool !== "string") continue;
        const status = p.state?.status;
        if (status !== "completed" && status !== "error") continue;
        const error = status === "error" ? String(p.state?.error ?? "") : "";
        const stopped = status === "error" && /rejected|denied|aborted/i.test(error);
        const kind = status === "completed" ? "tool_ok" : stopped ? "tool_rejected" : "tool_error";
        sink.outcome?.({
          id: oc(typeof p.callID === "string" ? p.callID : p.id),
          provider: flavor.provider,
          sessionId,
          ts: typeof p.state?.time?.end === "number" ? p.state.time.end : ts,
          project,
          model,
          agent,
          kind,
          ...failureOf(kind, p.tool, error, inputSummary(p.state?.input, opts.promptTextLimit), opts.promptTextLimit),
        });
        const input = p.state?.input ?? {};
        if (p.tool === "skill" && typeof input.name === "string" && promptId) skillOf.set(promptId, input.name);
        const files =
          p.tool === "apply_patch" && typeof input.patchText === "string"
            ? [...(input.patchText as string).matchAll(PATCH_FILE_RE)].map((f) => f[1]!.trim())
            : typeof input.filePath === "string"
              ? [input.filePath as string]
              : [];
        const callId = oc(typeof p.callID === "string" ? p.callID : p.id);
        // A shell command that worked (bash reports its exit code in its metadata) and commits or opens a PR. OpenCode
        // logs no branch: a commit's is the one its output names.
        const vcs = status === "completed" ? vcsCall(input.command, opts.promptTextLimit) : null;
        const exit = p.state?.metadata?.exit;
        if (vcs && (exit == null || exit === 0)) {
          const at = typeof p.state?.time?.end === "number" ? p.state.time.end : ts;
          emitGitEvents(sink, vcs, p.state?.output, { provider: flavor.provider, sessionId, ts: at, project, agent, branch: null, callId }, opts.promptTextLimit);
        }
        // A failed edit changed nothing.
        const lines = status === "completed" ? opencodeEditLines(p.tool, input, p.state?.metadata) : null;
        (files.length ? files : [null]).forEach((filePath, n) =>
          sink.tool({
            id: n === 0 ? callId : `${callId}:f${n}`,
            usageId,
            sessionId,
            promptId,
            provider: flavor.provider,
            ts: typeof p.state?.time?.start === "number" ? p.state.time.start : ts,
            project,
            tool: p.tool,
            filePath,
            skill: promptId ? (skillOf.get(promptId) ?? null) : null,
            agent,
            spawnRef,
            model,
            // A further file's row counts as an edit of its own, its lines on the first.
            linesAdded: lines ? (n === 0 ? lines.added : 0) : null,
            linesRemoved: lines ? (n === 0 ? lines.removed : 0) : null,
          }),
        );
      }

      // One row per model call (step-finish). A message without them (older versions) is one call.
      // A model call starts at its step-start part (or the message, for its first call) and ends at its step-finish.
      const starts = new Map<string, number>();
      let stepStart: number | null = ts;
      for (const p of parts) {
        if (p.type === "step-start") stepStart = p.ts ?? null;
        else if (p.type === "step-finish" && p.tokens) {
          if (stepStart != null) starts.set(p.id, stepStart);
          stepStart = null;
        }
      }
      const calls = steps.length
        ? steps.map((p) => ({ id: oc(p.id), ts: p.ts ?? ts, tokens: p.tokens, cost: p.cost, model: p.model?.modelID, start: starts.get(p.id) ?? null, end: p.ts ?? null }))
        : [{ id: oc(row.id), ts, tokens: m.tokens, cost: m.cost, model: undefined, start: ts, end: typeof m.time?.completed === "number" ? m.time.completed : null }];
      const excludesReasoning = outputExcludesReasoning(session?.version ?? null);
      for (const call of calls) {
        const t = call.tokens ?? {};
        const reasoning = num(t.reasoning);
        sink.usage({
          id: call.id,
          provider: flavor.provider,
          sessionId,
          promptId,
          ts: call.ts,
          project,
          // Kilo names the model on each call, which can differ from the message's.
          model: typeof call.model === "string" ? call.model : model,
          skill: promptId ? (skillOf.get(promptId) ?? null) : null,
          agent,
          isSubagent: isSub,
          spawnRef,
          // Input is net of cache reads and writes. Output includes reasoning in the usage table.
          input: num(t.input),
          output: num(t.output) + (excludesReasoning ? reasoning : 0),
          cacheRead: num(t.cache?.read),
          cacheWrite: num(t.cache?.write),
          cacheWrite1h: 0,
          reasoning,
          billing: typeof m.providerID === "string" ? m.providerID : null,
          costUsd: flavor.reportedCost && typeof call.cost === "number" ? call.cost : null,
        });
        sink.responseMeta?.({ usageId: call.id, startTs: call.start, endTs: call.end });
      }
    }
    return latest;
  } finally {
    src.close();
  }
}
