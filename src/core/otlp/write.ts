import type { Database } from "bun:sqlite";
import { DbWriter } from "../ingest/writer.ts";
import type { PriceBook } from "../pricing.ts";
import { rollupCutoff } from "../rollup.ts";
import { decodeLogsJson, decodeTracesJson } from "./json.ts";
import { mapBatch, type SkipReason } from "./map.ts";
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
  opts: { storeText: boolean; promptTextLimit: number; detailBefore: number; localHost: string; now?: number },
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
      for (const u of g.usage) w.usage(u);
      for (const t of g.tools) w.tool(t);
      for (const o of g.outcomes) w.outcome(o);
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

  for (const host of result.hosts) known.add(host);
  return result;
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
