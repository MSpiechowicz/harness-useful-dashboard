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
  enabled: { claude: boolean; codex: boolean; omp: boolean };
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
  limits: { claude: boolean; omp: boolean; codex: boolean };
}

export function defaultConfig(): AppConfig {
  const home = homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexRoot = process.env.CODEX_HOME ?? join(home, ".codex");
  const ompAgent = process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"); // omp's own override
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
      enabled: { claude: true, codex: true, omp: true },
    },
    limits: { claude: true, omp: true, codex: true },
  };
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
