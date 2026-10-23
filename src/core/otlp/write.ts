import type { Database } from "bun:sqlite";
import { REPLACE_SLACK_MS } from "../ingest/copilotChat.ts";
import { DbWriter } from "../ingest/writer.ts";
import type { PriceBook } from "../pricing.ts";
import { rollupCutoff } from "../rollup.ts";
import { decodeLogsJson, decodeTracesJson } from "./json.ts";
import { type MappedGroup, mapBatch, type SkipReason } from "./map.ts";
import { MAX_BYTES, type OtlpBatch, OtlpTooLarge } from "./model.ts";
import { decodeLogs, decodeTraces } from "./proto.ts";

export { MAX_BYTES, MAX_RECORDS, OtlpDecodeError, OtlpTooLarge } from "./model.ts";
export type { SkipReason } from "./map.ts";
export type { OtlpBatch } from "./model.ts";

/**
 * One OTLP/HTTP request body. Throws OtlpDecodeError when it is no valid export, OtlpTooLarge past MAX_BYTES,
 * MAX_RECORDS or another of the limits in model.ts.
 */
export function decodeOtlp(signal: "traces" | "logs", body: Uint8Array, format: "protobuf" | "json"): OtlpBatch {
  if (body.length > MAX_BYTES) throw new OtlpTooLarge(`a body of more than ${MAX_BYTES} bytes`);
  if (format === "json") return signal === "traces" ? decodeTracesJson(body) : decodeLogsJson(body);
  return signal === "traces" ? decodeTraces(body) : decodeLogs(body);
}

export interface WriteResult {
  usage: number;
  tools: number;
  prompts: number;
  sessions: number;
  /** Records left out (mapBatch), and how many of them for each reason. */
  skipped: number;
  skippedFor: Partial<Record<SkipReason, number>>;
  /** The hosts the batch's records were stamped with. */
  hosts: string[];
}

/** Projects of remote records are labels from their resource (harness.project), never paths on this machine. */
const asIs = (project: string | null | undefined) => project ?? null;

/**
 * Writes a decoded export, in one transaction: one DbWriter per remote host and user, so every row carries the machine
 * it ran on. Replays upsert the same rows. Every id is namespaced with the credential's key, so one sender never
 * overwrites another's rows.
 */
export function writeOtlp(
  db: Database,
  prices: PriceBook,
  batch: OtlpBatch,
  cred: { kind: "token" | "basic"; label: string; key: string },
  opts: {
    storeText: boolean;
    promptTextLimit: number;
    detailBefore: number;
    localHost: string;
    now?: number;
    /** This machine's host and user, when the sender is VS Code on this machine (a vscode token over loopback). */
    local?: { host: string; user: string } | null;
  },
): WriteResult {
  const known = knownHosts(db, cred.key, opts.now);
  const mapped = mapBatch(batch, {
    storeText: opts.storeText,
    textLimit: opts.promptTextLimit,
    label: cred.label,
    credKey: cred.key,
    localHost: opts.localHost,
    takenHosts: takenHosts(db),
    knownHosts: known,
    now: opts.now,
    local: opts.local,
  });
  const result: WriteResult = { usage: 0, tools: 0, prompts: 0, sessions: 0, skipped: mapped.skipped, skippedFor: mapped.skippedFor, hosts: [] };
  if (!mapped.groups.length) return result;

  const hermesPrefix = `otlp:${cred.key}:hermes:`;
  db.transaction(() => {
    const hermesSessions: string[] = [];
    for (const g of mapped.groups) {
      const w = new DbWriter(db, prices, { user: g.user, host: g.host }, opts.detailBefore, rollupCutoff(), asIs);
      // Sessions first and tool calls before their outcomes: an outcome takes its tool from the call.
      g.sessions.flush(w);
      for (const p of g.prompts) w.prompt(p);
      if (g.local) {
        writeLocalCopilotChat(db, w, g);
      } else {
        for (const u of g.usage) w.usage(u);
        for (const t of g.tools) w.tool(t);
        for (const o of g.outcomes) w.outcome(o);
      }
      for (const m of g.meta) w.responseMeta(m);

      result.usage += w.stats.usage;
      result.tools += w.stats.tools;
      result.prompts += w.stats.prompts;
      result.sessions += g.sessionIds.size;
      if (!result.hosts.includes(g.host)) result.hosts.push(g.host);
      for (const id of g.sessionIds) if (id.startsWith(hermesPrefix)) hermesSessions.push(id);
    }

    if (hermesSessions.length) markSubagents(db, hermesSessions);
  })();

  // This machine is no remote host of the credential: its Copilot Chat rows don't count against MAX_HOSTS.
  for (const g of mapped.groups) if (!g.local) known.add(g.host);
  return result;
}

export { REPLACE_SLACK_MS };

/**
 * Writes this machine's Copilot Chat records. The telemetry and the chat session file describe the same requests, the
 * file only in part (a partial row: the last call's input). The reader gives each request an interval (response_meta of
 * its file row: its start, and its end if known, see copilotChat.ts), and a model call belongs to the request with the
 * latest start no later than the call's: when the call also ended by the request's end (plus REPLACE_SLACK_MS). A
 * request without an end is not taken: the next reading of the file settles it.
 *
 * What a call of a request takes from it:
 * - the request's partial row is replaced: it goes, and tool_calls point to no usage row any more. Its interval stays
 *   (without its usage row), so later calls of the request, in later batches, find the request too. A finished older
 *   request never matches, a replay finds the row gone;
 * - the request's prompt, if the file has one: a prompt's cost is its calls'. A call that matches no request gets
 *   none now, the reader's next look at the file links it (IngestSink.linkPrompt);
 * - the project of its session, if the session has one (the telemetry knows no folder). The reader fills in the rest
 *   (IngestSink.fillProject).
 *
 * When the telemetry comes first, the reader skips what is covered (IngestSink.covered).
 *
 * This runs in the transaction of the write, so a batch that fails leaves the partial rows as they are. One cost is
 * accepted: if the collector was down for the first rounds of a request, the first call to arrive replaces the partial
 * row, and the rounds that never arrived are lost from the totals.
 */
function writeLocalCopilotChat(db: Database, w: DbWriter, g: MappedGroup): void {
  const request = db.query<{ id: string; end: number | null }, { from: string; to: string; start: number }>(`
    SELECT usage_id AS id, end_ts AS end FROM response_meta
    WHERE usage_id >= $from AND usage_id < $to AND start_ts <= $start
    ORDER BY start_ts DESC LIMIT 1`);
  const prompt = db.query("SELECT 1 FROM prompts WHERE id = $id");
  const sessionProject = db.query<{ project: string | null }, { id: string }>("SELECT project FROM sessions WHERE id = $id");

  const projects = new Map<string, string | null>();
  const projectOf = (sessionId: string) => {
    if (!projects.has(sessionId)) projects.set(sessionId, sessionProject.get({ id: sessionId })?.project ?? null);
    return projects.get(sessionId)!;
  };

  /** The prompt of the request a moment of the session belongs to (start to end), and its partial row's id. */
  const requestAt = (sessionId: string, start: number, end: number) => {
    // The sessions of calls with no conversation have no file to be read from.
    if (sessionId.startsWith("copilot-chat:background:")) return null;

    const files = `${sessionId}:f:`;
    const found = request.get({ from: files, to: `${sessionId}:f;`, start });
    if (!found || found.end == null || end > found.end + REPLACE_SLACK_MS) return null;

    const promptId = `${sessionId}:${found.id.slice(files.length)}`;
    return { usageId: found.id, promptId: prompt.get({ id: promptId }) ? promptId : null };
  };

  const spans = new Map(g.meta.map((m) => [m.usageId, m]));
  for (const u of g.usage) {
    const span = spans.get(u.id);
    const own = span?.startTs != null ? requestAt(u.sessionId, span.startTs, span.endTs ?? u.ts) : null;

    if (own) w.dropPartial(own.usageId);
    w.usage({ ...u, project: u.project ?? projectOf(u.sessionId), promptId: u.promptId ?? own?.promptId ?? null });
  }

  for (const t of g.tools) {
    const own = requestAt(t.sessionId, t.ts, t.ts);
    w.tool({ ...t, project: t.project ?? projectOf(t.sessionId), promptId: t.promptId ?? own?.promptId ?? null });
  }
  for (const o of g.outcomes) w.outcome({ ...o, project: o.project ?? projectOf(o.sessionId) });
}

/**
 * A Hermes subagent's calls come in as the main agent's: what makes a session a child (its subagent span in the
 * parent's trace) may come in another request than its calls. Once the session is known as one, its rows of this batch
 * take its agent.
 */
function markSubagents(db: Database, sessionIds: string[]): void {
  const ids = JSON.stringify(sessionIds);
  const child = "SELECT id FROM sessions WHERE parent_session_id IS NOT NULL AND id IN (SELECT value FROM json_each($ids))";
  const agent = (table: string) => `COALESCE((SELECT s.agent FROM sessions s WHERE s.id = ${table}.session_id), ${table}.agent)`;

  db.query(`UPDATE usage SET agent = ${agent("usage")}, is_subagent = 1 WHERE provider = 'hermes' AND session_id IN (${child})`).run({ ids });
  for (const table of ["tool_calls", "outcomes"]) {
    db.query(`UPDATE ${table} SET agent = ${agent(table)} WHERE provider = 'hermes' AND session_id IN (${child})`).run({ ids });
  }
}

/** How long the hosts with sessions of their own are taken as read: finding them reads every session. */
const TAKEN_MS = 60_000;
const writingHosts = new WeakMap<Database, { at: number; hosts: string[] }>();

/**
 * The hosts that write rows of their own on this database: every one that scanned (its `last_scan:` note, read each
 * time), and every one with sessions not taken over OTLP (read at most every TAKEN_MS). A remote host named like one
 * of them is told apart from it (identityOf).
 */
function takenHosts(db: Database, now = Date.now()): string[] {
  const scanned = db.query<{ host: string }, []>("SELECT substr(key, 11) AS host FROM meta WHERE key GLOB 'last_scan:*'").all().map((r) => r.host);

  let writing = writingHosts.get(db);
  if (!writing || now - writing.at >= TAKEN_MS) {
    const hosts = db.query<{ host: string }, []>("SELECT DISTINCT host FROM sessions WHERE host IS NOT NULL AND id NOT GLOB 'otlp:*'").all().map((r) => r.host);
    writing = { at: now, hosts };
    writingHosts.set(db, writing);
  }
  return [...new Set([...scanned, ...writing.hosts])];
}

const credentialHosts = new WeakMap<Database, Map<string, { at: number; hosts: Set<string> }>>();

/**
 * The hosts a credential sent records of (its `otlp:<key>:` sessions, calls and outcomes), read at most every TAKEN_MS
 * and added to as it writes: mapBatch skips the records of new hosts past MAX_HOSTS. Not the sessions alone: a session
 * keeps its first host, so records of new hosts reusing one session id would never count.
 */
function knownHosts(db: Database, key: string, now = Date.now()): Set<string> {
  let byKey = credentialHosts.get(db);
  if (!byKey) {
    byKey = new Map();
    credentialHosts.set(db, byKey);
  }

  let known = byKey.get(key);
  if (!known || now - known.at >= TAKEN_MS) {
    // The ids from `otlp:<key>:` up to `otlp:<key>;`: ";" comes right after ":".
    const sql = /* sql */ `
      SELECT host FROM sessions WHERE id >= $from AND id < $to AND host IS NOT NULL
      UNION SELECT host FROM usage WHERE id >= $from AND id < $to AND host IS NOT NULL
      UNION SELECT host FROM outcomes WHERE id >= $from AND id < $to AND host IS NOT NULL`;
    const rows = db.query<{ host: string }, { from: string; to: string }>(sql).all({ from: `otlp:${key}:`, to: `otlp:${key};` });
    known = { at: now, hosts: new Set(rows.map((r) => r.host)) };
    byKey.set(key, known);
  }
  return known.hosts;
}

/** Whether any row was taken over OTLP, whichever machine took it: this machine's jobs (trim, rollup) look after those. */
export function hasRemoteRows(db: Database): boolean {
  return db.query("SELECT 1 FROM sessions WHERE id GLOB 'otlp:*' LIMIT 1").get() != null;
}

/** The remote hosts OTLP data was taken from, whichever machine took it. Read from the sessions. */
export function remoteHosts(db: Database): string[] {
  return db
    .query<{ host: string }, []>("SELECT DISTINCT host FROM sessions WHERE id GLOB 'otlp:*' AND host IS NOT NULL ORDER BY host")
    .all()
    .map((r) => r.host);
}
