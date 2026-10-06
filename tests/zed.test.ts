import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig } from "./helpers.ts";

const CREATED = "2026-10-01T10:00:00.000000000+00:00";
const UPDATED = "2026-10-01T10:30:00.000000000+00:00";

/** A Zed threads database as Zed 0.200+ writes it. */
function threadsDb(root: string): Database {
  const dir = join(root, "zed", "threads");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "threads.db"), { create: true });
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL,
                                 parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)`);
  return db;
}
const put = (db: Database, id: string, doc: unknown, opts: { zstd?: boolean; parent?: string; folders?: string } = {}) => {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, "Summary", UPDATED, opts.zstd ? "zstd" : "json", opts.zstd ? Bun.zstdCompressSync(bytes) : bytes, opts.parent ?? null, opts.folders ?? null, null, CREATED,
  );
};

describe("Zed ingest", () => {
  test("a thread is one usage row with its model, prompts, tool calls and their outcomes", async () => {
    const root = tempDir();
    const src = threadsDb(root);
    put(
      src,
      "t1",
      {
        version: "0.3.0",
        title: "Fix the parser",
        updated_at: "2026-10-01T10:30:00Z",
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        cumulative_token_usage: { input_tokens: 1200, output_tokens: 800, cache_creation_input_tokens: 5000, cache_read_input_tokens: 40000 },
        thinking_effort: "high",
        messages: [
          { User: { id: "u-1", content: [{ Text: "fix the bug" }] } },
          {
            Agent: {
              content: [{ Text: "Reading" }, { ToolUse: { id: "toolu_1", name: "read_file", input: { type: "json", value: { path: "a.rs" } } } }, { ToolUse: { id: "toolu_2", name: "terminal", input: {} } }],
              tool_results: { toolu_1: { tool_use_id: "toolu_1", tool_name: "read_file", is_error: false }, toolu_2: { tool_use_id: "toolu_2", tool_name: "terminal", is_error: true } },
            },
          },
          "Resume",
          { User: { id: "u-2", content: [{ Text: "now the tests" }] } },
        ],
      },
      { zstd: true, folders: "/work/alpha\n/work/beta" },
    );
    // A subagent the thread started, and an old-format thread.
    put(src, "t2", { version: "0.3.0", title: "Search", model: { provider: "zed.dev", model: "claude-haiku-4-5" }, cumulative_token_usage: { input_tokens: 10, output_tokens: 20 }, subagent_context: { parent_thread_id: "t1", depth: 1 }, messages: [] }, { zstd: true, parent: "t1" });
    put(src, "t3", {
      version: "0.2.0",
      summary: "Old thread",
      model: { provider: "openai", model: "gpt-5" },
      cumulative_token_usage: { input_tokens: 50, output_tokens: 60 },
      messages: [{ id: 0, role: "user", segments: [{ type: "text", text: "hello" }], tool_uses: [], tool_results: [] }],
    });
    src.close();

    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const usage = db.query<any, []>("SELECT * FROM usage ORDER BY id").all();
    expect(usage.map((u) => [u.id, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.agent, u.billing])).toEqual([
      ["zed:t1", "claude-sonnet-5-5", 1200, 800, 40000, 5000, "main", "anthropic"],
      ["zed:t2", "claude-haiku-4-5", 10, 20, 0, 0, "subagent", "zed.dev"],
      ["zed:t3", "gpt-5", 50, 60, 0, 0, "main", "openai"],
    ]);
    expect(usage[0].ts).toBe(Date.parse("2026-10-01T10:00:00Z"));
    expect(usage[0].project).toBe("/work/alpha");
    expect(usage[0].prompt_id).toBe("zed:t1:u-1");

    expect(db.query<any, []>("SELECT id, text FROM prompts ORDER BY ts, id").all()).toEqual([
      { id: "zed:t1:u-1", text: "fix the bug" },
      { id: "zed:t3:0", text: "hello" },
      { id: "zed:t1:u-2", text: "now the tests" },
    ]);
    expect(db.query<any, []>("SELECT tool FROM tool_calls ORDER BY id").all().map((t) => t.tool)).toEqual(["read_file", "terminal"]);
    expect(db.query<any, []>("SELECT id, kind FROM outcomes ORDER BY id").all()).toEqual([
      { id: "zed:toolu_1", kind: "tool_ok" },
      { id: "zed:toolu_2", kind: "tool_error" },
    ]);
    expect(db.query<any, []>("SELECT id, title, parent_session_id, client FROM sessions ORDER BY id").all()).toEqual([
      { id: "zed:t1", title: "Fix the parser", parent_session_id: null, client: "zed" },
      { id: "zed:t2", title: "Search", parent_session_id: "zed:t1", client: "zed" },
      { id: "zed:t3", title: "Summary", parent_session_id: null, client: "zed" },
    ]);
    expect(db.query<any, []>("SELECT effort FROM response_meta WHERE usage_id = 'zed:t1'").get().effort).toBe("high");

    // Rescanning an unchanged database reads nothing, and a full rescan changes nothing.
    expect((await scan(db, testConfig(root), ID)).filesParsed).toBe(0);
    await scan(db, testConfig(root), ID, { full: true });
    expect(db.query<any, []>("SELECT COUNT(*) AS n, SUM(total_tokens) AS t FROM usage").get()).toEqual({ n: 3, t: 47000 + 30 + 110 });
  });
});
