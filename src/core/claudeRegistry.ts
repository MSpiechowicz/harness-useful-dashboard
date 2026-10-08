import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AppConfig } from "./config.ts";

/**
 * Which Claude Code sessions are still open on this machine. Claude Code keeps a registry of its running processes,
 * `<config root>/sessions/<pid>.json`, each naming its pid and session id. A session whose process is gone is closed.
 * The `*.key` files next to them are secrets and are never opened: only names like `123.json` are read.
 */

/** Claude Code's config roots: the folder above each configured projects folder, and `$CLAUDE_CONFIG_DIR`. */
export function claudeRoots(cfg: AppConfig, env: Record<string, string | undefined> = process.env): string[] {
  const roots = cfg.sources.claudeDirs.map((d) => dirname(resolve(d)));
  if (env.CLAUDE_CONFIG_DIR) roots.push(resolve(env.CLAUDE_CONFIG_DIR));
  return [...new Set(roots)];
}

const ENTRY_NAME = /^\d+\.json$/;
const MAX_ENTRY_BYTES = 64 * 1024;
const CACHE_MS = 15_000;

const cache = new Map<string, { at: number; value: Set<string> | null }>();

/**
 * The native session ids of the Claude Code sessions whose process is alive, read at most every 15 seconds. Null when
 * there is no registry to judge by: no `sessions/` folder in any root, or Windows.
 */
export function liveClaudeSessions(roots: string[], now = Date.now()): Set<string> | null {
  if (process.platform === "win32") return null;

  const key = roots.join("\0");
  const hit = cache.get(key);
  if (hit && now >= hit.at && now - hit.at < CACHE_MS) return hit.value;

  const value = readRegistry(roots);
  cache.set(key, { at: now, value });
  return value;
}

function readRegistry(roots: string[]): Set<string> | null {
  let found = false;
  const live = new Set<string>();

  for (const root of roots) {
    const dir = join(root, "sessions");
    let names: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      names = readdirSync(dir);
    } catch {
      continue;
    }
    found = true;

    for (const name of names) {
      if (!ENTRY_NAME.test(name)) continue;

      const entry = readEntry(join(dir, name));
      if (entry && isAlive(entry.pid, entry.procStart)) live.add(entry.sessionId);
    }
  }

  return found ? live : null;
}

interface Entry {
  pid: number;
  sessionId: string;
  procStart: string | null;
}

/** One registry file, when it is a small regular file holding a pid and a session id. */
function readEntry(path: string): Entry | null {
  let text: string;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_ENTRY_BYTES) return null;
    text = readSmallFile(path);
  } catch {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;

  const { pid, sessionId, procStart } = json as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return null;
  if (typeof sessionId !== "string" || !sessionId) return null;

  const start = typeof procStart === "string" || typeof procStart === "number" ? String(procStart) : null;
  return { pid, sessionId, procStart: start };
}

/** Reads a file without following a link swapped in since it was checked, and no more than the size limit. */
function readSmallFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ENTRY_BYTES) throw new Error("not a small regular file");
    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether a process is running: signal 0 reaches it, or it exists but belongs to someone else (EPERM). On Linux a pid
 * reused by a newer process is told apart by its start time, field 22 of /proc/<pid>/stat.
 */
function isAlive(pid: number, procStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }

  if (process.platform !== "linux" || procStart == null) return true;

  const started = linuxStartTime(pid);
  return started == null || started === procStart;
}

function linuxStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }

  // The command name (field 2) is in parentheses and may hold spaces: fields are counted after its closing one.
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(" ");
  return fields[22 - 3] ?? null;
}
