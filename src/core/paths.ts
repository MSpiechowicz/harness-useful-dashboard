import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";

export const APP_ID = "harness-dashboard";

/** Per-OS directory for config + default database. */
export function appDataDir(): string {
  if (process.env.HARNESS_DASHBOARD_HOME) return process.env.HARNESS_DASHBOARD_HOME;
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", APP_ID);
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), APP_ID);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), APP_ID);
  }
}

/**
 * Creates the app data folder and keeps it private to this account: it holds prompt text, the config and the app
 * window's browser profile. Earlier versions left it readable by everyone, so existing files are tightened too.
 * Windows keeps the folder private already.
 */
export function ensureAppDataDir(dir = appDataDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  for (const path of [dir, ...["config.json", "ingest-auth.json", "usage.db", "usage.db-wal", "usage.db-shm", "usage.db-journal"].map((f) => join(dir, f))]) {
    try {
      if (existsSync(path)) chmodSync(path, path === dir ? 0o700 : 0o600);
    } catch {
      /* owned by someone else: leave it as it is */
    }
  }
}

export function defaultDbPath(): string {
  return join(appDataDir(), "usage.db");
}

export function configPath(): string {
  return join(appDataDir(), "config.json");
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export function localIdentity(): { user: string; host: string } {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
  return { user, host: hostname() };
}

/** The login shell's PATH, asked once per process; null when it can't be read. */
let shellPath: Promise<string | null> | undefined;

async function loginShellPath(env: Record<string, string | undefined>): Promise<string | null> {
  const shell = env.SHELL || "/bin/sh";
  const mark = "__HARNESS_PATH__";
  try {
    // Interactive too: nvm and the like are set up in .zshrc/.bashrc, not only in the login files.
    const proc = Bun.spawn([shell, "-ilc", `printf '${mark}%s${mark}' "$PATH"`], { env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    return out.split(mark)[1] || null;
  } catch {
    return null;
  }
}

/**
 * PATH for the user's own tools the dashboard runs (omp, gh, claude, codex). An app started from the macOS Dock or
 * Finder inherits only /usr/bin:/bin:/usr/sbin:/sbin: without more, `gh` isn't found, and scripts such as omp
 * (`#!/usr/bin/env bun`) or claude (`#!/usr/bin/env node`) can't start. So the login shell's PATH is added, then the
 * folders where such tools usually live, in case the shell couldn't be asked.
 */
export async function toolPath(env: Record<string, string | undefined>, home: string, platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform === "win32") return env.PATH;
  shellPath ??= loginShellPath(env);
  const dirs = [
    ...(env.PATH ?? "").split(":"),
    ...((await shellPath) ?? "").split(":"),
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(dirs.filter(Boolean))].join(":");
}
