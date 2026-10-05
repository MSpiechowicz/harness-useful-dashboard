import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { codexMeta, codexRecord, codexTokenCount, codexTurn, codexUserMessage, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const rollout = (root: string, name: string) => join(root, "codex", "sessions", "2026", "09", "01", `rollout-${name}.jsonl`);

describe("Codex ingest", () => {
  test("cumulative token_count events: repeated snapshots are not double counted", async () => {
    const root = tempDir();
    writeJsonl(rollout(root, "a"), [
      codexMeta("thread-a"),
      codexTurn("gpt-5"),
      codexUserMessage("Add tests", "item-1"),
      codexTokenCount(1100, { input: 1000, cached: 800, output: 100 }, 5),
      codexTokenCount(1100, { input: 1000, cached: 800, output: 100 }, 6), // duplicate snapshot
      { timestamp: "2026-09-01T10:00:05.000Z", type: "event_msg", payload: { type: "token_count", info: null } },
      codexTokenCount(3300, { input: 2000, cached: 1500, output: 200, reasoning: 50 }, 9),
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);
    const rows = db.query<any, []>("SELECT * FROM usage ORDER BY ts, id").all();
    expect(rows.length).toBe(2);
    // input excludes cached tokens; total = input + cached + output
    expect(rows[0]).toMatchObject({ input_tokens: 200, cache_read_tokens: 800, output_tokens: 100, total_tokens: 1100, model: "gpt-5", project: "/work/beta" });
    expect(rows[1]).toMatchObject({ input_tokens: 500, cache_read_tokens: 1500, output_tokens: 200, reasoning_tokens: 50 });
    expect(rows.every((r) => r.prompt_id === "codex:thread-a:item-1")).toBe(true);
    const total = db.query<any, []>("SELECT SUM(total_tokens) AS t FROM usage").get().t;
    expect(total).toBe(3300); // matches the final cumulative total
  });

  test("per-response token_usage_record lines take precedence over token_count", async () => {
    const root = tempDir();
    writeJsonl(rollout(root, "b"), [
      codexMeta("thread-b"),
      codexTurn("gpt-5-mini"),
      codexUserMessage("$ship-backlog-item", "item-1", undefined, "ship-backlog-item"),
      codexRecord("resp-1", { input: 1000, cached: 0, output: 10 }),
      codexTokenCount(1010, { input: 1000, cached: 0, output: 10 }, 12),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const rows = db.query<any, []>("SELECT * FROM usage").all();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("codex:thread-b:resp-1");
    expect(rows[0].skill).toBe("ship-backlog-item");
    const prompt = db.query<any, []>("SELECT * FROM prompts").get();
    expect(prompt.skill).toBe("ship-backlog-item");
    expect(prompt.is_command).toBe(1);
  });

  test("spawned subagent rollouts keep their own thread despite the embedded parent session_meta", async () => {
    const root = tempDir();
    writeJsonl(rollout(root, "parent"), [codexMeta("parent"), codexTurn("gpt-5"), codexTokenCount(500, { input: 400, cached: 0, output: 100 }, 3)]);
    writeJsonl(rollout(root, "child"), [
      codexMeta("child", { source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: "/root/review", agent_nickname: "Boole", agent_role: null } } } }),
      codexMeta("parent"),
      codexTurn("gpt-5"),
      codexTokenCount(300, { input: 250, cached: 0, output: 50 }, 4),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const bySession = db.query<any, []>("SELECT session_id, agent, is_subagent, SUM(total_tokens) AS t FROM usage GROUP BY session_id ORDER BY session_id").all();
    expect(bySession).toEqual([
      { session_id: "codex:child", agent: "Boole", is_subagent: 1, t: 300 },
      { session_id: "codex:parent", agent: "main", is_subagent: 0, t: 500 },
    ]);
    const child = db.query<any, []>("SELECT parent_session_id, agent FROM sessions WHERE id = 'codex:child'").get();
    expect(child).toEqual({ parent_session_id: "codex:parent", agent: "Boole" });
  });

  test("tools, apply_patch files and SKILL.md reads are captured", async () => {
    const root = tempDir();
    const exec = {
      timestamp: "2026-09-01T10:00:06.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call-1", input: "const r = await tools.exec_command({cmd:\"sed -n '1,80p' /h/.agents/skills/context7-mcp/SKILL.md\"}); await tools.apply_patch(\"*** Begin Patch\\n*** Update File: src/a.ts\\n*** Add File: src/b.ts\\n\");" },
    };
    const fn = { timestamp: "2026-09-01T10:00:07.000Z", type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "call-2", arguments: "{}" } };
    writeJsonl(rollout(root, "c"), [codexMeta("thread-c"), codexTurn("gpt-5"), codexUserMessage("go", "item-1"), exec, fn, codexTokenCount(10, { input: 5, cached: 0, output: 5 }, 9, "2026-09-01T10:00:08.000Z")]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const tools = db.query<any, []>("SELECT tool, file_path, skill FROM tool_calls ORDER BY id").all();
    expect(tools.map((t) => t.tool).sort()).toEqual(["apply_patch", "apply_patch", "exec_command", "update_plan"]);
    expect(tools.filter((t) => t.file_path).map((t) => t.file_path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(db.query<any, []>("SELECT skill FROM usage").get().skill).toBe("context7-mcp");
  });

  test("session titles come from session_index.jsonl", async () => {
    const root = tempDir();
    writeJsonl(rollout(root, "d"), [codexMeta("thread-d"), codexTurn("gpt-5"), codexTokenCount(10, { input: 5, cached: 0, output: 5 }, 2)]);
    writeFileSync(join(root, "codex", "session_index.jsonl"), JSON.stringify({ id: "thread-d", thread_name: "Fix flaky test" }) + "\n");
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT title FROM sessions WHERE id = 'codex:thread-d'").get().title).toBe("Fix flaky test");
  });
});
