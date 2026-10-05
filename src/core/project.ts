import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ProjectEnv {
  home: string;
  /** Temp roots: anything below them is scratch. */
  temps: string[];
}

export function defaultProjectEnv(): ProjectEnv {
  return { home: homedir(), temps: [tmpdir(), "/tmp", "/var/folders", "/private/var/folders"] };
}

const slashes = (p: string) => p.split(sep).join("/").replace(/\/+$/, "");
const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/**
 * Working directories that are throwaway chat or scratch folders rather than projects:
 * temp dirs, Codex app chats (~/Documents/Codex/<date>/<slug>) and Claude desktop scratch workspaces.
 */
function isScratch(dir: string, env: ProjectEnv): boolean {
  const p = slashes(dir);
  if (env.temps.some((t) => under(p, slashes(t)))) return true;
  if (/\/Claude\/scratch-workspaces(\/|$)/.test(p)) return true;
  const codex = slashes(join(env.home, "Documents", "Codex"));
  return under(p, codex) && /^\d{4}-\d{2}-\d{2}$/.test(p.slice(codex.length + 1).split("/")[0] ?? "");
}

/** Repository root for a `.git` entry: a linked worktree's `.git` file points back into the main repository. */
function repoRoot(dir: string, git: string): string {
  try {
    if (!statSync(git).isFile()) return dir;
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(git, "utf8"))?.[1]?.trim();
    const main = target && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(resolve(dir, target))?.[1];
    return main || dir;
  } catch {
    return dir;
  }
}

/**
 * Maps a session's working directory to the project it belongs to: the enclosing git repository
 * (so sessions started in a subfolder count toward the repo), or the directory itself outside git.
 * Returns null for scratch locations and the bare home directory, which aren't projects.
 * Values that aren't absolute paths are labels from imports (e.g. Cursor CSVs) and pass through unchanged.
 */
export function resolveProject(cwd: string | null | undefined, env: ProjectEnv = defaultProjectEnv()): string | null {
  if (!cwd) return null;
  if (!isAbsolute(cwd)) return cwd;
  const dir = resolve(cwd);
  const home = resolve(env.home);
  if (dir === home || isScratch(dir, env)) return null;
  // Never climb to the home directory or above it: a dotfiles repo in ~ would otherwise swallow everything.
  const stop = dir.startsWith(home + sep) ? home : null;
  for (let d = dir; d !== stop && d !== dirname(d); d = dirname(d)) {
    const git = join(d, ".git");
    if (existsSync(git)) return repoRoot(d, git);
  }
  return dir;
}

/** resolveProject with a per-instance cache; ingest makes one per scan, so new repositories are picked up next time. */
export function projectResolver(env: ProjectEnv = defaultProjectEnv()): (cwd: string | null | undefined) => string | null {
  const cache = new Map<string, string | null>();
  return (cwd) => {
    if (!cwd) return null;
    let hit = cache.get(cwd);
    if (hit === undefined) cache.set(cwd, (hit = resolveProject(cwd, env)));
    return hit;
  };
}

/**
 * Re-maps project paths already stored for this host, so rows ingested before project resolution
 * (or before a folder became a git repository) group the same way as new ones.
 */
export function normalizeProjects(db: Database, host: string, resolveFn: (p: string) => string | null = projectResolver()): number {
  const paths = db
    .query<{ project: string }, [string, string]>(
      "SELECT DISTINCT project FROM usage WHERE host = ? AND project IS NOT NULL UNION SELECT DISTINCT project FROM sessions WHERE host = ? AND project IS NOT NULL",
    )
    .all(host, host)
    .map((r) => r.project);
  let changed = 0;
  db.transaction(() => {
    for (const from of paths) {
      const to = resolveFn(from);
      if (to === from) continue;
      changed++;
      db.query("UPDATE usage SET project = ? WHERE host = ? AND project = ?").run(to, host, from);
      db.query("UPDATE sessions SET project = ? WHERE host = ? AND project = ?").run(to, host, from);
      db.query("UPDATE tool_calls SET project = ? WHERE project = ? AND session_id IN (SELECT id FROM sessions WHERE host = ?)").run(to, from, host);
    }
  })();
  return changed;
}
