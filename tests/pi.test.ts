import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const ID_A = "0199b1a0-0000-7000-8000-00000000000a";
const ID_FORK = "0199b1a0-0000-7000-8000-00000000000f";
const file = (root: string, id: string) => join(root, "pi", "sessions", "--work-alpha--", `2026-10-05T12-00-00-000Z_${id}.jsonl`);

const header = (id: string, extra: Record<string, unknown> = {}) => ({ type: "session", version: 3, id, timestamp: "2026-10-05T12:00:00.000Z", cwd: "/work/alpha", ...extra });
const user = (id: string, text: string, at: number) => ({
  type: "message", id, parentId: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: text, timestamp: at },
});
const assistant = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: new Date(at).toISOString(),
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "On it" },
      { type: "toolCall", id: `toolu_${id}`, name: "edit", arguments: { path: "src/auth.ts", edits: [{ oldText: "a", newText: "b" }] } },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    usage: { input: 100, output: 500, cacheRead: 9000, cacheWrite: 1200, cacheWrite1h: 200, reasoning: 120, totalTokens: 10800, cost: { total: 0.01 } },
    stopReason: "toolUse",
    timestamp: at,
    ...extra,
  },
});

const T = Date.parse("2026-10-05T12:00:05.000Z");

describe("pi ingest", () => {
  test("messages, tool calls, names and usage outside messages", async () => {
    const root = tempDir();
    writeJsonl(file(root, ID_A), [
      header(ID_A),
      { type: "model_change", id: "mc1", parentId: null, timestamp: "2026-10-05T12:00:01.000Z", provider: "anthropic", modelId: "claude-sonnet-5-5" },
      user("aa000001", "Fix the login redirect", T),
      assistant("aa000002", T + 1000),
      { type: "session_info", id: "aa000003", parentId: "aa000002", timestamp: new Date(T + 2000).toISOString(), name: "Login redirect" },
      { type: "usage", id: "aa000004", parentId: "aa000003", timestamp: new Date(T + 3000).toISOString(), kind: "cache_warm", provider: "anthropic", model: "claude-sonnet-5-5", usage: { input: 10, output: 1, cacheRead: 9000, cacheWrite: 0, totalTokens: 9011 } },
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const usage = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    expect(usage.length).toBe(2);
    expect(usage[0]).toMatchObject({
      provider: "pi", session_id: `pi:${ID_A}`, prompt_id: `pi:aa000001:${T}`, model: "claude-sonnet-5-5", billing: "anthropic", project: "/work/alpha",
      input_tokens: 100, output_tokens: 500, cache_read_tokens: 9000, cache_write_tokens: 1000, cache_write_1h_tokens: 200, reasoning_tokens: 120,
    });
    expect(usage[1]).toMatchObject({ cache_read_tokens: 9000, billing: "anthropic" });

    expect(db.query<any, []>("SELECT title, provider, parent_session_id FROM sessions").get()).toEqual({ title: "Login redirect", provider: "pi", parent_session_id: null });
    expect(db.query<any, []>("SELECT text FROM prompts").get()).toEqual({ text: "Fix the login redirect" });
    expect(db.query<any, []>("SELECT tool, file_path FROM tool_calls").all()).toEqual([{ tool: "edit", file_path: "src/auth.ts" }]);
  });

  test("a fork copies earlier entries into a new file: they count once", async () => {
    const root = tempDir();
    const original = [header(ID_A), user("aa000001", "Plan the migration", T), assistant("aa000002", T + 1000)];
    writeJsonl(file(root, ID_A), original);
    writeJsonl(file(root, ID_FORK), [
      header(ID_FORK, { parentSession: file(root, ID_A) }),
      ...original.slice(1),
      user("ff000001", "Now try the other approach", T + 60_000),
      assistant("ff000002", T + 61_000),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(2);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM prompts").get().n).toBe(2);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM tool_calls").get().n).toBe(2);
    // A fork is a session of its own, not a subagent of the one it was copied from.
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL").get().n).toBe(0);
  });
});
