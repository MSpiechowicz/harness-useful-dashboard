import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppConfig } from "../config.ts";
import { setMeta } from "../db.ts";
import { expandHome } from "../paths.ts";
import { PriceBook } from "../pricing.ts";
import { normalizeProjects } from "../project.ts";
import { claudeParser } from "./claude.ts";
import { codexParser } from "./codex.ts";
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
  // Parse main transcripts before subagent transcripts so spawn refs resolve in one pass.
  files.sort((a, b) => Number(a.path.includes("subagents")) - Number(b.path.includes("subagents")) || a.path.localeCompare(b.path));
  return files;
}

const NEWLINE = 0x0a;
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

  if (opts.full) db.query("DELETE FROM ingest_files WHERE host = ?").run(identity.host);
  const getState = db.prepare<{ size: number; mtime: number; offset: number; state: string | null }, [string, string]>(
    "SELECT size, mtime, offset, state FROM ingest_files WHERE host = ? AND path = ?",
  );
  const putState = db.prepare(
    "INSERT OR REPLACE INTO ingest_files (host, path, size, mtime, offset, state) VALUES (?, ?, ?, ?, ?, ?)",
  );

  let done = 0;
  for (const file of files) {
    done++;
    try {
      const st = statSync(file.path);
      const mtime = Math.floor(st.mtimeMs);
      const prev = getState.get(identity.host, file.path);
      if (prev && prev.size === st.size && prev.mtime === mtime) continue;

      let offset = prev?.offset ?? 0;
      let state = prev?.state ? JSON.parse(prev.state) : file.parser.initialState(file.path);
      if (st.size < offset) {
        // File was truncated or rewritten: start over (upserts keep this idempotent).
        offset = 0;
        state = file.parser.initialState(file.path);
      }
      if (st.size > offset) {
        const handle = Bun.file(file.path);
        while (offset < st.size) {
          const end = Math.min(st.size, offset + SLICE_BYTES);
          const buf = new Uint8Array(await handle.slice(offset, end).arrayBuffer());
          let { lines, consumed } = splitLines(buf, offset);
          if (consumed === 0) {
            // No newline in this slice: either a trailing partial line (wait for more) or a huge line.
            if (end < st.size) {
              offset = end; // skip pathological >32MB line
              continue;
            }
            break;
          }
          db.transaction(() => {
            state = file.parser.parse(lines, { path: file.path, baseOffset: offset, promptTextLimit: cfg.promptTextLimit }, state, writer);
          })();
          lines = [];
          offset += consumed;
        }
        result.filesParsed++;
      }
      putState.run(identity.host, file.path, st.size, mtime, offset, JSON.stringify(state));
    } catch (err) {
      result.errors.push({ path: file.path, error: (err as Error).message });
    }
    opts.onProgress?.(done, files.length);
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
          const stamp = sqliteStamp(path);
          const prev = getState.get(identity.host, path);
          if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) continue;
          let latest = 0;
          db.transaction(() => {
            latest = source.ingest(path, writer, { since: prev?.offset ?? 0, promptTextLimit: cfg.promptTextLimit });
          })();
          putState.run(identity.host, path, stamp.size, stamp.mtime, latest, null);
          result.filesParsed++;
        } catch (err) {
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
  for (const file of jsonFiles) {
    result.filesSeen++;
    try {
      const stamp = fileStamp(file.path);
      if (!stamp) continue;
      const prev = getState.get(identity.host, file.path);
      if (prev && prev.size === stamp.size && prev.mtime === stamp.mtime) continue;
      db.transaction(file.ingest)();
      putState.run(identity.host, file.path, stamp.size, stamp.mtime, 0, null);
      result.filesParsed++;
    } catch (err) {
      result.errors.push({ path: file.path, error: (err as Error).message });
    }
  }

  // A scan that found nothing new writes nothing: on a database in a synced folder every write is another upload,
  // on every machine, every 30 seconds. The tidy-ups below only write when they change something.
  if (result.filesParsed > 0) {
    resolveSpawnRefs(db);
    setMeta(db, `last_scan:${identity.host}`, String(Date.now()));
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
