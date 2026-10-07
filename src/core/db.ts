import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalMode } from "./config.ts";
import { CURSOR_REKEY } from "./ingest/cursor.ts";

export const SCHEMA_VERSION = 16;

const MIGRATIONS: Record<number, string> = {
  1: /* sql */ `
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                TEXT PRIMARY KEY,   -- "<provider>:<native session id>"
      provider          TEXT NOT NULL,
      native_id         TEXT NOT NULL,
      project           TEXT,               -- absolute project path (cwd)
      user              TEXT,
      host              TEXT,
      title             TEXT,
      git_branch        TEXT,
      client            TEXT,
      client_version    TEXT,
      parent_session_id TEXT,
      agent             TEXT,               -- subagent type / nickname, NULL for main sessions
      started_at        INTEGER,
      ended_at          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY,         -- "<provider>:<session>:<prompt id>"
      session_id  TEXT NOT NULL,
      provider    TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      text        TEXT,
      skill       TEXT,
      is_command  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(ts);

    -- One row per billed model response (deduplicated).
    CREATE TABLE IF NOT EXISTS usage (
      id                    TEXT PRIMARY KEY,
      provider              TEXT NOT NULL,
      session_id            TEXT NOT NULL,
      prompt_id             TEXT,
      ts                    INTEGER NOT NULL,   -- epoch ms
      project               TEXT,
      user                  TEXT,
      host                  TEXT,
      model                 TEXT,
      skill                 TEXT,
      agent                 TEXT NOT NULL DEFAULT 'main',
      is_subagent           INTEGER NOT NULL DEFAULT 0,
      spawn_ref             TEXT,               -- tool_use id that spawned a subagent (resolved post-ingest)
      input_tokens          INTEGER NOT NULL DEFAULT 0,  -- uncached input
      output_tokens         INTEGER NOT NULL DEFAULT 0,  -- includes reasoning
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens    INTEGER NOT NULL DEFAULT 0,  -- 5 minute TTL writes (or unspecified)
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
      total_tokens          INTEGER NOT NULL DEFAULT 0,
      cost_usd              REAL NOT NULL DEFAULT 0,
      cost_estimated        INTEGER NOT NULL DEFAULT 0,  -- 1 = model price unknown, fallback used
      speed                 TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
    CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
    CREATE INDEX IF NOT EXISTS idx_usage_prompt ON usage(prompt_id);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage(project, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model, ts);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id          TEXT PRIMARY KEY,
      usage_id    TEXT,
      session_id  TEXT NOT NULL,
      prompt_id   TEXT,
      provider    TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      project     TEXT,
      user        TEXT,
      tool        TEXT NOT NULL,
      file_path   TEXT,
      skill       TEXT,
      agent       TEXT NOT NULL DEFAULT 'main',
      spawn_ref   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tools_ts ON tool_calls(ts);
    CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_calls(session_id);

    -- Incremental ingest bookkeeping, per machine (DB may be shared between machines).
    CREATE TABLE IF NOT EXISTS ingest_files (
      host    TEXT NOT NULL,
      path    TEXT NOT NULL,
      size    INTEGER NOT NULL,
      mtime   INTEGER NOT NULL,
      offset  INTEGER NOT NULL,
      state   TEXT,
      PRIMARY KEY (host, path)
    );

    -- User overrides / additions to the built-in price table ($ per 1M tokens).
    CREATE TABLE IF NOT EXISTS pricing (
      pattern         TEXT PRIMARY KEY,
      input           REAL NOT NULL,
      output          REAL NOT NULL,
      cache_read      REAL,
      cache_write_5m  REAL,
      cache_write_1h  REAL
    );
  `,
  // Per-prompt tool counts (prompt list, session detail, prompt detail) looked tool calls up by prompt_id
  // with a full table scan per prompt.
  2: /* sql */ `
    CREATE INDEX IF NOT EXISTS idx_tools_prompt ON tool_calls(prompt_id);
  `,
  // What a call was billed through when the harness reports it (omp: "openai-codex", "github-copilot", …),
  // and GitHub Copilot's premium-request count for it.
  3: /* sql */ `
    ALTER TABLE usage ADD COLUMN billing TEXT;
    ALTER TABLE usage ADD COLUMN premium_requests REAL NOT NULL DEFAULT 0;
  `,
  // The latest plan-limit reading a harness wrote into its logs (Codex logs its rate limits next to token counts),
  // one row per limit window and machine.
  4: /* sql */ `
    CREATE TABLE IF NOT EXISTS plan_limits (
      provider       TEXT NOT NULL,
      host           TEXT NOT NULL,
      window_id      TEXT NOT NULL,     -- "primary", "secondary"
      window_minutes INTEGER,
      used_percent   REAL NOT NULL,
      resets_at      INTEGER,           -- epoch ms
      plan           TEXT,
      observed_at    INTEGER NOT NULL,  -- epoch ms
      PRIMARY KEY (provider, host, window_id)
    );
    -- Read the Codex logs (rollout-*.jsonl) once more for the readings ingested before this table existed. Records are
    -- keyed by their place in the file, so reading again changes nothing else.
    DELETE FROM ingest_files WHERE path LIKE '%rollout-%.jsonl';
  `,
  // What the model drift view compares: how long each response took and at what effort, and how tool calls ended.
  5: /* sql */ `
    CREATE TABLE IF NOT EXISTS response_meta (
      usage_id    TEXT PRIMARY KEY,
      start_ts    INTEGER,           -- when the model got its input, epoch ms
      end_ts      INTEGER,           -- when the response was done, epoch ms
      ttft_ms     REAL,
      effort      TEXT,
      stop_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id         TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ts         INTEGER NOT NULL,
      project    TEXT,
      user       TEXT,
      host       TEXT,
      model      TEXT,
      agent      TEXT NOT NULL DEFAULT 'main',
      effort     TEXT,
      kind       TEXT NOT NULL      -- tool_ok, tool_error, tool_rejected, interrupt
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_model ON outcomes(model, ts);
    -- Read every log once more to fill both for the history already ingested. Records are keyed by their place in
    -- the logs, so reading again changes nothing else.
    DELETE FROM ingest_files;
  `,
  // Every plan-limit reading, not just the latest: the plans view shows how full each limit got and how often it ran
  // out. One reading per window every five minutes (slot) is enough for that.
  6: /* sql */ `
    CREATE TABLE IF NOT EXISTS limit_readings (
      host          TEXT NOT NULL,
      report_key    TEXT NOT NULL,     -- the limit report's key ("claude", "codex:logs", "omp:github-copilot", …)
      window_id     TEXT NOT NULL,
      slot          INTEGER NOT NULL,  -- observed_at / 5 minutes
      provider      TEXT NOT NULL,
      plan          TEXT,
      window_ms     INTEGER,
      scope         TEXT,
      label         TEXT,
      used_fraction REAL NOT NULL,
      resets_at     INTEGER,           -- epoch ms
      observed_at   INTEGER NOT NULL,  -- epoch ms
      PRIMARY KEY (host, report_key, window_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_limit_readings_ts ON limit_readings(observed_at);
    -- Codex logs a reading with every response: read its logs once more for the history so far.
    DELETE FROM ingest_files WHERE path LIKE '%rollout-%.jsonl';
  `,
  // A subagent's brief: the instruction its parent gave it, which the session page shows. It is no prompt of the user's.
  7: /* sql */ `
    ALTER TABLE sessions ADD COLUMN brief TEXT;
    -- Read the omp, pi and Codex logs once more for the briefs of the subagents already ingested. Records are keyed
    -- by their place in the logs, so reading again changes nothing else.
    DELETE FROM ingest_files WHERE path LIKE '%.jsonl';
  `,
  // The Live view looked up subagent sessions by parent and outcomes by session or time with full table scans (seconds
  // per poll on a year of history), and every scan read the projects of this host through the project index.
  8: /* sql */ `
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_ts ON outcomes(ts);
    CREATE INDEX IF NOT EXISTS idx_outcomes_session ON outcomes(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_host_project ON usage(host, project);
  `,
  // The tool a tool call's outcome belongs to, kept on the outcome: the friction view joined every outcome to its tool
  // call to group by tool (seconds on a year of history).
  9: /* sql */ `
    ALTER TABLE outcomes ADD COLUMN tool TEXT;
    UPDATE outcomes SET tool = (SELECT t.tool FROM tool_calls t WHERE t.id = outcomes.id);
  `,
  // Why a tool call failed: its class (failures.ts), the error text and what the call was given (a command, a path).
  // Text only when prompt text is kept.
  10: /* sql */ `
    ALTER TABLE outcomes ADD COLUMN reason TEXT;
    ALTER TABLE outcomes ADD COLUMN detail TEXT;
    ALTER TABLE outcomes ADD COLUMN input TEXT;
    CREATE INDEX IF NOT EXISTS idx_outcomes_kind_ts ON outcomes(kind, ts);
    -- Read every log once more for the failures already ingested. Records are keyed by their place in the logs, so
    -- reading again changes nothing else.
    DELETE FROM ingest_files;
  `,
  // Failed model requests (rate limits, overloads, timeouts, …) as `api_error` outcomes: their class is the reason, the
  // message the detail, and the HTTP status here. Read every log once more for the errors already in them.
  11: /* sql */ `
    ALTER TABLE outcomes ADD COLUMN status INTEGER;
    DELETE FROM ingest_files;
  `,
  // What a call that started a subagent asked of it ("Find the login handlers"): Claude Code keeps its subagents in the
  // parent's session, so the Live view names each run by the call that started it. Read the JSONL logs once more.
  12: /* sql */ `
    ALTER TABLE tool_calls ADD COLUMN brief TEXT;
    DELETE FROM ingest_files WHERE path LIKE '%.jsonl';
  `,
  // Cursor rows are keyed by the call's time, model and tokens, so a CSV import and a sync never count a call twice.
  13: CURSOR_REKEY,
  // Lines an edit tool call added and removed (ingest/lines.ts), and the model that made the call, so cost per changed
  // line can be split by model. Numbers only, kept when retention trims the detail. A failed edit has none. Read the
  // logs and databases the counts come from once more (Zed logs no edit text, so it is left out).
  14: /* sql */ `
    ALTER TABLE tool_calls ADD COLUMN lines_added INTEGER;
    ALTER TABLE tool_calls ADD COLUMN lines_removed INTEGER;
    ALTER TABLE tool_calls ADD COLUMN model TEXT;
    CREATE INDEX IF NOT EXISTS idx_tools_lines ON tool_calls(ts) WHERE lines_added IS NOT NULL;
    DELETE FROM ingest_files WHERE path LIKE '%.jsonl' OR path LIKE '%.json' OR (path LIKE '%.db' AND path NOT LIKE '%threads.db');
  `,
  // Tags and notes the user gives sessions (a client, "billable"), and a default tag per project. They are the user's
  // own data, not ingested from logs: retention never trims them, and on a shared database every machine sees them.
  15: /* sql */ `
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT NOT NULL,
      tag        TEXT NOT NULL,         -- trimmed, lowercase (tags.ts)
      PRIMARY KEY (session_id, tag)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);
    CREATE TABLE IF NOT EXISTS session_notes (
      session_id TEXT PRIMARY KEY,
      note       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_tags (
      project TEXT PRIMARY KEY,         -- absolute project path
      tag     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_tags_tag ON project_tags(tag);
  `,
  // AI-written session labels (labels.ts): a short title and a kind of work per root session, written only with the
  // user's opt-in. Never ingested, so retention keeps them. `attempts` counts how often a session was sent without
  // coming back labelled, so one the model can't label is not sent over and over.
  16: /* sql */ `
    CREATE TABLE IF NOT EXISTS session_labels (
      session_id TEXT PRIMARY KEY,
      title      TEXT NOT NULL,         -- empty when only the kind was set by hand
      kind       TEXT NOT NULL,         -- one of labels.ts KINDS
      model      TEXT NOT NULL,         -- the model that wrote it, "manual" for a kind set by hand
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_labels_kind ON session_labels(kind);
    CREATE TABLE IF NOT EXISTS label_attempts (
      session_id TEXT PRIMARY KEY,
      attempts   INTEGER NOT NULL
    );
  `,
};

export interface OpenDbOptions {
  journalMode?: JournalMode;
  isDefaultPath?: boolean;
  readonly?: boolean;
}

export function openDb(path: string, opts: OpenDbOptions = {}): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: !opts.readonly, readonly: opts.readonly, strict: true });
  db.exec("PRAGMA busy_timeout = 15000");
  db.exec("PRAGMA foreign_keys = ON");
  // A new database gives the pages that trimming frees back to the disk a few at a time (retention.ts). This must come
  // before anything writes the file, the journal mode too. An existing one keeps its mode until VACUUM (Compact).
  if (!opts.readonly) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (!opts.readonly && path !== ":memory:") {
    // WAL does not work reliably on network/cloud-synced filesystems, so only use it for local default paths.
    const mode = opts.journalMode ?? "auto";
    const useWal = mode === "wal" || (mode === "auto" && opts.isDefaultPath !== false);
    db.exec(`PRAGMA journal_mode = ${useWal ? "WAL" : "DELETE"}`);
    // In WAL mode NORMAL can lose the last commits on power loss but never corrupts. With the rollback journal (the
    // shared-database path) only FULL closes that window.
    db.exec(`PRAGMA synchronous = ${useWal ? "NORMAL" : "FULL"}`);
    // Memory-mapped reads only on a local disk: on a synced or network folder another machine can change the file
    // under the mapping.
    if (useWal) db.exec("PRAGMA mmap_size = 268435456");
  }
  // 64 MB of page cache instead of 2 MB: the views read the same indexes over and over.
  db.exec("PRAGMA cache_size = -65536");
  if (!opts.readonly) {
    migrate(db);
    optimize(db, true);
  }
  return db;
}

/**
 * Keeps the query planner's statistics current: SQLite only analyzes the tables whose size changed a lot since the
 * last time, so this is cheap when nothing did. `opening` also looks at tables never analyzed.
 */
export function optimize(db: Database, opening = false): void {
  db.exec(`PRAGMA optimize${opening ? " = 0x10002" : ""}`);
}

function schemaVersion(db: Database): number {
  try {
    const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number(row.value) : 0;
  } catch {
    return 0; // no meta table yet
  }
}

/**
 * Brings the schema up to date. Several machines can open a shared database at once: each step takes the write lock
 * first (BEGIN IMMEDIATE) and reads the version again under it, so a step another process just ran is not run twice
 * (a second `ALTER TABLE … ADD COLUMN` would fail).
 */
export function migrate(db: Database): void {
  if (schemaVersion(db) >= SCHEMA_VERSION) return;
  const step = db.transaction((): boolean => {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    const current = schemaVersion(db);
    if (current >= SCHEMA_VERSION) return false;
    db.exec(MIGRATIONS[current + 1]!);
    db.query("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(current + 1));
    return true;
  });
  while (step.immediate()) {
    /* one migration per transaction */
  }
}

export function getMeta(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
}
