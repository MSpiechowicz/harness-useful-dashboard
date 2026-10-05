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

function hash(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 20);
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
    if (!uncached && !output && !cacheRead && !cacheWrite) {
      skipped++;
      continue;
    }
    const user = col.user >= 0 ? row[col.user] || null : null;
    const day = new Date(ts).toISOString().slice(0, 10);
    const sessionId = `cursor:${user ?? "local"}:${day}`;
    if (!seenSessions.has(sessionId)) {
      seenSessions.add(sessionId);
      sink.session({ id: sessionId, provider: "cursor", nativeId: day, project: "Cursor", title: `Cursor usage ${day}`, client: "cursor", startedAt: ts, endedAt: ts });
    } else sink.session({ id: sessionId, provider: "cursor", nativeId: day, startedAt: ts, endedAt: ts });
    const costRaw = col.cost >= 0 ? row[col.cost] : undefined;
    const cost = costRaw && /\d/.test(costRaw) ? toNum(costRaw) : null;
    sink.usage({
      id: `cursor:${hash(row.join("\u0001"))}`,
      provider: "cursor",
      sessionId,
      promptId: null,
      ts,
      project: "Cursor",
      model: col.model >= 0 ? row[col.model] || null : null,
      skill: null,
      agent: col.kind >= 0 && row[col.kind] ? row[col.kind]! : "main",
      isSubagent: false,
      input: uncached,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h: 0,
      reasoning: 0,
      costUsd: cost,
      user,
    });
    imported++;
  }
  return { rows: rows.length - 1, imported, skipped };
}
