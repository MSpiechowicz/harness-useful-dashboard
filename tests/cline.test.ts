import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { netInput } from "../src/core/ingest/cline.ts";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig } from "./helpers.ts";

const T = Date.parse("2026-09-20T10:00:00.000Z");
const write = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};
const req = (ts: number, info: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ request: "…", ...info }), ...extra });

describe("Cline, Roo Code and Kilo Code ingest", () => {
  test("a folder is an extension's own, a whole globalStorage, or a data folder", async () => {
    const { findClineSources } = await import("../src/core/ingest/cline.ts");
    const root = tempDir();
    const storage = join(root, "globalStorage");
    write(join(storage, "saoudrizwan.claude-dev", "tasks", "c1", "ui_messages.json"), []);
    write(join(storage, "rooveterinaryinc.roo-cline", "tasks", "r1", "ui_messages.json"), []);
    write(join(root, ".cline", "data", "tasks", "c2", "ui_messages.json"), []);
    const ids = (dir: string, family: "cline" | "roo" | "kilo") => findClineSources(dir, family).tasks.map((t) => `${t.provider}/${basename(t.dir)}`);
    expect(ids(storage, "cline")).toEqual(["cline/c1"]);
    expect(ids(storage, "roo")).toEqual(["roo/r1"]);
    expect(ids(join(storage, "rooveterinaryinc.roo-cline"), "roo")).toEqual(["roo/r1"]);
    expect(ids(join(root, ".cline", "data"), "cline")).toEqual(["cline/c2"]);
    expect(ids(storage, "kilo")).toEqual([]);
  });

  test("input tokens are made net of cache when they include it", () => {
    expect(netInput(12, 15000, 180)).toBe(12); // Cline with Anthropic: already net
    expect(netInput(15300, 15000, 180)).toBe(120); // Roo since 3.30: cache included
    expect(netInput(500, 0, 0)).toBe(500);
  });

  test("Cline and Roo Code task folders: a usage row per model call, with the extension's cost", async () => {
    const root = tempDir();
    const storage = join(root, "vscode", "globalStorage");

    // Cline 3: the model on every message, the folder from its task list.
    const cline = join(storage, "saoudrizwan.claude-dev");
    write(join(cline, "state", "taskHistory.json"), [{ id: "1758362400000", ts: T, task: "Fix login", cwdOnTaskInitialization: "/work/alpha" }]);
    write(join(cline, "tasks", "1758362400000", "ui_messages.json"), [
      { ts: T, type: "say", say: "task", text: "Fix login" },
      req(T + 1000, { tokensIn: 12, tokensOut: 340, cacheWrites: 9000, cacheReads: 0, cost: 0.039 }, { modelInfo: { providerId: "anthropic", modelId: "claude-sonnet-5-5", mode: "act" } }),
      { ts: T + 2000, type: "ask", ask: "tool", text: JSON.stringify({ tool: "readFile", path: "src/a.ts" }) },
      { ts: T + 3000, type: "ask", ask: "command", text: "npm test" },
      { ts: T + 4000, type: "say", say: "user_feedback", text: "also do X" },
      req(T + 5000, { tokensIn: 30, tokensOut: 50, cacheWrites: 0, cacheReads: 9000, cost: 0.01, cancelReason: "user_cancelled" }, { modelInfo: { providerId: "anthropic", modelId: "claude-sonnet-5-5" } }),
      req(T + 6000, { tokensIn: 5 }), // still running: no cost yet
    ]);

    // Roo Code: no model on the messages (it's in the API history), cache counted in tokensIn, task list in state.vscdb.
    const rooTask = join(storage, "rooveterinaryinc.roo-cline", "tasks", "6f1c-roo");
    write(join(rooTask, "ui_messages.json"), [
      { ts: T, type: "say", say: "text", text: "Add docs" },
      req(T + 1000, { tokensIn: 15300, tokensOut: 400, cacheWrites: 180, cacheReads: 15000, cost: 0.02, apiProtocol: "anthropic" }),
    ]);
    write(join(rooTask, "api_conversation_history.json"), [{ role: "user", ts: T, content: [{ type: "text", text: "<environment_details>\n<model>claude-opus-5-5</model>\n</environment_details>" }] }]);
    const vscdb = new Database(join(storage, "state.vscdb"), { create: true });
    vscdb.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    vscdb.query("INSERT INTO ItemTable VALUES (?, ?)").run("RooVeterinaryInc.roo-cline", JSON.stringify({ taskHistory: [{ id: "6f1c-roo", workspace: "/work/beta", task: "Add docs" }] }));
    vscdb.close();

    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const usage = db.query<any, []>("SELECT * FROM usage ORDER BY id").all();
    expect(usage.map((u) => u.provider)).toEqual(["cline", "cline", "roo"]);
    expect(usage.map((u) => [u.id, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cost_usd, u.project])).toEqual([
      [`cline:1758362400000:${T + 1000}`, "claude-sonnet-5-5", 12, 340, 0, 9000, 0.039, "/work/alpha"],
      [`cline:1758362400000:${T + 5000}`, "claude-sonnet-5-5", 30, 50, 9000, 0, 0.01, "/work/alpha"],
      [`roo:6f1c-roo:${T + 1000}`, "claude-opus-5-5", 120, 400, 15000, 180, 0.02, "/work/beta"],
    ]);
    expect(usage[1].prompt_id).toBe(`cline:1758362400000:${T + 4000}`);
    expect(db.query<any, []>("SELECT id, client, title FROM sessions ORDER BY id").all()).toEqual([
      { id: "cline:1758362400000", client: "cline", title: "Fix login" },
      { id: "roo:6f1c-roo", client: "roo-code", title: "Add docs" },
    ]);
    expect(db.query<any, []>("SELECT tool, file_path FROM tool_calls ORDER BY ts").all()).toEqual([
      { tool: "readFile", file_path: "src/a.ts" },
      { tool: "execute_command", file_path: null },
    ]);
    expect(db.query<any, []>("SELECT kind FROM outcomes").all()).toEqual([{ kind: "interrupt" }]);

    // The extension's cost stays when prices are edited.
    const { recomputeCosts } = await import("../src/core/ingest/writer.ts");
    const { PriceBook } = await import("../src/core/pricing.ts");
    recomputeCosts(db, new PriceBook());
    expect(db.query<any, []>("SELECT cost_usd FROM usage ORDER BY id").all().map((r) => r.cost_usd)).toEqual([0.039, 0.01, 0.02]);
  });

  test("Cline 4 sessions: per-turn usage, subagents, and no double count of a task copied from the older format", async () => {
    const root = tempDir();
    const data = join(root, "cline");
    mkdirSync(join(data, "db"), { recursive: true });
    const sdb = new Database(join(data, "db", "sessions.db"), { create: true });
    sdb.exec(`CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT, cwd TEXT, workspace_root TEXT, parent_session_id TEXT, is_subagent INTEGER,
                                     metadata_json TEXT, started_at TEXT, ended_at TEXT)`);
    sdb.query("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("s1", "vscode", "/work/gamma/src", "/work/gamma", null, 0, JSON.stringify({ title: "Refactor", modelId: "claude-sonnet-5-5" }), null, null);
    sdb.close();
    const turn = (id: string, ts: number, metrics: Record<string, number>, content: unknown[] = []) => ({
      id, role: "assistant", ts, content, modelInfo: { id: "claude-sonnet-5-5", provider: "anthropic" }, metrics,
    });
    write(join(data, "sessions", "s1", "s1.messages.json"), {
      version: 1,
      messages: [
        { id: "m0", role: "user", ts: T, content: '<user_input mode="act">Refactor the store</user_input>' },
        turn("m1", T + 1000, { inputTokens: 15200, outputTokens: 420, cacheReadTokens: 15000, cacheWriteTokens: 180, reasoningTokenCount: 0, cost: 0.0123 }, [
          { type: "tool_use", id: "tu1", name: "read_files", input: { path: "a.ts" } },
        ]),
        { id: "m2", role: "user", ts: T + 1500, content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "no such file" }] },
        turn("m3", T + 2000, { inputTokens: 300, outputTokens: 50, cost: 0.002 }),
      ],
    });
    write(join(data, "sessions", "s1", "explorer.messages.json"), { messages: [turn("x1", T + 1200, { inputTokens: 100, outputTokens: 10, cost: 0.001 })] });
    // A task resumed in Cline 4 keeps its id: its calls up to then are counted from the task folder.
    write(join(data, "tasks", "s2", "ui_messages.json"), [{ ts: T, type: "say", say: "task", text: "Old task" }, req(T + 100, { tokensIn: 10, tokensOut: 10, cost: 0.001 })]);
    write(join(data, "sessions", "s2", "s2.messages.json"), { messages: [turn("o1", T + 100, { inputTokens: 10, outputTokens: 10, cost: 0.001 }), turn("o2", T + 9000, { inputTokens: 20, outputTokens: 20, cost: 0.002 })] });

    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);
    const usage = db.query<any, []>("SELECT id, input_tokens, cache_read_tokens, cost_usd, agent, project FROM usage ORDER BY id").all();
    expect(usage).toEqual([
      { id: "cline:s1:explorer:x1", input_tokens: 100, cache_read_tokens: 0, cost_usd: 0.001, agent: "explorer", project: "/work/gamma" },
      { id: "cline:s1:m1", input_tokens: 20, cache_read_tokens: 15000, cost_usd: 0.0123, agent: "main", project: "/work/gamma" },
      { id: "cline:s1:m3", input_tokens: 300, cache_read_tokens: 0, cost_usd: 0.002, agent: "main", project: "/work/gamma" },
      { id: `cline:s2:${T + 100}`, input_tokens: 10, cache_read_tokens: 0, cost_usd: 0.001, agent: "main", project: null },
      { id: "cline:s2:o2", input_tokens: 20, cache_read_tokens: 0, cost_usd: 0.002, agent: "main", project: null },
    ]);
    expect(db.query<any, []>("SELECT text FROM prompts WHERE session_id = 'cline:s1'").get().text).toBe("Refactor the store");
    expect(db.query<any, []>("SELECT id, kind FROM outcomes").all()).toEqual([{ id: "cline:tu1", kind: "tool_error" }]);
    expect(db.query<any, []>("SELECT title, parent_session_id FROM sessions WHERE id = 'cline:s1:explorer'").get()).toEqual({ title: "explorer", parent_session_id: "cline:s1" });
  });

  test("Kilo Code 7's database is read as Kilo Code's, with Kilo's cost", async () => {
    const root = tempDir();
    mkdirSync(join(root, "kilo"), { recursive: true });
    const k = new Database(join(root, "kilo", "kilo.db"), { create: true });
    k.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, version TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    k.query("INSERT INTO session VALUES ('ses_k', 'p', NULL, '/work/delta', 'Kilo work', '7.8.3', 'code', ?, ?)").run(T, T + 9000);
    k.query("INSERT INTO message VALUES ('msg_u', 'ses_k', ?, ?, ?)").run(T, T, JSON.stringify({ role: "user", time: { created: T } }));
    k.query("INSERT INTO message VALUES ('msg_a', 'ses_k', ?, ?, ?)").run(T + 1000, T + 5000, JSON.stringify({ role: "assistant", parentID: "msg_u", modelID: "claude-sonnet-5-5", providerID: "kilo", time: { created: T + 1000, completed: T + 5000 } }));
    k.query("INSERT INTO part VALUES ('prt_s', 'msg_a', 'ses_k', ?, ?, ?)").run(T + 4000, T + 4000, JSON.stringify({ type: "step-finish", cost: 0.0042, tokens: { input: 310, output: 95, reasoning: 0, cache: { read: 14800, write: 0 } }, model: { providerID: "anthropic", modelID: "claude-opus-5-5" } }));
    k.close();

    const db = memDb();
    expect((await scan(db, testConfig(root), ID)).errors).toEqual([]);
    expect(db.query<any, []>("SELECT id, provider, model, input_tokens, cost_usd, project FROM usage").all()).toEqual([
      { id: "kilo:prt_s", provider: "kilo", model: "claude-opus-5-5", input_tokens: 310, cost_usd: 0.0042, project: "/work/delta" },
    ]);
    expect(db.query<any, []>("SELECT client FROM sessions").get().client).toBe("kilo-code");
  });
});
