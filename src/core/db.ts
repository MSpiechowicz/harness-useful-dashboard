import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalMode } from "./config.ts";

export const SCHEMA_VERSION = 8;

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
  if (!opts.readonly && path !== ":memory:") {
    // WAL does not work reliably on network/cloud-synced filesystems, so only use it for local default paths.
    const mode = opts.journalMode ?? "auto";
    const useWal = mode === "wal" || (mode === "auto" && opts.isDefaultPath !== false);
    db.exec(`PRAGMA journal_mode = ${useWal ? "WAL" : "DELETE"}`);
    db.exec("PRAGMA synchronous = NORMAL");
  }
  if (!opts.readonly) migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const row = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  let current = row ? Number(row.value) : 0;
  while (current < SCHEMA_VERSION) {
    const next = current + 1;
    db.transaction(() => {
      db.exec(MIGRATIONS[next]!);
      db.query("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(next));
    })();
    current = next;
  }
}

export function getMeta(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
}
