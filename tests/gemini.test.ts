import { describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig, writeFileAt, writeJsonl } from "./helpers.ts";

const SID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const SUB = "2c1d0e9f-1111-4222-8333-444455556666";
const HASH = "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8";
const projectDir = (root: string) => join(root, "gemini", "tmp", "my-app");
const chatFile = (root: string, ext = "jsonl") => join(projectDir(root), "chats", `session-2026-10-06T09-00-8f14e45f.${ext}`);

const header = (sessionId = SID, extra: Record<string, unknown> = {}) => ({ sessionId, projectHash: HASH, startTime: "2026-10-06T09:00:00.000Z", lastUpdated: "2026-10-06T09:00:00.000Z", ...extra });
const user = (id: string, text: string, ts = "2026-10-06T09:00:05.000Z") => ({ id, timestamp: ts, type: "user", content: [{ text }] });
function gemini(id: string, opts: { tokens?: Record<string, number> | null; toolCalls?: unknown[]; ts?: string; model?: string } = {}) {
  return {
    id,
    timestamp: opts.ts ?? "2026-10-06T09:00:09.000Z",
    type: "gemini",
    content: "I'll read the router first.",
    thoughts: [{ subject: "Inspecting routes", description: "Find the router.", timestamp: "2026-10-06T09:00:07.000Z" }],
    model: opts.model ?? "gemini-3.5-flash",
    ...(opts.tokens === null ? {} : { tokens: opts.tokens ?? { input: 15327, output: 23, cached: 11526, thoughts: 919, tool: 7, total: 16276 } }),
    ...(opts.toolCalls ? { toolCalls: opts.toolCalls } : {}),
  };
}
const readCall = (status: string) => ({
  id: "read_file-1759741209000-1",
  name: "read_file",
  args: { file_path: "/home/u/my-app/src/router.ts" },
  status,
  timestamp: "2026-10-06T09:00:10.000Z",
  ...(status === "success" ? { result: [{ functionResponse: { id: "read_file-1759741209000-1", name: "read_file", response: { output: "export const r = 1" } } }] } : {}),
  displayName: "ReadFile",
});
const shellFail = {
  id: "run_shell_command-1759741209000-2",
  name: "run_shell_command",
  args: { command: "npm test" },
  status: "error",
  timestamp: "2026-10-06T09:00:12.000Z",
  result: [{ functionResponse: { id: "run_shell_command-1759741209000-2", name: "run_shell_command", response: { error: "Command exited with code 1: npm ERR! Test failed" } } }],
};

function setupProject(root: string) {
  writeFileAt(join(projectDir(root), ".project_root"), "/home/u/my-app\n");
}

describe("Gemini CLI ingest", () => {
  test("a chat's responses become usage rows, with input net of the cache and thoughts in the output", async () => {
    const root = tempDir();
    setupProject(root);
    writeJsonl(chatFile(root), [
      header(),
      user("m1", "Add a /health endpoint"),
      { $set: { lastUpdated: "2026-10-06T09:00:05.010Z" } },
      // Written again as it changes: first without tokens and with the call running, then whole.
      gemini("m2", { tokens: null, toolCalls: [readCall("executing")] }),
      gemini("m2", { toolCalls: [readCall("success"), shellFail] }),
      { $patch: { updates: [{ id: "m2", toolCalls: [{ id: "read_file-1759741209000-1", result: [{ text: "[masked]" }] }] }] } },
      { $set: { summary: "Add a health endpoint" } },
      { id: "m3", timestamp: "2026-10-06T09:00:20.000Z", type: "info", content: "Request cancelled." },
      { $rewindTo: "m3" },
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const rows = db.query<any, []>("SELECT * FROM usage").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `gemini:${SID}:m2`, provider: "gemini", model: "gemini-3.5-flash", project: "/home/u/my-app", prompt_id: `gemini:${SID}:m1`,
      input_tokens: 15327 - 11526 + 7, cache_read_tokens: 11526, output_tokens: 23 + 919, reasoning_tokens: 919, agent: "main", is_subagent: 0, cost_estimated: 0,
    });
    // gemini-3.5-flash: $1.50 in, $9 out, $0.15 cache read.
    expect(rows[0].cost_usd).toBeCloseTo((3808 * 1.5 + 942 * 9 + 11526 * 0.15) / 1e6, 10);

    expect(db.query<any, []>("SELECT * FROM sessions").get()).toMatchObject({ id: `gemini:${SID}`, provider: "gemini", client: "gemini-cli", title: "Add a health endpoint", project: "/home/u/my-app" });
    expect(db.query<any, []>("SELECT * FROM prompts").get()).toMatchObject({ id: `gemini:${SID}:m1`, text: "Add a /health endpoint" });

    const tools = db.query<any, []>("SELECT tool, file_path, usage_id FROM tool_calls ORDER BY ts").all();
    expect(tools).toEqual([
      { tool: "read_file", file_path: "/home/u/my-app/src/router.ts", usage_id: `gemini:${SID}:m2` },
      { tool: "run_shell_command", file_path: null, usage_id: `gemini:${SID}:m2` },
    ]);
    const outcomes = db.query<any, []>("SELECT tool, kind, reason, detail, input FROM outcomes ORDER BY ts").all();
    expect(outcomes).toEqual([
      { tool: "read_file", kind: "tool_ok", reason: null, detail: null, input: null },
      { tool: "run_shell_command", kind: "tool_error", reason: "exit_code", detail: "Command exited with code 1: npm ERR! Test failed", input: "npm test" },
      { tool: null, kind: "interrupt", reason: null, detail: null, input: null },
    ]);
  });

  test("reading on from where the last scan stopped", async () => {
    const root = tempDir();
    setupProject(root);
    writeJsonl(chatFile(root), [header(), user("m1", "First"), gemini("m2")]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    appendFileSync(chatFile(root), JSON.stringify(user("m3", "Second", "2026-10-06T09:05:00.000Z")) + "\n" + JSON.stringify(gemini("m4", { ts: "2026-10-06T09:05:04.000Z", model: "gemini-3.1-pro-preview" })) + "\n");
    await scan(db, testConfig(root), ID);
    const rows = db.query<any, []>("SELECT id, prompt_id, model, session_id FROM usage ORDER BY ts").all();
    expect(rows).toEqual([
      { id: `gemini:${SID}:m2`, prompt_id: `gemini:${SID}:m1`, model: "gemini-3.5-flash", session_id: `gemini:${SID}` },
      { id: `gemini:${SID}:m4`, prompt_id: `gemini:${SID}:m3`, model: "gemini-3.1-pro-preview", session_id: `gemini:${SID}` },
    ]);
  });

  test("a subagent's chat is tied to its parent, and its brief is no prompt", async () => {
    const root = tempDir();
    setupProject(root);
    writeJsonl(chatFile(root), [header(), user("m1", "Look around"), gemini("m2")]);
    writeJsonl(join(projectDir(root), "chats", SID, `${SUB}.jsonl`), [header(SUB, { kind: "subagent" }), user("s1", "Map the routes"), gemini("s2")]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>(`SELECT * FROM sessions WHERE id = 'gemini:${SUB}'`).get()).toMatchObject({ parent_session_id: `gemini:${SID}`, agent: "subagent", brief: "Map the routes", project: "/home/u/my-app" });
    expect(db.query<any, []>(`SELECT agent, is_subagent FROM usage WHERE session_id = 'gemini:${SUB}'`).get()).toEqual({ agent: "subagent", is_subagent: 1 });
    expect(db.query<any, []>("SELECT count(*) AS n FROM prompts").get()).toEqual({ n: 1 });
  });

  test("an older chat in one JSON file, and its copy in a .jsonl after a resume, count once", async () => {
    const root = tempDir();
    // No .project_root: the folder is found in projects.json.
    writeFileAt(join(root, "gemini", "projects.json"), JSON.stringify({ projects: { "/home/u/my-app": "my-app" } }));
    const doc = { ...header(), messages: [user("m1", "Add a /health endpoint"), gemini("m2")] };
    writeFileAt(chatFile(root, "json"), JSON.stringify(doc, null, 2));
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);
    writeJsonl(chatFile(root), [header(), ...doc.messages, user("m3", "And a test", "2026-10-06T10:00:00.000Z")]);
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT id, project FROM usage").all()).toEqual([{ id: `gemini:${SID}:m2`, project: "/home/u/my-app" }]);
    expect(db.query<any, []>("SELECT count(*) AS n FROM prompts").get()).toEqual({ n: 2 });
    // A file caught half written is read again once it changes, not reported.
    writeFileSync(chatFile(root, "json"), "{\"sessionId\":");
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
  });

  test("turned off, nothing is read", async () => {
    const root = tempDir();
    writeJsonl(chatFile(root), [header(), user("m1", "Hi"), gemini("m2")]);
    const cfg = testConfig(root);
    cfg.sources.enabled.gemini = false;
    const db = memDb();
    await scan(db, cfg, ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 0 });
  });
});
