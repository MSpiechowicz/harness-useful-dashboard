import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AlertLang, type BudgetConfig, DEFAULT_BUDGETS } from "./budgets.ts";
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
  /** Cline's folders in VS Code's (and its forks', and JetBrains') extension storage, and its own data folder. */
  clineDirs: string[];
  /** Roo Code's folders in VS Code's (and its forks') extension storage. */
  rooDirs: string[];
  /** Kilo Code's folders in VS Code's (and its forks') extension storage, and its own data folder (kilo.db). */
  kiloDirs: string[];
  /** Gemini CLI home directories (contain tmp/<project>/chats/). */
  geminiDirs: string[];
  /** GitHub Copilot CLI home directories (contain session-state/). */
  copilotDirs: string[];
  enabled: { claude: boolean; codex: boolean; omp: boolean; pi: boolean; opencode: boolean; zed: boolean; cline: boolean; roo: boolean; kilo: boolean; gemini: boolean; copilot: boolean };
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
  /** What each plan or account costs a month in USD, keyed like the billing breakdown ("claude", "openai-codex", …). */
  planPrices: Record<string, number>;
  /** Spending caps and the desktop alerts that come with them (see budgets.ts). */
  budgets: BudgetConfig;
  /** The UI's language, which the desktop alerts use too. */
  language: AlertLang;
  /** Tips the user put away: `hidden` holds rule ids (never shown again), `read` holds tip keys (seen, kept on the Tips page). */
  tips: TipState;
}

export interface TipState {
  hidden: string[];
  read: string[];
}

export function defaultConfig(): AppConfig {
  const home = homedir();
  const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const codexRoot = process.env.CODEX_HOME ?? join(home, ".codex");
  const ompAgent = process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent"); // omp's own override
  // pi reads PI_CODING_AGENT_DIR too: that override already goes to omp, so pi keeps its default folder.
  const piAgent = join(home, ".pi", "agent");
  // Gemini CLI's GEMINI_CLI_HOME stands in for the home folder, Copilot CLI's COPILOT_HOME for its own folder.
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
      clineDirs: extensionDirs(home, "saoudrizwan.claude-dev", [clineDataDir(home)], true),
      rooDirs: extensionDirs(home, "rooveterinaryinc.roo-cline", []),
      kiloDirs: extensionDirs(home, "kilocode.kilo-code", [join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "kilo")]),
      geminiDirs: [join(process.env.GEMINI_CLI_HOME ?? home, ".gemini")],
      copilotDirs: [process.env.COPILOT_HOME ?? join(home, ".copilot")],
      enabled: { claude: true, codex: true, omp: true, pi: true, opencode: true, zed: true, cline: true, roo: true, kilo: true, gemini: true, copilot: true },
    },
    limits: { claude: true, omp: true, codex: true, pi: true, opencode: true },
    planPrices: {},
    budgets: { ...DEFAULT_BUDGETS, projects: {} },
    language: "en",
    tips: { hidden: [], read: [] },
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

/** The folder apps keep their settings in: ~/.config, ~/Library/Application Support, %APPDATA%. */
function settingsBase(home: string): string {
  if (process.platform === "darwin") return join(home, "Library", "Application Support");
  if (process.platform === "win32") return process.env.APPDATA ?? join(home, "AppData", "Roaming");
  return process.env.XDG_CONFIG_HOME ?? join(home, ".config");
}

/** Where VS Code and its forks keep extension data: <settings folder>/<editor>/User/globalStorage. */
function editorStorageDirs(home: string): string[] {
  return VSCODE_EDITORS.map((e) => join(settingsBase(home), e, "User", "globalStorage"));
}

/** Cline's JetBrains plugin keeps extension data per IDE: <settings folder>/JetBrains/<IDE>/globalStorage. */
function jetbrainsStorageDirs(home: string): string[] {
  const root = join(settingsBase(home), "JetBrains");
  try {
    return readdirSync(root).map((ide) => join(root, ide, "globalStorage"));
  } catch {
    return [];
  }
}

/**
 * An extension's folders: in every editor's extension storage where it is installed, and its own data folders. When
 * none exist yet, VS Code's and the data folders, so the list shows where the extension will write.
 */
function extensionDirs(home: string, id: string, own: string[], jetbrains = false): string[] {
  const storages = [...editorStorageDirs(home), ...(jetbrains ? jetbrainsStorageDirs(home) : [])];
  const found = [...storages.map((s) => join(s, id)), ...own].filter((d) => existsSync(d));
  return found.length ? found : [join(storages[0]!, id), ...own];
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
    budgets: { ...base.budgets, ...(patch.budgets ?? {}) },
    tips: { ...base.tips, ...(patch.tips ?? {}) },
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
  // Only this account may read it: it names the database and every folder read from.
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Seconds between background scans: 0 (or anything not a positive number) turns them off, others are kept in range. */
export function scanInterval(sec: unknown): number {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(86_400, Math.max(5, Math.round(n)));
}

const SOURCE_DIRS = ["claudeDirs", "codexDirs", "ompDirs", "piDirs", "opencodeDirs", "zedDirs", "clineDirs", "rooDirs", "kiloDirs", "geminiDirs", "copilotDirs"] as const;
const SOURCES = ["claude", "codex", "omp", "pi", "opencode", "zed", "cline", "roo", "kilo", "gemini", "copilot"] as const;
const LIMIT_SOURCES = ["claude", "omp", "codex", "pi", "opencode"] as const;

/** A settings change: what `parseSettings` lets through, merged into the config by the server. */
export type SettingsPatch = Partial<Omit<AppConfig, "sources" | "limits" | "tips" | "budgets">> & {
  budgets?: Partial<BudgetConfig>;
  sources?: Partial<Omit<SourceConfig, "enabled">> & { enabled?: Partial<SourceConfig["enabled"]> };
  limits?: Partial<AppConfig["limits"]>;
};

/**
 * Checks a settings change sent to the server: only known keys, each of the right type. Numbers are rounded and kept
 * in range. Anything else is refused, so a bad value can't end up in the config file.
 */
export function parseSettings(body: unknown): { patch: SettingsPatch } | { error: string } {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObject(body)) return { error: "expected an object" };
  const patch: SettingsPatch = {};
  const invalid = (key: string) => ({ error: `invalid value for ${key}` });
  const has = (key: string) => key in body && body[key] !== undefined;
  const booleans = <K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, boolean>> | null => {
    if (!isObject(value)) return null;
    const out: Partial<Record<K, boolean>> = {};
    for (const k of keys) {
      if (!(k in value)) continue;
      if (typeof value[k] !== "boolean") return null;
      out[k] = value[k] as boolean;
    }
    return out;
  };

  if (has("userName")) {
    if (typeof body.userName !== "string" || body.userName.length > 200) return invalid("userName");
    patch.userName = body.userName.trim();
  }
  if (has("openMode")) {
    if (!["app", "browser", "none"].includes(body.openMode as string)) return invalid("openMode");
    patch.openMode = body.openMode as OpenMode;
  }
  if (has("journalMode")) {
    if (!["auto", "wal", "delete"].includes(body.journalMode as string)) return invalid("journalMode");
    patch.journalMode = body.journalMode as JournalMode;
  }
  if (has("checkUpdates")) {
    if (typeof body.checkUpdates !== "boolean") return invalid("checkUpdates");
    patch.checkUpdates = body.checkUpdates;
  }
  if (has("scanIntervalSec")) {
    if (typeof body.scanIntervalSec !== "number" || !Number.isFinite(body.scanIntervalSec)) return invalid("scanIntervalSec");
    patch.scanIntervalSec = scanInterval(body.scanIntervalSec);
  }
  if (has("promptTextLimit")) {
    if (typeof body.promptTextLimit !== "number" || !Number.isFinite(body.promptTextLimit)) return invalid("promptTextLimit");
    patch.promptTextLimit = Math.min(100_000, Math.max(0, Math.round(body.promptTextLimit)));
  }
  if (has("port")) {
    const port = body.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return invalid("port");
    patch.port = port;
  }
  if (has("sources")) {
    const src = body.sources;
    if (!isObject(src)) return invalid("sources");
    const sources: NonNullable<SettingsPatch["sources"]> = {};
    for (const key of SOURCE_DIRS) {
      if (!(key in src)) continue;
      const dirs = src[key];
      if (!Array.isArray(dirs) || dirs.length > 100 || !dirs.every((d) => typeof d === "string" && d.length <= 4096)) return invalid(`sources.${key}`);
      sources[key] = dirs as string[];
    }
    if ("enabled" in src) {
      const enabled = booleans(src.enabled, SOURCES);
      if (!enabled) return invalid("sources.enabled");
      sources.enabled = enabled;
    }
    patch.sources = sources;
  }
  if (has("limits")) {
    const limits = booleans(body.limits, LIMIT_SOURCES);
    if (!limits) return invalid("limits");
    patch.limits = limits;
  }
  if (has("budgets")) {
    const b = body.budgets;
    if (!isObject(b)) return invalid("budgets");
    const budgets: Partial<BudgetConfig> = {};
    const cap = (v: unknown) => (v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9));
    for (const k of ["daily", "monthly"] as const) {
      if (!(k in b)) continue;
      if (!cap(b[k])) return invalid(`budgets.${k}`);
      budgets[k] = (b[k] as number | null) || null;
    }
    for (const k of ["notify", "limitAlerts"] as const) {
      if (!(k in b)) continue;
      if (typeof b[k] !== "boolean") return invalid(`budgets.${k}`);
      budgets[k] = b[k] as boolean;
    }
    if ("projects" in b) {
      if (!isObject(b.projects)) return invalid("budgets.projects");
      const projects: Record<string, number> = {};
      for (const [k, v] of Object.entries(b.projects)) {
        if (k.length > 4096 || !cap(v)) return invalid("budgets.projects");
        if (v) projects[k] = v as number;
      }
      budgets.projects = projects;
    }
    patch.budgets = budgets;
  }
  if (has("language")) {
    if (!["en", "de", "es", "fr", "pl"].includes(body.language as string)) return invalid("language");
    patch.language = body.language as AlertLang;
  }
  if (has("planPrices")) {
    if (!isObject(body.planPrices)) return invalid("planPrices");
    const prices: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.planPrices)) if (k.length <= 200 && typeof v === "number" && Number.isFinite(v) && v >= 0) prices[k] = v;
    patch.planPrices = prices;
  }
  return { patch };
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
