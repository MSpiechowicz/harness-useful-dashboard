import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import { optimize, setMeta } from "../db.ts";
import { expandHome } from "../paths.ts";
import { PriceBook } from "../pricing.ts";
import { normalizeProjects } from "../project.ts";
import { claudeParser } from "./claude.ts";
import { codexParser } from "./codex.ts";
import { copilotParser } from "./copilot.ts";
import { geminiParser, ingestGeminiJson } from "./gemini.ts";
import { ompParser, piParser } from "./omp.ts";
import { ingestOpencode, opencodeDatabases, sqliteStamp } from "./opencode.ts";
import { ingestZed, zedDatabases } from "./zed.ts";
import { clineSessionFiles, clineSessionIndex, fileStamp, findClineSources, ingestClineSession, ingestClineTask, KILO, taskLastTs } from "./cline.ts";
import type { LineParser } from "./types.ts";
import { DbWriter, resolveSpawnRefs } from "./writer.ts";

export interface ScanResult {
  filesSeen: number;
  filesParsed: number;
  usageRows: number;
  prompts: number;
  tools: number;
  errors: { path: string; error: string }[];
  durationMs: number;
}

interface SourceFile {
  path: string;
  parser: LineParser<any>;
}

async function listFiles(root: string, patterns: string[]): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const f of glob.scan({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })) out.push(f);
  }
  return out;
}

export async function discoverFiles(cfg: AppConfig): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  if (cfg.sources.enabled.claude) {
    for (const dir of cfg.sources.claudeDirs) {
      for (const path of await listFiles(expandHome(dir), ["**/*.jsonl"])) files.push({ path, parser: claudeParser });
    }
  }
  if (cfg.sources.enabled.codex) {
    for (const dir of cfg.sources.codexDirs) {
      const root = expandHome(dir);
      for (const path of await listFiles(root, ["sessions/**/*.jsonl", "archived_sessions/**/*.jsonl"])) {
        files.push({ path, parser: codexParser });
      }
    }
  }
  const ompRoots = cfg.sources.enabled.omp ? cfg.sources.ompDirs.map((d) => resolve(expandHome(d))) : [];
  for (const root of ompRoots) {
    for (const path of await listFiles(root, ["**/*.jsonl"])) files.push({ path, parser: ompParser });
  }
  if (cfg.sources.enabled.pi) {
    // pi and omp share a format and an environment variable: a folder set up for both is read once, as omp's.
    for (const dir of cfg.sources.piDirs ?? []) {
      const root = resolve(expandHome(dir));
      if (ompRoots.includes(root)) continue;
      for (const path of await listFiles(root, ["**/*.jsonl"])) files.push({ path, parser: piParser });
    }
  }
  if (cfg.sources.enabled.gemini) {
    // Chats since v0.39, a subagent's in a folder named after its parent. Older .json chats are read whole, below.
    for (const dir of cfg.sources.geminiDirs ?? []) {
      for (const path of await listFiles(expandHome(dir), ["tmp/*/chats/*.jsonl", "tmp/*/chats/*/*.jsonl"])) files.push({ path, parser: geminiParser });
    }
  }
  if (cfg.sources.enabled.copilot) {
    for (const dir of cfg.sources.copilotDirs ?? []) {
      for (const path of await listFiles(expandHome(dir), ["session-state/*/events.jsonl"])) files.push({ path, parser: copilotParser });
    }
  }
  // Parse main transcripts before subagent transcripts so spawn refs resolve in one pass.
  files.sort((a, b) => Number(a.path.includes("subagents")) - Number(b.path.includes("subagents")) || a.path.localeCompare(b.path));
  return files;
}

const NEWLINE = 0x0a;
const CLOSE_BRACE = 0x7d;
const decoder = new TextDecoder();

/** Splits a byte buffer into complete lines, returning them with absolute byte offsets. */
export function splitLines(buf: Uint8Array, baseOffset: number): { lines: { text: string; offset: number }[]; consumed: number } {
  const lines: { text: string; offset: number }[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== NEWLINE) continue;
    if (i > start) {
      const text = decoder.decode(buf.subarray(start, i)).trim();
      if (text) lines.push({ text, offset: baseOffset + start });
    }
    start = i + 1;
  }
  return { lines, consumed: start };
}

/** Bytes read per pass; large transcripts are processed in slices to bound memory. */
const SLICE_BYTES = 32 * 1024 * 1024;
/** New bytes up to which a file is read at once, in a transaction shared with other small files. */
const SMALL_BYTES = 1024 * 1024;
/**
 * A last line with no newline after it is read once the file has stopped changing for this long: a line still being
 * written is never cut off, and a log that simply doesn't end in a newline isn't missed.
 */
const TAIL_SETTLE_MS = 10 * 60_000;

/**
 * The last line of a file that ends without a newline, when it has settled and is a whole JSON record. Logs are JSON
 * lines, so a record that parses is complete. Anything else waits.
 */
export function settledTail(rest: Uint8Array, mtimeMs: number, now = Date.now()): string | null {
  if (!rest.length || now - mtimeMs < TAIL_SETTLE_MS) return null;
  const text = decoder.decode(rest).trim();
  if (!text.startsWith("{")) return null;
  try {
    JSON.parse(text);
    return text;
  } catch {
    return null;
  }
}

/** Small files per shared transaction. */
const BATCH_FILES = 200;

function readRange(path: string, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return read < length ? buf.subarray(0, read) : buf;
  } finally {
    closeSync(fd);
  }
}

/**
 * Files whose last read failed, and when to try them again. A file that keeps failing would otherwise be read again on
 * every scan: the wait doubles from 30 seconds up to an hour, and a full rescan tries them all again.
 */
const failing = new Map<string, { count: number; retryAt: number }>();

function backingOff(path: string): boolean {
  const f = failing.get(path);
  return f != null && Date.now() < f.retryAt;
}

function failed(path: string): void {
  const count = (failing.get(path)?.count ?? 0) + 1;
  failing.set(path, { count, retryAt: Date.now() + Math.min(60 * 60_000, 30_000 * 2 ** (count - 1)) });
}

function succeeded(path: string): void {
  failing.delete(path);
}

export async function scan(
  db: Database,
  cfg: AppConfig,
  identity: { user: string; host: string },
  opts: { full?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ScanResult> {
  const started = performance.now();
  const prices = PriceBook.fromDb(db);
  const writer = new DbWriter(db, prices, identity);
  const files = await discoverFiles(cfg);
  const result: ScanResult = { filesSeen: files.length, filesParsed: 0, usageRows: 0, prompts: 0, tools: 0, errors: [], durationMs: 0 };

  if (opts.full) {
    db.query("DELETE FROM ingest_files WHERE host = ?").run(identity.host);
    failing.clear();
  }
  const getState = db.prepare<{ size: number; mtime: number; offset: number; state: string | null }, [string, string]>(
    "SELECT size, mtime, offset, state FROM ingest_files WHERE host = ? AND path = ?",
  );
  const putState = db.prepare(
    "INSERT OR REPLACE INTO ingest_files (host, path, size, mtime, offset, state) VALUES (?, ?, ?, ?, ?, ?)",
  );

  // Small files (most of them on a first scan) are read in one go and share a transaction, committed every so many
  // files: on a first scan of a few thousand transcripts the commits per file were much of the time, more so on a disk
  // that syncs slowly. Nothing awaits while that transaction is open, so no request runs inside it. Each file still
  // gets a savepoint of its own, so one that fails leaves the others in the batch alone.
  let batched = 0;
  const commit = () => {
    if (db.inTransaction) db.exec("COMMIT");
    batched = 0;
  };
  let done = 0;
  // A savepoint's undo log is a temporary file by default: one per file in a batch made the batch slower than a
  // commit per file. Kept in memory while the batches run.
  db.exec("PRAGMA temp_store = MEMORY");
  try {
    for (const file of files) {
      done++;
      if (backingOff(file.path)) continue;
      try {
        const st = statSync(file.path);
        const mtime = Math.floor(st.mtimeMs);
        const prev = getState.get(identity.host, file.path);
        // An unchanged file is skipped, unless it ends in a line without a newline that has had time to settle.
        const tailDue = !!prev && prev.offset < st.size && st.size - prev.offset <= SMALL_BYTES && Date.now() - mtime >= TAIL_SETTLE_MS;
        const unchanged = !!prev && prev.size === st.size && prev.mtime === mtime;
        if (unchanged && !tailDue) continue;

        let offset = prev?.offset ?? 0;
        let state = prev?.state ? JSON.parse(prev.state) : file.parser.initialState(file.path);
        // Reading goes on from the end of the last whole line, so a newline (or the closing brace of a settled last
        // record) comes right before it. Anything else: the file was rewritten since, e.g. rewound and written on.
        const rewritten = offset > 0 && offset <= st.size && ![NEWLINE, CLOSE_BRACE].includes(readRange(file.path, offset - 1, 1)[0]!);
        if (st.size < offset || rewritten) {
          // File was truncated or rewritten: start over (upserts keep this idempotent).
          offset = 0;
          state = file.parser.initialState(file.path);
        }
        const from = offset;
        const ctx = { path: file.path, promptTextLimit: cfg.promptTextLimit };
        if (st.size - offset <= SMALL_BYTES) {
          if (!db.inTransaction) db.exec("BEGIN");
          const buf = st.size > offset ? readRange(file.path, offset, st.size - offset) : new Uint8Array(0);
          let { lines, consumed } = splitLines(buf, offset);
          const tail = settledTail(buf.subarray(consumed), mtime);
          if (tail) {
            lines = [...lines, { text: tail, offset: offset + consumed }];
            consumed = buf.length;
          } else if (unchanged) {
            // Looked at only for its last line, which isn't a whole record: nothing to write, as in any idle scan.
            continue;
          }
          db.transaction(() => {
            if (lines.length) state = file.parser.parse(lines, { ...ctx, baseOffset: offset }, state, writer);
            putState.run(identity.host, file.path, st.size, mtime, offset + consumed, JSON.stringify(state));
          })();
          if (++batched >= BATCH_FILES) commit();
        } else {
          commit();
          const handle = Bun.file(file.path);
          let saved = false;
          while (offset < st.size) {
            const end = Math.min(st.size, offset + SLICE_BYTES);
            const buf = new Uint8Array(await handle.slice(offset, end).arrayBuffer());
            const { lines, consumed } = splitLines(buf, offset);
            if (consumed === 0) {
              // No newline in this slice: either a trailing partial line (wait for more) or a huge line.
              if (end < st.size) {
                offset = end; // skip pathological >32MB line
                saved = false;
                continue;
              }
              break;
            }
            // The offset is saved with the lines it covers, so a scan that stops halfway (an error, the app quitting)
            // goes on from there. The size is saved once the read reaches the end: until then the file counts as changed.
            const base = offset;
            db.transaction(() => {
              state = file.parser.parse(lines, { ...ctx, baseOffset: base }, state, writer);
              putState.run(identity.host, file.path, end === st.size ? st.size : -1, mtime, base + consumed, JSON.stringify(state));
            })();
            offset += consumed;
            saved = end === st.size;
          }
          if (!saved) putState.run(identity.host, file.path, st.size, mtime, offset, JSON.stringify(state));
        }
        if (st.size > from) result.filesParsed++;
        succeeded(file.path);
      } catch (err) {
        failed(file.path);
        result.errors.push({ path: file.path, error: (err as Error).message });
      }
      opts.onProgress?.(done, files.length);
    }
  } finally {
    commit();
    db.exec("PRAGMA temp_store = DEFAULT");
  }

  // OpenCode and Zed keep a database rather than log files: read what changed since the last scan, when it changed
  // at all.
  // Kilo Code 7 writes OpenCode's schema: read with the OpenCode reader, as Kilo Code's.
  const families = [
    { family: "cline" as const, on: cfg.sources.enabled.cline, dirs: cfg.sources.clineDirs ?? [] },
    { family: "roo" as const, on: cfg.sources.enabled.roo, dirs: cfg.sources.rooDirs ?? [] },
    { family: "kilo" as const, on: cfg.sources.enabled.kilo, dirs: cfg.sources.kiloDirs ?? [] },
  ];
  const cline = families.flatMap((f) => (f.on ? f.dirs.map((d) => findClineSources(expandHome(d), f.family)) : []));
  const databases: { enabled: boolean; dirs: string[]; find: (dir: string) => string[]; ingest: typeof ingestOpencode }[] = [
    { enabled: cfg.sources.enabled.opencode, dirs: cfg.sources.opencodeDirs ?? [], find: opencodeDatabases, ingest: ingestOpencode },
    { enabled: cfg.sources.enabled.zed, dirs: cfg.sources.zedDirs ?? [], find: zedDatabases, ingest: ingestZed },
    { enabled: cline.length > 0, dirs: ["kilo"], find: () => [...new Set(cline.flatMap((c) => c.kiloDatabases))], ingest: (path, sink, o) => ingestOpencode(path, sink, { ...o, flavor: KILO }) },
  ];
  for (const source of databases) {
    if (!source.enabled) continue;
    for (const dir of source.dirs) {
      for (const path of source.find(expandHome(dir))) {
        result.filesSeen++;
        try {
          if (backingOff(path)) continue;
          const stamp = sqliteStamp(path);
          const prev = getState.get(identity.host, path);
          if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) continue;
          db.transaction(() => {
            const latest = source.ingest(path, writer, { since: prev?.offset ?? 0, promptTextLimit: cfg.promptTextLimit });
            putState.run(identity.host, path, stamp.size, stamp.mtime, latest, null);
          })();
          result.filesParsed++;
          succeeded(path);
        } catch (err) {
          failed(path);
          result.errors.push({ path, error: (err as Error).message });
        }
      }
    }
  }

  // Cline, Roo Code and Kilo Code task folders and Cline 4 sessions: whole JSON files, read again when they change.
  // A folder listed under more than one extension is read once.
  const tasks = [...new Map(cline.flatMap((c) => c.tasks).map((t) => [t.dir, t])).values()];
  const legacyTasks = new Map(tasks.map((t) => [t.dir.split(/[\\/]/).pop()!, t.dir]));
  const jsonFiles: { path: string; ingest: () => void }[] = tasks.map((task) => ({
    path: join(task.dir, "ui_messages.json"),
    ingest: () => void ingestClineTask(task, writer, { promptTextLimit: cfg.promptTextLimit }),
  }));
  for (const root of new Set(cline.flatMap((c) => c.sessionRoots))) {
    const index = clineSessionIndex(root);
    for (const file of clineSessionFiles(root)) {
      jsonFiles.push({
        path: file.path,
        ingest: () => {
          const legacy = legacyTasks.get(file.sessionId);
          ingestClineSession(file, index.get(file.sessionId), writer, { promptTextLimit: cfg.promptTextLimit, legacyUntil: legacy ? taskLastTs(legacy) : 0 });
        },
      });
    }
  }
  // Gemini CLI chats from before v0.39: one JSON object each.
  if (cfg.sources.enabled.gemini) {
    for (const dir of cfg.sources.geminiDirs ?? []) {
      for (const path of await listFiles(expandHome(dir), ["tmp/*/chats/*.json", "tmp/*/chats/*/*.json"])) {
        jsonFiles.push({ path, ingest: () => ingestGeminiJson(path, writer, { promptTextLimit: cfg.promptTextLimit }) });
      }
    }
  }
  for (const file of jsonFiles) {
    result.filesSeen++;
    if (backingOff(file.path)) continue;
    try {
      const stamp = fileStamp(file.path);
      if (!stamp) continue;
      const prev = getState.get(identity.host, file.path);
      if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) continue;
      db.transaction(() => {
        file.ingest();
        putState.run(identity.host, file.path, stamp.size, stamp.mtime, 0, null);
      })();
      result.filesParsed++;
      succeeded(file.path);
    } catch (err) {
      failed(file.path);
      result.errors.push({ path: file.path, error: (err as Error).message });
    }
  }

  // A scan that found nothing new writes nothing: on a database in a synced folder every write is another upload,
  // on every machine, every 30 seconds. The tidy-ups below only write when they change something.
  if (result.filesParsed > 0) {
    resolveSpawnRefs(db);
    setMeta(db, `last_scan:${identity.host}`, String(Date.now()));
    // New rows can change which index suits a query best: the planner's statistics follow when tables grew a lot.
    optimize(db);
  }
  normalizeProjects(db, identity.host, writer.project);
  applyCodexTitles(db, cfg);
  result.usageRows = writer.stats.usage;
  result.prompts = writer.stats.prompts;
  result.tools = writer.stats.tools;
  result.durationMs = Math.round(performance.now() - started);
  return result;
}

/** Codex keeps thread names in session_index.jsonl rather than in the transcripts. */
function applyCodexTitles(db: Database, cfg: AppConfig): void {
  if (!cfg.sources.enabled.codex) return;
  const upd = db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title != ?)");
  for (const dir of cfg.sources.codexDirs) {
    const idx = join(expandHome(dir), "session_index.jsonl");
    if (!existsSync(idx)) continue;
    db.transaction(() => {
      for (const line of readFileSync(idx, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as { id?: string; thread_name?: string };
          if (r.id && r.thread_name) upd.run(r.thread_name, `codex:${r.id}`, r.thread_name);
        } catch {
          /* ignore malformed line */
        }
      }
    })();
  }
}
