/**
 * Table export: CSV (RFC 4180, UTF-8 with a BOM so Excel reads it right) and JSON, built from the rows a card has.
 * Column keys are the rows' own field names (English, stable), numbers stay raw and timestamps become ISO 8601.
 * Pure functions, unit tested in tests/export.test.ts. The download itself is in ExportMenu.svelte.
 */

export type Cell = string | number | boolean | null;
export type ExportRow = Record<string, Cell>;
export type ExportFormat = "csv" | "json";

const BOM = "﻿";

/** A field holding epoch milliseconds: `ts`, `lastTs`, `firstTs`, `startedAt`… */
const isTimeKey = (k: string) => k === "ts" || /(Ts|At)$/.test(k);

/** One table row as flat cells: timestamps to ISO 8601, a list of words (tags) joined, other nested values to JSON text, everything else as it is. */
export function normalizeRow(row: object): ExportRow {
  const out: ExportRow = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || typeof v === "function") continue;
    if (typeof v === "number" && isTimeKey(k) && Number.isFinite(v) && v > 1e11) out[k] = new Date(v).toISOString();
    else if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string" && !x.includes(", "))) out[k] = v.join(", ");
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** Every key the rows have, in the order they first appear. */
export function columnsOf(rows: ExportRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

/**
 * One CSV field. Text a spreadsheet would run as a formula (= + - @, tab, CR first) gets a leading apostrophe,
 * numbers never do. Fields with a comma, quote or line break are quoted, quotes doubled.
 */
export function csvField(v: Cell | undefined): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV text (header row, CRLF line ends, no BOM). */
export function toCsv(rows: ExportRow[], columns: string[] = columnsOf(rows)): string {
  const lines = [columns.map(csvField).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function toJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2) + "\n";
}

/** The file's contents as saved: CSV starts with a BOM. */
export function exportText(rows: readonly unknown[], format: ExportFormat): string {
  const flat = rows.map((r) => (r !== null && typeof r === "object" ? normalizeRow(r) : normalizeRow({ value: r })));
  return format === "csv" ? BOM + toCsv(flat) : toJson(flat);
}

/** `harness-dashboard-sessions-2026-10-07.csv`, dated in local time. */
export function exportFilename(name: string, format: ExportFormat, date = new Date()): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table";
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `harness-dashboard-${slug}-${day}.${format}`;
}

/** A chart's time series as table rows: one per bucket, a column per series key (and `total` when asked). */
export function seriesRows(ts: { buckets: string[]; series: { key: string; data: number[] }[] }, total = false): ExportRow[] {
  return ts.buckets.map((bucket, i) => {
    const row: ExportRow = { bucket };
    let sum = 0;
    for (const se of ts.series) {
      const v = se.data[i] ?? 0;
      row[se.key] = v;
      sum += v;
    }
    if (total) row.total = sum;
    return row;
  });
}
