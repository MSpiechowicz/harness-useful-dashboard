import type { IngestSink } from "./types.ts";

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f !== "")) rows.push(row);
  }
  return rows;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function findCol(headers: string[], ...candidates: ((h: string) => boolean)[]): number {
  for (const test of candidates) {
    const i = headers.findIndex(test);
    if (i >= 0) return i;
  }
  return -1;
}

function toNum(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** One model call as Cursor reports it, from a CSV row or from cursor.com's usage events (cursorSync.ts). */
export interface CursorEvent {
  ts: number;
  /** The account's email in team exports, null for the user's own usage. */
  user: string | null;
  model: string | null;
  /** How Cursor billed it: "Included", "Usage-based", "Errored, Not Charged", … */
  kind: string | null;
  /** Uncached input. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  /** The cost Cursor reports in USD, null when it reports none (an included call). */
  cost: number | null;
}

/**
 * A call's row id, from what both the CSV export and the usage API report about it: its time to the millisecond, the
 * model and the tokens. A CSV import and a sync of the same call so write the same row.
 */
export function cursorUsageId(e: Pick<CursorEvent, "ts" | "model" | "input" | "cacheWrite" | "cacheRead" | "output">): string {
  return `cursor:${e.ts}:${e.model ?? ""}:${e.input}:${e.cacheWrite}:${e.cacheRead}:${e.output}`;
}

/**
 * Gives rows imported before cursorUsageId their key under it (migration 13). They were keyed by a hash of their CSV
 * line. One that would clash with another keeps its old key.
 */
export const CURSOR_REKEY = /* sql */ `
  UPDATE OR IGNORE usage
  SET id = 'cursor:' || ts || ':' || COALESCE(model, '') || ':' || input_tokens || ':' || cache_write_tokens || ':' ||
           cache_read_tokens || ':' || output_tokens
  WHERE provider = 'cursor' AND id GLOB 'cursor:[0-9a-f]*' AND length(id) = 27;
`;

/**
 * Writes one call, under a session per user and UTC day. `seen` holds the sessions already written by this import,
 * which then only widen their time span. Returns false for a call without tokens (errored, aborted).
 */
export function writeCursorEvent(e: CursorEvent, sink: IngestSink, seen: Set<string>): boolean {
  if (!e.input && !e.output && !e.cacheRead && !e.cacheWrite) return false;
  const day = new Date(e.ts).toISOString().slice(0, 10);
  const sessionId = `cursor:${e.user ?? "local"}:${day}`;
  if (!seen.has(sessionId)) {
    seen.add(sessionId);
    sink.session({ id: sessionId, provider: "cursor", nativeId: day, project: "Cursor", title: `Cursor usage ${day}`, client: "cursor", startedAt: e.ts, endedAt: e.ts });
  } else sink.session({ id: sessionId, provider: "cursor", nativeId: day, startedAt: e.ts, endedAt: e.ts });
  sink.usage({
    id: cursorUsageId(e),
    provider: "cursor",
    sessionId,
    promptId: null,
    ts: e.ts,
    project: "Cursor",
    model: e.model,
    skill: null,
    agent: e.kind || "main",
    isSubagent: false,
    input: e.input,
    output: e.output,
    cacheRead: e.cacheRead,
    cacheWrite: e.cacheWrite,
    cacheWrite1h: 0,
    reasoning: 0,
    costUsd: e.cost,
    user: e.user,
  });
  return true;
}

export interface CursorImportResult {
  rows: number;
  imported: number;
  skipped: number;
}

/**
 * Imports the usage CSV exported from cursor.com → Dashboard → Usage → Export.
 * Header names vary between export versions, so columns are matched loosely.
 */
export function importCursorCsv(text: string, sink: IngestSink): CursorImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { rows: 0, imported: 0, skipped: 0 };
  const headers = rows[0]!.map(norm);
  const col = {
    date: findCol(headers, (h) => h === "date", (h) => h.includes("date") || h.includes("time")),
    user: findCol(headers, (h) => h === "user" || h === "email" || h.includes("user email")),
    model: findCol(headers, (h) => h === "model", (h) => h.includes("model")),
    kind: findCol(headers, (h) => h === "kind", (h) => h === "type"),
    inputWithCacheWrite: findCol(headers, (h) => h.includes("input") && h.includes("w cache write")),
    inputNoCacheWrite: findCol(headers, (h) => h.includes("input") && h.includes("w o cache write")),
    input: findCol(headers, (h) => h === "input tokens" || h === "input"),
    cacheRead: findCol(headers, (h) => h.includes("cache read")),
    output: findCol(headers, (h) => h.startsWith("output")),
    total: findCol(headers, (h) => h.startsWith("total tokens") || h === "tokens"),
    cost: findCol(headers, (h) => h === "cost" || h.startsWith("cost ") || h.includes("cost usd") || h === "requests cost"),
  };
  if (col.date < 0) throw new Error("CSV has no Date column — is this a Cursor usage export?");

  let imported = 0;
  let skipped = 0;
  const seenSessions = new Set<string>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const ts = Date.parse(row[col.date] ?? "");
    if (Number.isNaN(ts)) {
      skipped++;
      continue;
    }
    // "Input (w/ Cache Write)" counts the prompt tokens that were written to cache.
    const cacheWrite = col.inputWithCacheWrite >= 0 ? toNum(row[col.inputWithCacheWrite]) : 0;
    const input = col.inputNoCacheWrite >= 0 ? toNum(row[col.inputNoCacheWrite]) : col.input >= 0 ? toNum(row[col.input]) : 0;
    const cacheRead = col.cacheRead >= 0 ? toNum(row[col.cacheRead]) : 0;
    const output = col.output >= 0 ? toNum(row[col.output]) : 0;
    const total = col.total >= 0 ? toNum(row[col.total]) : 0;
    let uncached = input;
    if (!input && !output && !cacheRead && !cacheWrite && total) uncached = total; // token-total-only exports
    const costRaw = col.cost >= 0 ? row[col.cost] : undefined;
    const event: CursorEvent = {
      ts,
      user: col.user >= 0 ? row[col.user] || null : null,
      model: col.model >= 0 ? row[col.model] || null : null,
      kind: col.kind >= 0 ? row[col.kind] || null : null,
      input: uncached,
      cacheWrite,
      cacheRead,
      output,
      cost: costRaw && /\d/.test(costRaw) ? toNum(costRaw) : null,
    };
    if (!writeCursorEvent(event, sink, seenSessions)) {
      skipped++;
      continue;
    }
    imported++;
  }
  return { rows: rows.length - 1, imported, skipped };
}
