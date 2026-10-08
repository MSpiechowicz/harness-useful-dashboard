import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PriceBook } from "../pricing.ts";
import { copilotModel } from "./copilot.ts";
import { type IngestSink, num, parseTs, SessionAccumulator } from "./types.ts";

/**
 * GitHub Copilot CLI's session store, <copilot dir>/session-store.db (~/.copilot or $COPILOT_HOME), keeps a row per
 * model call in `assistant_usage_events`: the tokens that session.shutdown in events.jsonl only sums up. Its schema is
 * not published: what is read here follows community notes and was never checked against a real store, so it is read
 * defensively. Columns are looked up first, only known names are ever put in SQL, and a store without the table or a
 * required column gives nothing rather than an error.
 *
 * Known columns: session_id, model, input_tokens (cache reads and writes included), output_tokens, cache_read_tokens,
 * cache_write_tokens, reasoning_tokens, turn_index, agent_id, created_at (ISO text or epoch seconds or ms), and
 * sometimes initiator ('compaction' for the calls that summarise a full context), reasoning_effort.
 *
 * A session read here has its calls one by one: its shutdown rows keep only their premium requests (writer.ts).
 */

/** The session store in a Copilot folder. */
export function copilotStoreDatabases(dir: string): string[] {
  const path = join(dir, "session-store.db");
  return existsSync(path) ? [path] : [];
}

/** Rows a little older than the last read are read again: a write in progress then may have been half-seen. */
const OVERLAP_MS = 5 * 60_000;
/**
 * Where the last read stopped is saved as one number: the last row id read, or, for a table without row ids (and from
 * versions before row ids were kept), the latest call time in epoch ms. A row id is far below any such time.
 */
const TIME_FROM = 1e12;

const REQUIRED = ["session_id", "model", "input_tokens", "output_tokens", "created_at"] as const;
const OPTIONAL = ["cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "turn_index", "agent_id", "initiator", "reasoning_effort"] as const;

/** created_at as epoch ms, in SQL: numbers in seconds or ms, text through SQLite's date parser (UTC when no zone). */
const CREATED_MS = `CASE WHEN typeof(created_at) IN ('integer', 'real')
  THEN CASE WHEN created_at < 1e12 THEN created_at * 1000 ELSE created_at END
  ELSE (julianday(created_at) - 2440587.5) * 86400000.0 END`;

interface StoreRow {
  session_id: unknown;
  model: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  created_at: unknown;
  created_ms: number | null;
  row_id: number | null;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  reasoning_tokens: unknown;
  turn_index: unknown;
  agent_id: unknown;
  initiator: unknown;
  reasoning_effort: unknown;
}

/** A row's time: SQLite's reading of it, else a number kept as text, else what JavaScript makes of it. */
function rowTs(row: StoreRow): number | null {
  if (typeof row.created_ms === "number" && Number.isFinite(row.created_ms)) return Math.round(row.created_ms);

  const v = row.created_at;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Math.round(parseTs(Number(v))!);

  const ts = parseTs(v);
  return ts == null ? null : Math.round(ts);
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);

/** Shutdown rows are told apart by a "|" in their id (writer.ts): a store row's id never has one. */
const idPart = (v: string): string => v.replace(/\|/g, "_");

/** A session id is a folder name under session-state: nothing that could leave it. */
const SAFE_ID = /^[\w.-]+$/;
/** session.start (or resume) is near the start of events.jsonl. */
const HEAD_BYTES = 64 * 1024;

/** The folder a session ran in, from the session.start or session.resume at the head of its events.jsonl. */
function sessionFolder(copilotDir: string, sid: string): string | null {
  if (!SAFE_ID.test(sid) || sid === "." || sid === "..") return null;

  const path = join(copilotDir, "session-state", sid, "events.jsonl");
  let head: string;
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  for (const line of head.split("\n")) {
    if (!line.includes('"session.start"') && !line.includes('"session.resume"')) continue;
    try {
      const c = JSON.parse(line)?.data?.context ?? {};
      const folder = (typeof c.cwd === "string" && c.cwd) || (typeof c.gitRoot === "string" && c.gitRoot);
      if (folder) return folder;
    } catch {
      /* a line cut at the end of the head */
    }
  }
  return null;
}

/** Which rows to read: all, those after a row id (and those near its time), or those from a time on. */
type Cursor = { kind: "all" } | { kind: "rows"; after: number; from: number | null } | { kind: "time"; from: number };

/** Whether the table has row ids (no `WITHOUT ROWID`, and no column of its own named rowid). */
function hasRowids(src: Database, columns: Set<string>): boolean {
  if (columns.has("rowid")) return false;
  try {
    src.query("SELECT rowid FROM assistant_usage_events LIMIT 0").all();
    return true;
  } catch {
    return false;
  }
}

/**
 * Where to read from after the saved position `since`. After a row id, rows that came later are read whatever their
 * time (a call logged late, with an earlier created_at), and rows from a little before the time of the last one read.
 * A store whose row ids fell below the saved one was made anew: it is read whole.
 */
function cursorOf(src: Database, rowids: boolean, since: number, maxRowid: number | null): Cursor {
  if (since <= 0) return { kind: "all" };
  if (!rowids || since >= TIME_FROM) return { kind: "time", from: since - OVERLAP_MS };
  if (maxRowid == null || maxRowid < since) return { kind: "all" };

  const last = src
    .query<{ ms: number | null }, [number]>(`SELECT ${CREATED_MS} AS ms FROM assistant_usage_events WHERE rowid <= ? ORDER BY rowid DESC LIMIT 1`)
    .get(since);
  const from = typeof last?.ms === "number" && Number.isFinite(last.ms) ? last.ms - OVERLAP_MS : null;
  return { kind: "rows", after: since, from };
}

/** The filter on the rows a cursor reads, and its values. */
function filterOf(cursor: Cursor): [string, number[]] {
  if (cursor.kind === "all") return ["", []];
  if (cursor.kind === "time") return ["WHERE created_ms IS NULL OR created_ms >= ?", [cursor.from]];
  if (cursor.from == null) return ["WHERE row_id > ?", [cursor.after]];
  return ["WHERE row_id > ? OR created_ms >= ?", [cursor.after, cursor.from]];
}

/**
 * Reads the model calls in a Copilot session store after the saved position `since` (0 for everything) into the sink.
 * Returns the position to start from next time: the last row id read, or the latest call time for a table without row
 * ids. A position saved as a time (by older versions) is read as one once. A locked or damaged store throws: the scan
 * skips it and tries again later.
 */
export function ingestCopilotStore(path: string, sink: IngestSink, opts: { since: number; promptTextLimit: number; prices?: PriceBook }): number {
  const src = new Database(path, { readonly: true });
  try {
    src.exec("PRAGMA busy_timeout = 5000");

    const columns = new Set(src.query<{ name: string }, []>("PRAGMA table_info('assistant_usage_events')").all().map((c) => c.name));
    if (!REQUIRED.every((c) => columns.has(c))) return opts.since;

    // The highest row id before the read: rows up to it are all read now or were before, whichever the cursor.
    const rowids = hasRowids(src, columns);
    const maxRowid = rowids ? src.query<{ id: number | null }, []>("SELECT max(rowid) AS id FROM assistant_usage_events").get()?.id ?? null : null;
    const cursor = cursorOf(src, rowids, opts.since, maxRowid);
    const [filter, values] = filterOf(cursor);

    // Only names from the lists above go into the query, never names read from the store.
    const select = [...REQUIRED, ...OPTIONAL.map((c) => (columns.has(c) ? c : `NULL AS ${c}`)), rowids ? "rowid AS row_id" : "NULL AS row_id"].join(", ");
    const rows = src
      .query<StoreRow, number[]>(`SELECT * FROM (SELECT ${select}, ${CREATED_MS} AS created_ms FROM assistant_usage_events) ${filter}`)
      .iterate(...values);

    const copilotDir = dirname(path);
    const folders = new Map<string, string | null>();
    const folderOf = (sid: string): string | null => {
      if (!folders.has(sid)) folders.set(sid, sessionFolder(copilotDir, sid));
      return folders.get(sid)!;
    };

    let latest = opts.since;
    let lastRow = maxRowid ?? 0;
    const sessions = new SessionAccumulator();
    const seen = new Set<string>();

    for (const row of rows) {
      if (typeof row.row_id === "number") lastRow = Math.max(lastRow, row.row_id);

      const sid = text(row.session_id);
      const ts = rowTs(row);
      if (!sid || ts == null) continue;

      latest = Math.max(latest, ts);
      const sessionId = `copilot:${sid}`;
      const project = folderOf(sid);
      sessions.touch({ id: sessionId, provider: "copilot", nativeId: sid, project, client: "copilot-cli" }, ts);
      seen.add(sessionId);

      const rawModel = text(row.model) ?? "";
      const agent = text(row.agent_id) ?? "main";
      const turn = text(row.turn_index) ?? "";
      const inTokens = num(row.input_tokens);
      const outTokens = num(row.output_tokens);
      const cacheRead = num(row.cache_read_tokens);
      const cacheWrite = num(row.cache_write_tokens);
      const reasoning = num(row.reasoning_tokens);
      const model = rawModel ? copilotModel(rawModel) : null;

      // Re-reading a row writes the same id: the upsert keeps one.
      const key = [ts, turn, agent, rawModel, inTokens, outTokens].map((p) => idPart(String(p))).join(":");
      const usageId = `${sessionId}:u:${key}`;
      const input = Math.max(0, inTokens - cacheRead - cacheWrite);

      sink.usage({
        id: usageId,
        provider: "copilot",
        sessionId,
        promptId: null,
        ts,
        project,
        model,
        skill: null,
        agent,
        isSubagent: agent !== "main",
        input,
        // Copilot's output count already holds the reasoning, as the session.shutdown totals do.
        output: outTokens,
        cacheRead,
        cacheWrite,
        cacheWrite1h: 0,
        reasoning,
        billing: "github-copilot",
        // Premium requests come from session.shutdown: the store's calls carry tokens only.
        premiumRequests: 0,
      });

      const effort = text(row.reasoning_effort);
      if (effort) sink.responseMeta?.({ usageId, startTs: null, endTs: ts, effort });

      // A call that summarised the context is also a compaction. Its tokens are in the usage row above: the compaction
      // only records the event, and compaction costs are never added to spend.
      if (row.initiator === "compaction") {
        const costUsd = opts.prices ? opts.prices.cost(model, { input, output: outTokens, cacheRead, cacheWrite, cacheWrite1h: 0 }).usd : null;
        sink.compaction?.({
          id: `${sessionId}:${key}:compact`,
          provider: "copilot",
          sessionId,
          ts,
          project,
          model,
          agent,
          trigger: "auto",
          preTokens: inTokens,
          postTokens: outTokens,
          durationMs: null,
          costUsd,
        });
      }
    }

    sessions.flush(sink);
    // Once per session: its shutdown totals give way to the calls just read.
    for (const sessionId of seen) sink.supersedeRollups?.(sessionId);
    return rowids ? lastRow : latest;
  } finally {
    src.close();
  }
}
