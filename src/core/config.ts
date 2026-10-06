import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, defaultDbPath, expandHome, localIdentity } from "./paths.ts";

export type OpenMode = "app" | "browser" | "none";
export type JournalMode = "auto" | "wal" | "delete";

export interface SourceConfig {
  /** Claude Code transcript roots (each contains per-project folders of *.jsonl). */
  claudeDirs: string[];
  /** Codex home directories (contain sessions/ and archived_sessions/). */
  codexDirs: string[];
  /** omp (oh-my-pi) session roots (contain per-project folders of *.jsonl). */
  ompDirs: string[];
  /** pi session roots, in the same format as omp's. */
  piDirs: string[];
  /** OpenCode data directories (contain storage/ or opencode.db). */
  opencodeDirs: string[];
  /** Zed data directories (contain threads/threads.db). */
  zedDirs: string[];
  /**
   * Read for Cline, Roo Code and Kilo Code: where VS Code and its forks keep extension data (globalStorage), Cline's own
   * data folder, and Kilo Code's.
   */
  clineDirs: string[];
  enabled: { claude: boolean; codex: boolean; omp: boolean; pi: boolean; opencode: boolean; zed: boolean; cline: boolean };
}

export interface AppConfig {
  /** Path to the SQLite database. Empty = default location in the app data dir. */
  dbPath: string;
  /** "auto" = WAL for the default local path, rollback journal for custom (possibly synced/network) paths. */
  journalMode: JournalMode;
  /** Display name stored with every usage row ingested on this machine. */
  userName: string;
  port: number;
  openMode: OpenMode;
  /** Seconds between background incremental scans (0 disables). */
  scanIntervalSec: number;
  /** Max characters of prompt text kept in the database (0 = do not store prompt text). */
  promptTextLimit: number;
  checkUpdates: boolean;
  sources: SourceConfig;
  /** Where the Live view reads how much of each plan limit is left (see limits.ts). */
  limits: { claude: boolean; omp: boolean; codex: boolean; pi: boolean; opencode: boolean };
}

export function defaultConfig(): AppConfig {
  const home = homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexRoot = process.env.CODEX_HOME ?? join(home, ".codex");
  const ompAgent = process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"); // omp's own override
  // pi reads PI_CODING_AGENT_DIR too: that override already goes to omp, so pi keeps its default folder.
  const piAgent = join(home, ".pi", "agent");
  return {
    dbPath: "",
    journalMode: "auto",
    userName: localIdentity().user,
    port: 4317,
    openMode: "app",
    scanIntervalSec: 30,
    promptTextLimit: 2000,
    checkUpdates: true,
    sources: {
      claudeDirs: [join(claudeRoot, "projects")],
      codexDirs: [codexRoot],
      ompDirs: [join(ompAgent, "sessions")],
      piDirs: [join(piAgent, "sessions")],
      opencodeDirs: [opencodeDataDir(home)],
      zedDirs: zedDataDirs(home),
      clineDirs: [...editorStorageDirs(home), clineDataDir(home), join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "kilo")],
      enabled: { claude: true, codex: true, omp: true, pi: true, opencode: true, zed: true, cline: true },
    },
    limits: { claude: true, omp: true, codex: true, pi: true, opencode: true },
  };
}

/** Where OpenCode keeps its data: the XDG data directory on every OS, as it uses xdg-basedir. */
function opencodeDataDir(home: string): string {
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "opencode");
}

/** Zed's data folder on each OS, and on Linux also the one of its Flatpak. */
function zedDataDirs(home: string): string[] {
  if (process.platform === "darwin") return [join(home, "Library", "Application Support", "Zed")];
  if (process.platform === "win32") return [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Zed")];
  return [join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "zed"), join(home, ".var", "app", "dev.zed.Zed", "data", "zed")];
}

/** Cline 4's data folder (also its CLI's and its JetBrains plugin's). Kilo Code 7 keeps its database in the XDG data
 *  folder on every OS, like OpenCode, which it is built on. */
function clineDataDir(home: string): string {
  return process.env.CLINE_DATA_DIR ?? join(process.env.CLINE_DIR ?? join(home, ".cline"), "data");
}

/** Editors that run VS Code extensions, by the folder they keep their settings in. */
const VSCODE_EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

/** Where VS Code and its forks keep extension data: <settings folder>/<editor>/User/globalStorage. */
function editorStorageDirs(home: string): string[] {
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return VSCODE_EDITORS.map((e) => join(base, e, "User", "globalStorage"));
}

function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return {
    ...base,
    ...patch,
    sources: {
      ...base.sources,
      ...(patch.sources ?? {}),
      enabled: { ...base.sources.enabled, ...(patch.sources?.enabled ?? {}) },
    },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  };
}

export function loadConfig(path = configPath()): AppConfig {
  const base = defaultConfig();
  if (!existsSync(path)) return base;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
    return mergeConfig(base, raw);
  } catch (err) {
    console.warn(`[config] could not parse ${path}: ${(err as Error).message}; using defaults`);
    return base;
  }
}

export function saveConfig(cfg: AppConfig, path = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n");
}

export function updateConfig(patch: Partial<AppConfig>, path = configPath()): AppConfig {
  const next = mergeConfig(loadConfig(path), patch);
  saveConfig(next, path);
  return next;
}

/** Resolve the effective DB path: CLI flag > env > config > default. */
export function resolveDbPath(cfg: AppConfig, cliOverride?: string): { path: string; isDefault: boolean } {
  const chosen = cliOverride || process.env.HARNESS_DASHBOARD_DB || cfg.dbPath;
  if (!chosen) return { path: defaultDbPath(), isDefault: true };
  const path = expandHome(chosen);
  return { path, isDefault: path === defaultDbPath() };
}
