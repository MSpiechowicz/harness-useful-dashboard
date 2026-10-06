import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const UUID = "01a0e876-219c-727f-a821-4f01fdcb0f55";
const SUB_UUID = "01a0e877-0000-7000-8000-000000000001";
const sessionFile = (root: string) => join(root, "omp", "sessions", "-work-alpha", `2026-09-28T14-40-51-100Z_${UUID}.jsonl`);
const subagentFile = (root: string, name: string) => join(root, "omp", "sessions", "-work-alpha", `2026-09-28T14-40-51-100Z_${UUID}`, `${name}.jsonl`);

const header = (id: string, extra: Record<string, unknown> = {}) => ({ type: "session", version: 3, id, timestamp: "2026-09-28T14:40:51.100Z", cwd: "/work/alpha", ...extra });
const user = (id: string, text: string, ts = "2026-09-28T14:43:17.000Z") => ({
  type: "message", id, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] },
});
function assistant(id: string, opts: { provider?: string; model?: string; usage?: Record<string, unknown>; tools?: unknown[]; ts?: string } = {}) {
  return {
    type: "message",
    id,
    timestamp: opts.ts ?? "2026-09-28T14:43:22.000Z",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "…" }, ...(opts.tools ?? [])],
      api: "openai-codex-responses",
      provider: opts.provider ?? "openai-codex",
      model: opts.model ?? "gpt-6-sol",
      usage: { input: 1000, output: 100, cacheRead: 4000, cacheWrite: 0, totalTokens: 5100, reasoningTokens: 20, ...opts.usage },
    },
  };
}
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

describe("omp ingest", () => {
  test("assistant messages become usage rows billed through their provider", async () => {
    const root = tempDir();
    writeJsonl(sessionFile(root), [
      { type: "title", v: 1, title: "Fix the bridge" },
      header(UUID, { title: "Fix the bridge" }),
      { type: "model_change", id: "m1", timestamp: "2026-09-28T14:40:51.149Z", model: "openai-codex/gpt-6-sol" },
      user("u1", "Make the tests pass"),
      assistant("a1"),
      assistant("a2", { provider: "github-copilot", model: "claude-opus-5.5", usage: { premiumRequests: 1 }, ts: "2026-09-28T14:44:00.000Z" }),
      assistant("a3", { usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 0 } }), // aborted, nothing billed
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const rows = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: `omp:${UUID}:a1`, provider: "omp", billing: "openai-codex", model: "gpt-6-sol", project: "/work/alpha",
      input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 100, reasoning_tokens: 20, total_tokens: 5100,
      prompt_id: `omp:${UUID}:u1`, agent: "main", is_subagent: 0, premium_requests: 0,
    });
    // Copilot-billed Claude: priced as the dashed id (claude-opus-5-5 is $4/$20), premium request kept.
    expect(rows[1]).toMatchObject({ billing: "github-copilot", model: "claude-opus-5.5", premium_requests: 1, cost_estimated: 0 });
    expect(rows[1].cost_usd).toBeCloseTo((1000 * 4 + 100 * 20 + 4000 * 0.2) / 1e6, 10);

    expect(db.query<any, []>("SELECT * FROM sessions").get()).toMatchObject({ id: `omp:${UUID}`, provider: "omp", title: "Fix the bridge", client: "omp" });
    expect(db.query<any, []>("SELECT * FROM prompts").get()).toMatchObject({ id: `omp:${UUID}:u1`, text: "Make the tests pass", provider: "omp" });
  });

  test("a subagent's transcript is linked to its parent and attributed to its agent", async () => {
    const root = tempDir();
    writeJsonl(sessionFile(root), [header(UUID), user("u1", "Plan it"), assistant("a1")]);
    writeJsonl(subagentFile(root, "SmithTests"), [
      { type: "title", v: 1, title: "SmithTests" },
      header(SUB_UUID, { parentSession: sessionFile(root) }),
      user("s0", "Brief from the parent"),
      assistant("s1"),
      user("s2", "A later message from the parent"),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const sub = db.query<any, []>(`SELECT * FROM sessions WHERE id = 'omp:${SUB_UUID}'`).get();
    // The brief is kept with the session: the first instruction, not the later messages.
    expect(sub).toMatchObject({ parent_session_id: `omp:${UUID}`, agent: "SmithTests", brief: "Brief from the parent" });
    expect(db.query<any, []>(`SELECT * FROM usage WHERE session_id = 'omp:${SUB_UUID}'`).get()).toMatchObject({ agent: "SmithTests", is_subagent: 1 });
    // The parent's brief is not a prompt of the user's.
    expect(db.query<any, []>("SELECT COUNT(*) n FROM prompts").get().n).toBe(1);
  });

  test("tool calls record files, patches over several files, and the skill being read", async () => {
    const root = tempDir();
    writeJsonl(sessionFile(root), [
      header(UUID),
      user("u1", "Ship it"),
      assistant("a1", {
        tools: [
          toolCall("c1", "read", { path: "skill://us-workflow" }),
          toolCall("c2", "read", { path: "src/main.rs" }),
          toolCall("c3", "edit", { input: "*** Begin Patch\n[src/a.rs#C1DF]\nPUT >51:\n+x\n[local://notes.md#11]\n+n\n[src/b.rs#9A]\n+y\n*** End Patch" }),
          toolCall("c4", "bash", { command: "cargo test" }),
          // omp's own resources and directories are not files; ranges and multi-file reads are.
          toolCall("c5", "read", { path: "agent://Main" }),
          toolCall("c6", "read", { path: "." }),
          toolCall("c7", "read", { path: "src/lib.rs:50-115;src/c.rs" }),
          toolCall("c8", "read", { path: "file:///etc/hosts" }),
        ],
      }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const tools = db.query<any, []>("SELECT id, tool, file_path, skill FROM tool_calls ORDER BY id").all();
    expect(tools.map((t) => [t.tool, t.file_path])).toEqual([
      ["read", null],
      ["read", "src/main.rs"],
      ["edit", "src/a.rs"],
      ["edit", "src/b.rs"],
      ["bash", null],
      ["read", null],
      ["read", null],
      ["read", "src/lib.rs"],
      ["read", "src/c.rs"],
      ["read", "/etc/hosts"],
    ]);
    expect(tools.every((t) => t.skill === "us-workflow")).toBe(true);
    expect(db.query<any, []>("SELECT skill FROM usage").get().skill).toBe("us-workflow");
  });

  test("appended messages are picked up incrementally without double counting", async () => {
    const root = tempDir();
    const file = sessionFile(root);
    writeJsonl(file, [header(UUID), user("u1", "Go"), assistant("a1")]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    appendFileSync(file, JSON.stringify(assistant("a2", { ts: "2026-09-28T14:45:00.000Z" })) + "\n");
    await scan(db, testConfig(root), ID);
    const rows = db.query<any, []>("SELECT id, prompt_id FROM usage ORDER BY ts").all();
    expect(rows.map((r) => r.id)).toEqual([`omp:${UUID}:a1`, `omp:${UUID}:a2`]);
    expect(rows[1].prompt_id).toBe(`omp:${UUID}:u1`); // state carried across scans
  });

  test("the source can be switched off", async () => {
    const root = tempDir();
    writeJsonl(sessionFile(root), [header(UUID), assistant("a1")]);
    const db = memDb();
    const cfg = testConfig(root);
    await scan(db, { ...cfg, sources: { ...cfg.sources, enabled: { ...cfg.sources.enabled, omp: false } } }, ID);
    expect(db.query<any, []>("SELECT COUNT(*) n FROM usage").get().n).toBe(0);
  });
});
