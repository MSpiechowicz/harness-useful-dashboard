import type { Database } from "bun:sqlite";

/**
 * A stamp that changes whenever the database's contents may have: this connection's writes (scans, imports, pricing
 * edits) move total_changes(), commits from other connections or machines on a shared database move data_version.
 */
export function dataVersion(db: Database): string {
  const r = db.query<{ own: number; other: number }, []>("SELECT total_changes() AS own, (SELECT data_version FROM pragma_data_version) AS other").get()!;
  return `${r.own}:${r.other}`;
}

interface Entry {
  version: string;
  at: number;
  value: unknown;
}

const caches = new WeakMap<Database, Map<string, Entry>>();
/** Answers kept per database: a handful of views and ranges is what a refresh asks for again. */
const MAX_ENTRIES = 64;

/**
 * Remembers an expensive answer until the data changes. The server answers one request at a time, and a view that
 * scans a year of history (all-time tips, filters, timing) would otherwise run again on every refresh while nothing
 * was written. `maxAgeMs` bounds answers that also depend on the clock (today's date, the range's end).
 */
export function memo<T>(db: Database, key: string, compute: () => T, maxAgeMs = 5 * 60_000): T {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  const version = dataVersion(db);
  const now = Date.now();
  const hit = cache.get(key);
  cache.delete(key);
  if (hit && hit.version === version && now - hit.at < maxAgeMs) {
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = compute();
  cache.set(key, { version, at: now, value });
  // Maps keep insertion order: the first key is the one used least recently.
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}
