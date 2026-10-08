import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

// Synthetic fixtures after the community notes on Copilot CLI's session-store.db, never checked against a real store.

const SID = "7c1d2e33-4a55-4b66-8c77-9d88e99f0a11";
const storeFile = (root: string) => join(root, "copilot", "session-store.db");
const eventsFile = (root: string) => join(root, "copilot", "session-state", SID, "events.jsonl");
const START = Date.parse("2026-10-06T10:00:00.000Z");

const COLUMNS = [
  "id INTEGER PRIMARY KEY", "session_id TEXT", "turn_index INTEGER", "agent_id TEXT", "model TEXT", "input_tokens INTEGER",
  "output_tokens INTEGER", "cache_read_tokens INTEGER", "cache_write_tokens INTEGER", "reasoning_tokens INTEGER",
  "total_nano_aiu INTEGER", "request_multiplier REAL", "reasoning_effort TEXT", "token_details_json TEXT", "initiator TEXT", "created_at",
];

type StoreRow = Partial<{
  session_id: string; turn_index: number; agent_id: string | null; model: string; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number; reasoning_effort: string; initiator: string; created_at: string | number;
}>;

function writeStore(root: string, rows: StoreRow[], columns = COLUMNS): void {
  const path = storeFile(root);
  mkdirSync(join(root, "copilot"), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_usage_events (${columns.join(", ")})`);
  for (const row of rows) {
    const keys = Object.keys(row);
    db.query(`INSERT INTO assistant_usage_events (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(Object.values(row) as any[]));
  }
  db.close();
}

/** Two calls that add up to the shutdown below: 41000 input with the cache, 180 output, 30000 cache reads, 9000 writes. */
const CALLS: StoreRow[] = [
  { session_id: SID, turn_index: 0, agent_id: null, model: "claude-sonnet-4.5", input_tokens: 25000, output_tokens: 100, cache_read_tokens: 15000, cache_write_tokens: 9000, created_at: "2026-10-06T10:00:10.000Z" },
  { session_id: SID, turn_index: 1, agent_id: null, model: "claude-sonnet-4.5", input_tokens: 16000, output_tokens: 80, cache_read_tokens: 15000, cache_write_tokens: 0, reasoning_tokens: 20, created_at: "2026-10-06T10:01:00.000Z" },
];

let n = 0;
const ev = (type: string, ts: string, data: Record<string, unknown>) => ({ type, data, id: `e${++n}`, timestamp: ts, parentId: null });
const events = () => [
  ev("session.start", "2026-10-06T10:00:00.000Z", {
    sessionId: SID, copilotVersion: "1.0.92", selectedModel: "claude-sonnet-4.5", context: { cwd: "/home/u/my-app", branch: "main" },
  }),
  ev("user.message", "2026-10-06T10:00:05.000Z", { content: "Add a /health endpoint" }),
  ev("session.shutdown", "2026-10-06T10:02:00.000Z", {
    sessionStartTime: START, currentModel: "claude-sonnet-4.5",
    modelMetrics: {
      "claude-sonnet-4.5": { requests: { count: 2, cost: 2 }, usage: { inputTokens: 41000, outputTokens: 180, cacheReadTokens: 30000, cacheWriteTokens: 9000, reasoningTokens: 20 } },
    },
  }),
];

const totals = (db: Database) =>
  db
    .query<any, []>(
      `SELECT sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cache_read_tokens) AS cacheRead,
              sum(cache_write_tokens) AS cacheWrite, sum(premium_requests) AS premium FROM usage`,
    )
    .get();

const EXPECTED = { input: 2000, output: 180, cacheRead: 30000, cacheWrite: 9000, premium: 2 };

describe("Copilot session store", () => {
  test("its calls become usage rows billed through Copilot, in the folder events.jsonl names", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), events().slice(0, 2));
    writeStore(root, CALLS);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const rows = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      provider: "copilot", session_id: `copilot:${SID}`, model: "claude-sonnet-4.5", agent: "main", is_subagent: 0, billing: "github-copilot",
      premium_requests: 0, project: "/home/u/my-app", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 15000, cache_write_tokens: 9000,
      ts: Date.parse("2026-10-06T10:00:10.000Z"),
    });
    // Output already holds the reasoning.
    expect(rows[1]).toMatchObject({ input_tokens: 1000, output_tokens: 80, reasoning_tokens: 20 });
    expect(rows[0].id.startsWith(`copilot:${SID}:u:`)).toBe(true);
    expect(db.query<any, []>("SELECT project, client FROM sessions").get()).toEqual({ project: "/home/u/my-app", client: "copilot-cli" });
  });

  test("shutdown first, store later: the calls carry the tokens, the shutdown its premium requests", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), events());
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(totals(db)).toEqual(EXPECTED);

    writeStore(root, CALLS);
    await scan(db, testConfig(root), ID);
    expect(totals(db)).toEqual(EXPECTED);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 3 });
  });

  test("store first, shutdown later: the same totals", async () => {
    const root = tempDir();
    writeStore(root, CALLS);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(totals(db)).toEqual({ ...EXPECTED, premium: 0 });

    writeJsonl(eventsFile(root), events());
    await scan(db, testConfig(root), ID);
    expect(totals(db)).toEqual(EXPECTED);
  });

  test("both in one scan: the same totals", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), events());
    writeStore(root, CALLS);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(totals(db)).toEqual(EXPECTED);
  });

  test("a second scan with nothing new writes nothing, a new call is read", async () => {
    const root = tempDir();
    writeStore(root, CALLS);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const before = db.query<any, []>("SELECT * FROM usage ORDER BY id").all();

    // The first read leaves an empty write-ahead log behind (a read-only open creates it), which reads as a change once.
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT * FROM usage ORDER BY id").all()).toEqual(before);
    const again = await scan(db, testConfig(root), ID);
    expect(again.filesParsed).toBe(0);
    expect(again.usageRows).toBe(0);
    expect(db.query<any, []>("SELECT * FROM usage ORDER BY id").all()).toEqual(before);

    writeStore(root, [{ session_id: SID, turn_index: 2, model: "gpt-5.4", input_tokens: 500, output_tokens: 10, created_at: "2026-10-06T10:03:00.000Z" }]);
    const third = await scan(db, testConfig(root), ID);
    expect(third.errors).toEqual([]);
    // The calls within five minutes of the last read are read again: the same ids, the same row.
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 3 });
    expect(totals(db)).toEqual({ input: 2500, output: 190, cacheRead: 30000, cacheWrite: 9000, premium: 0 });
  });

  test("a call logged late, with a created_at long before the last read, is still read", async () => {
    const root = tempDir();
    writeStore(root, CALLS);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 2 });

    writeStore(root, [{ session_id: SID, turn_index: 9, agent_id: "explore", model: "gpt-5.4", input_tokens: 700, output_tokens: 20, created_at: "2026-10-06T09:30:00.000Z" }]);
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);
    expect(db.query<any, []>("SELECT ts, agent, input_tokens FROM usage ORDER BY ts").all()).toEqual([
      { ts: Date.parse("2026-10-06T09:30:00.000Z"), agent: "explore", input_tokens: 700 },
      { ts: Date.parse("2026-10-06T10:00:10.000Z"), agent: "main", input_tokens: 1000 },
      { ts: Date.parse("2026-10-06T10:01:00.000Z"), agent: "main", input_tokens: 1000 },
    ]);

    // Read again with nothing new: the same rows, none twice.
    writeStore(root, []);
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 3 });
  });

  test("a position saved as a time by an older version is read once, then late calls are read too", async () => {
    const root = tempDir();
    writeStore(root, CALLS);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    // As an older version saved it: the latest call time.
    db.query("UPDATE ingest_files SET offset = ?, size = -1 WHERE path = ?").run(Date.parse("2026-10-06T10:01:00.000Z"), storeFile(root));

    writeStore(root, [{ session_id: SID, turn_index: 2, model: "gpt-5.4", input_tokens: 500, output_tokens: 10, created_at: "2026-10-06T10:03:00.000Z" }]);
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 3 });

    writeStore(root, [{ session_id: SID, turn_index: 3, model: "gpt-5.4", input_tokens: 600, output_tokens: 10, created_at: "2026-10-06T09:00:00.000Z" }]);
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 4 });
  });

  test("a store made anew, with fewer rows than were read before, is read whole", async () => {
    const root = tempDir();
    writeStore(root, [...CALLS, { ...CALLS[1]!, turn_index: 2, created_at: "2026-10-06T10:02:00.000Z" }]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 3 });

    rmSync(storeFile(root), { force: true });
    rmSync(`${storeFile(root)}-wal`, { force: true });
    rmSync(`${storeFile(root)}-shm`, { force: true });
    writeStore(root, [{ session_id: SID, turn_index: 0, model: "gpt-5.4", input_tokens: 900, output_tokens: 9, created_at: "2026-10-05T08:00:00.000Z" }]);
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage WHERE input_tokens = 900").get()).toEqual({ n: 1 });
  });

  test("a table without row ids is read by time, a call after the last read too", async () => {
    const root = tempDir();
    mkdirSync(join(root, "copilot"), { recursive: true });
    const store = new Database(storeFile(root));
    store.exec(`CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at TEXT,
      PRIMARY KEY (session_id, created_at)) WITHOUT ROWID`);
    const insert = store.query("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?)");
    insert.run(SID, "gpt-5.4", 100, 1, "2026-10-06T10:00:00.000Z");
    store.close();

    const db = memDb();
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 1 });

    const again = new Database(storeFile(root));
    again.query("INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?)").run(SID, "gpt-5.4", 200, 2, "2026-10-06T11:00:00.000Z");
    again.close();
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
    expect(db.query<any, []>("SELECT input_tokens FROM usage ORDER BY ts").all().map((r) => r.input_tokens)).toEqual([100, 200]);
  });

  test("created_at as ISO text, epoch seconds and epoch ms", async () => {
    const root = tempDir();
    const at = Date.parse("2026-10-06T10:00:00.000Z");
    writeStore(root, [
      { session_id: SID, turn_index: 0, model: "gpt-5.4", input_tokens: 100, output_tokens: 1, created_at: "2026-10-06T10:00:00.000Z" },
      { session_id: SID, turn_index: 1, model: "gpt-5.4", input_tokens: 100, output_tokens: 1, created_at: at / 1000 + 60 },
      { session_id: SID, turn_index: 2, model: "gpt-5.4", input_tokens: 100, output_tokens: 1, created_at: at + 120_000 },
      { session_id: SID, turn_index: 3, model: "gpt-5.4", input_tokens: 100, output_tokens: 1, created_at: "2026-10-06 10:03:00" },
      { session_id: SID, turn_index: 4, model: "gpt-5.4", input_tokens: 100, output_tokens: 1, created_at: "not a time" },
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT ts FROM usage ORDER BY ts").all().map((r) => r.ts)).toEqual([at, at + 60_000, at + 120_000, at + 180_000]);
  });

  test("a subagent's calls and a long-context model", async () => {
    const root = tempDir();
    writeStore(root, [
      { session_id: SID, turn_index: 0, agent_id: "explore", model: "gpt-5.4-1m", input_tokens: 300, output_tokens: 5, created_at: "2026-10-06T10:00:00.000Z", reasoning_effort: "high" },
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT model, agent, is_subagent, project FROM usage").get()).toEqual({ model: "gpt-5.4", agent: "explore", is_subagent: 1, project: null });
    expect(db.query<any, []>("SELECT effort FROM response_meta").get()).toEqual({ effort: "high" });
  });

  test("a compaction call is one usage row and a compaction event", async () => {
    const root = tempDir();
    writeStore(root, [
      { session_id: SID, turn_index: 5, model: "claude-sonnet-4.5", input_tokens: 90000, output_tokens: 2000, cache_read_tokens: 80000, initiator: "compaction", created_at: "2026-10-06T10:00:00.000Z" },
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const usage = db.query<any, []>("SELECT input_tokens, output_tokens, cache_read_tokens, cost_usd FROM usage").all();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ input_tokens: 10000, output_tokens: 2000, cache_read_tokens: 80000 });
    const compaction = db.query<any, []>("SELECT trigger, pre_tokens, post_tokens, cost_usd, estimated FROM compactions").get();
    expect(compaction).toEqual({ trigger: "auto", pre_tokens: 90000, post_tokens: 2000, cost_usd: usage[0].cost_usd, estimated: 0 });
  });

  test("a store without the table or a required column gives no rows and no error", async () => {
    const noTable = tempDir();
    mkdirSync(join(noTable, "copilot"), { recursive: true });
    new Database(storeFile(noTable)).exec("CREATE TABLE something_else (x)");
    const missingColumn = tempDir();
    writeStore(missingColumn, [{ session_id: SID, model: "gpt-5.4", input_tokens: 100, created_at: "2026-10-06T10:00:00.000Z" }], COLUMNS.filter((c) => !c.startsWith("output_tokens")));

    for (const root of [noTable, missingColumn]) {
      const db = memDb();
      const res = await scan(db, testConfig(root), ID);
      expect(res.errors).toEqual([]);
      expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 0 });
    }
  });

  test("a store with only the required columns is read", async () => {
    const root = tempDir();
    writeStore(root, [{ session_id: SID, model: "gpt-5.4", input_tokens: 100, output_tokens: 7, created_at: 1791280800 }], [
      "session_id TEXT", "model TEXT", "input_tokens INTEGER", "output_tokens INTEGER", "created_at INTEGER",
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);
    expect(db.query<any, []>("SELECT input_tokens, output_tokens, agent FROM usage").get()).toEqual({ input_tokens: 100, output_tokens: 7, agent: "main" });
  });

  test("a damaged store is skipped and reported, the rest is still read", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), events());
    writeFileSync(storeFile(root), "not a database, just text that is long enough to be read as a header and fail".repeat(20));
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors.map((e) => e.path)).toEqual([storeFile(root)]);
    expect(totals(db)).toEqual(EXPECTED);
  });
});
