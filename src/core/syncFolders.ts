import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { expandHome } from "./paths.ts";

/** A folder that a sync client keeps the same on every machine, found on this one. */
export interface SyncFolder {
  name: string;
  path: string;
}

/** What the dashboard calls its folder inside a synced folder. */
export const SHARED_FOLDER = "Harness Dashboard";
/** The database file the dashboard keeps in a folder it is pointed at. */
export const DB_FILE = "usage.db";

interface Env {
  home: string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const list = (p: string) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** Dropbox writes where its folders are to info.json: personal and business can both be there. */
function dropbox({ home, platform, env }: Env): string[] {
  const infos =
    platform === "win32"
      ? [join(env.APPDATA ?? "", "Dropbox", "info.json"), join(env.LOCALAPPDATA ?? "", "Dropbox", "info.json")]
      : [join(home, ".dropbox", "info.json")];
  const fromInfo = infos.flatMap((f) => {
    try {
      const info = JSON.parse(readFileSync(f, "utf8")) as Record<string, { path?: string }>;
      return Object.values(info).flatMap((a) => (a?.path ? [a.path] : []));
    } catch {
      return [];
    }
  });
  return [...fromInfo, join(home, "Library", "CloudStorage", "Dropbox"), join(home, "Dropbox")];
}

/** macOS File Provider folders: ~/Library/CloudStorage/<Provider>-<account>. */
function cloudStorage(home: string, prefix: string): string[] {
  const root = join(home, "Library", "CloudStorage");
  return list(root)
    .filter((d) => d.startsWith(prefix))
    .map((d) => join(root, d));
}

/** Google Drive puts "My Drive" (localized) next to shared drives. Pick the user's own. */
function googleDrive({ home, platform }: Env): string[] {
  if (platform === "darwin") {
    return cloudStorage(home, "GoogleDrive").map((root) => {
      const own = list(root).find((d) => !d.startsWith(".") && !/shared drives|other computers|geteilte ablagen|andere computer/i.test(d));
      return own ? join(root, own) : root;
    });
  }
  if (platform === "win32") return ["G:\\My Drive", "G:\\Meine Ablage"];
  return [join(home, "Google Drive"), join(home, "GoogleDrive")];
}

/** Every synced folder this machine has, in a fixed order, each once. */
export function findSyncFolders(e: Env = { home: homedir(), platform: process.platform, env: process.env }): SyncFolder[] {
  const { home, platform, env } = e;
  const candidates: [string, string[]][] = [
    ["iCloud Drive", platform === "darwin" ? [join(home, "Library", "Mobile Documents", "com~apple~CloudDocs")] : platform === "win32" ? [join(home, "iCloudDrive")] : []],
    ["Dropbox", dropbox(e)],
    [
      "OneDrive",
      [
        ...[env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((p): p is string => !!p),
        ...(platform === "darwin" ? cloudStorage(home, "OneDrive") : []),
        join(home, "OneDrive"),
      ],
    ],
    ["Google Drive", googleDrive(e)],
    ["Box", [...(platform === "darwin" ? cloudStorage(home, "Box") : []), join(home, "Box")]],
    ["Nextcloud", [join(home, "Nextcloud")]],
    ["Syncthing", [join(home, "Sync")]],
  ];
  const seen = new Set<string>();
  const found: SyncFolder[] = [];
  for (const [name, paths] of candidates) {
    for (const path of paths) {
      if (!isDir(path)) continue;
      const real = realpathSync(path);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push({ name, path });
    }
  }
  return found;
}

/**
 * Where a database setting points: a folder holds usage.db, a path ending in .db (or .sqlite) is the file itself.
 * Empty means the default location.
 */
export function dbFileFor(input: string): string {
  const p = expandHome(input.trim());
  if (!p) return "";
  return /\.(db|sqlite3?)$/i.test(p) ? p : join(p, DB_FILE);
}

export type DbTargetState = "default" | "current" | "existing" | "new" | "missing" | "invalid";

/**
 * What saving a database setting would do. "existing" joins a database another machine already keeps there, "new"
 * creates one (the folder itself may be created, its parent must exist so a typo can't quietly make an unsynced
 * folder), "missing" and "invalid" can't be saved.
 */
export function dbTarget(input: string, current: string, defaultPath: string): { file: string; state: DbTargetState } {
  const file = dbFileFor(input);
  if (!file) return { file: defaultPath, state: defaultPath === current ? "current" : "default" };
  if (!isAbsolute(file)) return { file, state: "invalid" };
  if (file === current) return { file, state: "current" };
  if (existsSync(file)) return { file, state: "existing" };
  const folder = dirname(file);
  return { file, state: isDir(folder) || isDir(dirname(folder)) ? "new" : "missing" };
}
