import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig } from "./helpers.ts";

const T = Date.parse("2026-10-05T12:00:00.000Z");

/** An OpenCode database with the tables and columns the reader uses, as v1.2+ writes them. */
function opencodeDb(root: string, name = "opencode.db"): Database {
  const dir = join(root, "opencode");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, name), { create: true });
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT,
                          agent TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  return db;
}
const session = (db: Database, id: string, extra: { parent?: string; title?: string; version?: string; agent?: string } = {}) =>
  db.query("INSERT INTO session (id, project_id, parent_id, directory, title, version, agent, time_created, time_updated) VALUES (?, 'p1', ?, '/work/alpha', ?, ?, ?, ?, ?)")
    .run(id, extra.parent ?? null, extra.title ?? "Fix login", extra.version ?? "1.18.30", extra.agent ?? "build", T, T + 60_000);
const message = (db: Database, id: string, sessionId: string, at: number, data: Record<string, unknown>) =>
  db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, at, at + 5000, JSON.stringify(data));
const part = (db: Database, id: string, messageId: string, sessionId: string, at: number, data: Record<string, unknown>) =>
  db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(id, messageId, sessionId, at, at, JSON.stringify(data));
const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({ total: input + output + reasoning + read + write, input, output, reasoning, cache: { read, write } });
const assistant = (parentID: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant", parentID, modelID: "claude-sonnet-5-5", providerID: "anthropic", agent: "build", path: { cwd: "/work/alpha", root: "/work/alpha" },
  time: { created: T + 1000, completed: T + 9000 }, cost: 0.02, tokens: tokens(100, 300, 50, 8000, 900), ...extra,
});

describe("OpenCode ingest", () => {
  test("one usage row per model call, with prompts, tools and subagents tied back", async () => {
    const root = tempDir();
    const oc = opencodeDb(root);
    session(oc, "ses_main");
    session(oc, "ses_child", { parent: "ses_main", title: "Find callers (@explore subagent)", agent: "explore" });
    message(oc, "msg_u1", "ses_main", T, { role: "user", time: { created: T }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } });
    part(oc, "prt_u1", "msg_u1", "ses_main", T, { type: "text", text: "Fix the login redirect" });
    part(oc, "prt_u1s", "msg_u1", "ses_main", T, { type: "text", text: "<system reminder>", synthetic: true });
    message(oc, "msg_a1", "ses_main", T + 1000, assistant("msg_u1"));
    part(oc, "prt_t1", "msg_a1", "ses_main", T + 2000, { type: "tool", callID: "call_read", tool: "read", state: { status: "completed", input: { filePath: "/work/alpha/src/auth.ts" }, time: { start: T + 2000, end: T + 2100 } } });
    part(oc, "prt_t2", "msg_a1", "ses_main", T + 3000, {
      type: "tool", callID: "call_task", tool: "task",
      state: { status: "completed", input: { description: "Find callers", subagent_type: "explore" }, metadata: { parentSessionId: "ses_main", sessionId: "ses_child" }, time: { start: T + 3000 } },
    });
    part(oc, "prt_t3", "msg_a1", "ses_main", T + 4000, { type: "tool", callID: "call_patch", tool: "apply_patch", state: { status: "completed", input: { patchText: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch" } } });
    // Two model calls in one message: each is a row.
    part(oc, "prt_s1", "msg_a1", "ses_main", T + 5000, { type: "step-finish", reason: "tool-calls", cost: 0.01, tokens: tokens(100, 200, 50, 8000, 900) });
    part(oc, "prt_s2", "msg_a1", "ses_main", T + 8000, { type: "step-finish", reason: "stop", cost: 0.01, tokens: tokens(20, 100, 0, 9000, 0) });
    // The subagent's own calls, and a reply still being written (not counted yet).
    message(oc, "msg_cu", "ses_child", T + 3000, { role: "user", time: { created: T + 3000 } });
    message(oc, "msg_ca", "ses_child", T + 3500, assistant("msg_cu", { modelID: "claude-haiku-4-5", time: { created: T + 3500, completed: T + 4500 } }));
    part(oc, "prt_cs", "msg_ca", "ses_child", T + 4500, { type: "step-finish", tokens: tokens(50, 80, 0, 3000, 500) });
    message(oc, "msg_a2", "ses_main", T + 20_000, assistant("msg_u1", { time: { created: T + 20_000 } }));
    oc.close();

    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const usage = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    // The subagent's call counts toward the prompt whose task call started it.
    expect(usage.map((u) => [u.id, u.session_id, u.prompt_id, u.agent])).toEqual([
      ["opencode:prt_cs", "opencode:ses_child", "opencode:msg_u1", "explore"],
      ["opencode:prt_s1", "opencode:ses_main", "opencode:msg_u1", "main"],
      ["opencode:prt_s2", "opencode:ses_main", "opencode:msg_u1", "main"],
    ]);
    // Output includes reasoning, as everywhere in the usage table (OpenCode reports it apart since v1.4).
    expect(usage[1]).toMatchObject({ provider: "opencode", model: "claude-sonnet-5-5", billing: "anthropic", project: "/work/alpha", input_tokens: 100, output_tokens: 250, reasoning_tokens: 50, cache_read_tokens: 8000, cache_write_tokens: 900 });
    expect(usage[0]).toMatchObject({ is_subagent: 1, model: "claude-haiku-4-5" });

    expect(db.query<any, []>("SELECT id, text FROM prompts").all()).toEqual([{ id: "opencode:msg_u1", text: "Fix the login redirect" }]);
    expect(db.query<any, []>("SELECT tool, file_path FROM tool_calls ORDER BY id").all()).toEqual([
      { tool: "apply_patch", file_path: "src/a.ts" },
      { tool: "apply_patch", file_path: "src/b.ts" },
      { tool: "read", file_path: "/work/alpha/src/auth.ts" },
      { tool: "task", file_path: null },
    ]);
    expect(db.query<any, []>("SELECT id, parent_session_id, agent, title FROM sessions ORDER BY id").all()).toEqual([
      { id: "opencode:ses_child", parent_session_id: "opencode:ses_main", agent: "explore", title: "Find callers (@explore subagent)" },
      { id: "opencode:ses_main", parent_session_id: null, agent: null, title: "Fix login" },
    ]);
  });

  test("model call timing, tool outcomes and aborted replies", async () => {
    const root = tempDir();
    const oc = opencodeDb(root);
    session(oc, "ses_main");
    message(oc, "msg_u1", "ses_main", T, { role: "user", time: { created: T } });
    message(oc, "msg_a1", "ses_main", T + 1000, assistant("msg_u1"));
    part(oc, "prt_t1", "msg_a1", "ses_main", T + 2000, { type: "tool", callID: "call_ok", tool: "read", state: { status: "completed", input: {}, time: { start: T + 2000, end: T + 2100 } } });
    part(oc, "prt_t2", "msg_a1", "ses_main", T + 2200, { type: "tool", callID: "call_err", tool: "bash", state: { status: "error", input: {}, error: "exit 1", time: { start: T + 2200, end: T + 2300 } } });
    part(oc, "prt_t3", "msg_a1", "ses_main", T + 2400, { type: "tool", callID: "call_no", tool: "bash", state: { status: "error", input: {}, error: "The user rejected permission to use this specific tool call.", time: { start: T + 2400, end: T + 2500 } } });
    part(oc, "prt_s1", "msg_a1", "ses_main", T + 3000, { type: "step-finish", tokens: tokens(100, 200) });
    part(oc, "prt_b2", "msg_a1", "ses_main", T + 3500, { type: "step-start" });
    part(oc, "prt_s2", "msg_a1", "ses_main", T + 6000, { type: "step-finish", tokens: tokens(100, 200) });
    message(oc, "msg_a2", "ses_main", T + 7000, assistant("msg_u1", { time: { created: T + 7000 }, error: { name: "MessageAbortedError" } }));
    oc.close();

    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT usage_id, start_ts, end_ts FROM response_meta ORDER BY usage_id").all()).toEqual([
      { usage_id: "opencode:msg_a2", start_ts: T + 7000, end_ts: null },
      { usage_id: "opencode:prt_s1", start_ts: T + 1000, end_ts: T + 3000 },
      { usage_id: "opencode:prt_s2", start_ts: T + 3500, end_ts: T + 6000 },
    ]);
    expect(db.query<any, []>("SELECT id, kind FROM outcomes ORDER BY id").all()).toEqual([
      { id: "opencode:call_err", kind: "tool_error" },
      { id: "opencode:call_no", kind: "tool_rejected" },
      { id: "opencode:call_ok", kind: "tool_ok" },
      { id: "opencode:msg_a2:interrupt", kind: "interrupt" },
    ]);
  });

  test("reads only what changed, and counts a reply once it is done", async () => {
    const root = tempDir();
    let oc = opencodeDb(root);
    session(oc, "ses_main", { version: "1.3.10" });
    message(oc, "msg_u1", "ses_main", T, { role: "user", time: { created: T } });
    message(oc, "msg_a1", "ses_main", T + 1000, assistant("msg_u1", { time: { created: T + 1000 } }));
    oc.close();
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(0);

    // The reply finishes later. Before v1.4 output already included reasoning: it isn't added again.
    oc = new Database(join(root, "opencode", "opencode.db"));
    oc.query("UPDATE message SET time_updated = ?, data = ? WHERE id = 'msg_a1'").run(T + 50_000, JSON.stringify(assistant("msg_u1")));
    oc.close();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT id, output_tokens FROM usage").all()).toEqual([{ id: "opencode:msg_a1", output_tokens: 300 }]);
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(1);
  });
});
