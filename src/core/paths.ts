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
  for (const path of [dir, ...["config.json", "usage.db", "usage.db-wal", "usage.db-shm", "usage.db-journal"].map((f) => join(dir, f))]) {
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
