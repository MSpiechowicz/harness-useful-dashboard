import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUDGETS } from "../src/core/budgets.ts";
import { openDb } from "../src/core/db.ts";
import { ERR, LEGACY_VERSIONS, McpServer, MODERN_VERSIONS, serveStream, validate } from "../src/mcp/server.ts";
import { createTools, gitBranch } from "../src/mcp/tools.ts";
import { tempDir } from "./helpers.ts";

const MIN = 60_000;
// Noon today: every fixture row falls on the same local day and month, whenever the tests run.
const NOW = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
const DIR = tempDir("hd-mcp-");
const DB = join(DIR, "usage.db");
const REPO = join(DIR, "repo");

/** One project with a session (and its subagent) on a feature branch, failures, a limit reading and a budget's worth of spend. */
function fixture(): void {
  const db = openDb(DB);
  const usage = db.prepare(
    `INSERT INTO usage (id, provider, session_id, prompt_id, ts, project, user, host, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd, is_subagent)
     VALUES (?, ?, ?, ?, ?, ?, 'alex', 'here', ?, 100, 50, 850, 1000, ?, ?)`,
  );
  usage.run("u1", "claude", "claude:s1", "p1", NOW - 30 * MIN, REPO, "claude-opus-5-5", 1.5, 0);
  usage.run("u2", "claude", "claude:s1", "p2", NOW - 20 * MIN, REPO, "claude-opus-5-5", 0.5, 0);
  usage.run("u3", "claude", "claude:s1:agent-1", "p2", NOW - 19 * MIN, REPO, "claude-haiku-4-5", 0.25, 1);
  usage.run("u4", "codex", "codex:c1", "p3", NOW - 10 * MIN, "/work/other", "gpt-5-codex", 2, 0);
  usage.run("u5", "codex", "codex:c0", "p0", NOW - 40 * 86_400_000, "/work/other", "gpt-5-codex", 10, 0); // long ago
  const session = db.prepare("INSERT INTO sessions (id, provider, native_id, project, git_branch, parent_session_id, agent, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  session.run("claude:s1", "claude", "s1", REPO, "feat/mcp", null, null, NOW - 31 * MIN);
  session.run("claude:s1:agent-1", "claude", "s1", REPO, null, "claude:s1", "Explore", NOW - 19 * MIN);
  session.run("codex:c1", "codex", "c1", "/work/other", "main", null, null, NOW - 11 * MIN);
  db.prepare("INSERT INTO prompts (id, session_id, provider, ts, text) VALUES ('p1', 'claude:s1', 'claude', ?, 'Add an MCP server')").run(NOW - 30 * MIN);
  const outcome = db.prepare("INSERT INTO outcomes (id, provider, session_id, ts, project, model, kind, tool, reason, detail) VALUES (?, 'claude', 'claude:s1', ?, ?, 'claude-opus-5-5', ?, ?, ?, ?)");
  outcome.run("o1", NOW - 25 * MIN, REPO, "tool_error", "Edit", "edit_mismatch", "String to replace not found in file.");
  outcome.run("o2", NOW - 24 * MIN, REPO, "tool_error", "Bash", "exit_code", "x".repeat(1000));
  outcome.run("o3", NOW - 23 * MIN, REPO, "tool_ok", "Read", null, null);
  db.prepare(
    `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, used_fraction, resets_at, observed_at)
     VALUES ('here', 'claude', 'five_hour', ?, 'claude', 'max', ?, 0.42, ?, ?)`,
  ).run(1, 5 * 60 * MIN, NOW + 80 * MIN, NOW - 2 * MIN);
  db.close();
  // The working directory is a git checkout of the feature branch.
  mkdirSync(join(REPO, ".git"), { recursive: true });
  writeFileSync(join(REPO, ".git", "HEAD"), "ref: refs/heads/feat/mcp\n");
}
fixture();

const BUDGETS = { ...DEFAULT_BUDGETS, daily: 10, monthly: 100 };

function server(dbPath = DB, env: Record<string, string> = {}) {
  const { tools, close } = createTools({ dbPath, budgets: BUDGETS, user: "alex", host: "here", cwd: join(REPO, "src"), env, now: () => NOW });
  return { s: new McpServer(tools, { name: "harness-dashboard", title: "Harness Dashboard", version: "1.0.0" }, "Usage data."), close };
}

const main = server();
afterAll(() => main.close());

let nextId = 1;
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params !== undefined ? { params } : {}) });
const send = (s: McpServer, msg: unknown) => JSON.parse(s.handleLine(JSON.stringify(msg))!);

/** Calls a tool the legacy way, after an initialize of 2025-06-18, and returns its structured result. */
function call(name: string, args: Record<string, unknown> = {}, s = main.s) {
  send(s, request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } }));
  const r = send(s, request("tools/call", { name, arguments: args })).result;
  if (r.isError) throw new Error(r.content[0].text);
  expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  return r.structuredContent;
}

const modernMeta = (version: string = MODERN_VERSIONS[0]) => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
});

describe("protocol", () => {
  test("initialize agrees on a version the client asks for, else offers the newest legacy one", () => {
    for (const v of LEGACY_VERSIONS) {
      const r = send(main.s, request("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "x", version: "1" } }));
      expect(r.result.protocolVersion).toBe(v);
      expect(r.result.capabilities).toEqual({ tools: {} });
      expect(r.result.serverInfo.name).toBe("harness-dashboard");
      expect(r.result.instructions).toBe("Usage data.");
    }
    const r = send(main.s, request("initialize", { protocolVersion: "2099-01-01", capabilities: {} }));
    expect(r.result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
  });

  test("tools/list: every tool with a schema, titles and hints from the versions that have them", () => {
    send(main.s, request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
    const tools = send(main.s, request("tools/list")).result.tools;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["usage_summary", "breakdown", "session_cost", "branch_cost", "limits", "budget_status", "failures", "tips"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.title).toBeString();
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    send(main.s, request("initialize", { protocolVersion: "2024-11-05", capabilities: {} }));
    const old = send(main.s, request("tools/list")).result.tools[0];
    expect(old.title).toBeUndefined();
    expect(old.annotations).toBeUndefined();
  });

  test("2024-11-05 and 2025-03-26 get text only, 2025-06-18 on also structuredContent", () => {
    for (const [v, structured] of [["2024-11-05", false], ["2025-03-26", false], ["2025-06-18", true], ["2025-11-25", true]] as const) {
      send(main.s, request("initialize", { protocolVersion: v, capabilities: {} }));
      const r = send(main.s, request("tools/call", { name: "limits", arguments: {} })).result;
      expect(r.isError).toBe(false);
      expect(r.content[0].type).toBe("text");
      expect("structuredContent" in r).toBe(structured);
    }
  });

  test("modern requests: server/discover, per-request version, resultType, unsupported versions", () => {
    const d = send(main.s, request("server/discover", { _meta: modernMeta() })).result;
    expect(d.resultType).toBe("complete");
    expect(d.supportedVersions).toEqual([...MODERN_VERSIONS]);
    expect(d.capabilities).toEqual({ tools: {} });
    expect(d._meta["io.modelcontextprotocol/serverInfo"].name).toBe("harness-dashboard");

    const list = send(main.s, request("tools/list", { _meta: modernMeta() })).result;
    expect(list.resultType).toBe("complete");
    expect(list.tools).toHaveLength(8);
    const r = send(main.s, request("tools/call", { name: "usage_summary", arguments: { range: "today" }, _meta: modernMeta() })).result;
    expect(r.resultType).toBe("complete");
    expect(r.structuredContent.costUsd).toBeGreaterThan(0);
    expect(send(main.s, request("ping", { _meta: modernMeta() })).result.resultType).toBe("complete");

    const bad = send(main.s, request("tools/list", { _meta: modernMeta("1900-01-01") })).error;
    expect(bad.code).toBe(ERR.unsupportedVersion);
    expect(bad.data).toEqual({ supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: "1900-01-01" });
    const noCaps = send(main.s, request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0] } })).error;
    expect(noCaps.code).toBe(ERR.invalidParams);
  });

  test("a dual-era client's discover probe without _meta fails, so it falls back to initialize", () => {
    expect(send(main.s, request("server/discover")).error.code).toBe(ERR.methodNotFound);
  });

  test("JSON-RPC errors: unknown method, bad params, unknown tool, bad JSON, invalid request; notifications get no answer", () => {
    expect(send(main.s, request("resources/list")).error.code).toBe(ERR.methodNotFound);
    expect(send(main.s, request("tools/call", { arguments: {} })).error.code).toBe(ERR.invalidParams);
    expect(send(main.s, request("tools/call", { name: "nope" })).error).toEqual({ code: ERR.invalidParams, message: "Unknown tool: nope" });
    expect(send(main.s, request("tools/call", [1, 2])).error.code).toBe(ERR.invalidParams);
    expect(send(main.s, request("initialize", {})).error.code).toBe(ERR.invalidParams);
    expect(JSON.parse(main.s.handleLine("{nope")!).error.code).toBe(ERR.parse);
    expect(send(main.s, { jsonrpc: "1.0", id: 1, method: "ping" }).error.code).toBe(ERR.invalidRequest);
    expect(send(main.s, { jsonrpc: "2.0", id: 9 })).toMatchObject({ id: 9, error: { code: ERR.invalidRequest } });
    expect(main.s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
    expect(main.s.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/whatever", params: {} }))).toBeNull();
    expect(main.s.handleLine("   ")).toBeNull();
    expect(send(main.s, request("ping"))).toMatchObject({ result: {} });
    const batch = JSON.parse(main.s.handleLine(JSON.stringify([request("ping"), { jsonrpc: "2.0", method: "notifications/initialized" }]))!);
    expect(batch).toHaveLength(1);
  });

  test("bad arguments are a tool error the agent can read, not a protocol error", () => {
    send(main.s, request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
    const bad = (args: unknown) => send(main.s, request("tools/call", { name: "breakdown", arguments: args })).result;
    expect(bad({})).toMatchObject({ isError: true, content: [{ type: "text", text: "arguments.dimension is required" }] });
    expect(bad({ dimension: "colour" }).content[0].text).toBe("arguments.dimension must be one of: project, model, provider, user, skill, agent");
    expect(bad({ dimension: "model", limit: 0 }).content[0].text).toBe("arguments.limit must be at least 1");
    expect(bad({ dimension: "model", extra: 1 }).content[0].text).toBe("arguments.extra is not a known argument");
    expect(bad({ dimension: "model", range: "custom" }).content[0].text).toBe("range custom needs from, to or both");
    expect(bad({ dimension: "model", range: "custom", from: "last week" }).content[0].text).toContain("from must be a date");
    expect(bad({ dimension: "model", project: "missing" }).content[0].text).toContain("No project named missing");
    expect(validate(1.5, { type: "integer" })).toBe("arguments must be an integer");
  });

  test("serves a stream line by line, split anywhere, and stops when it ends", async () => {
    const { s, close } = server();
    const lines = [
      request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("tools/list"),
      request("tools/call", { name: "usage_summary", arguments: {} }),
    ].map((m) => JSON.stringify(m) + "\n").join("");
    const bytes = new TextEncoder().encode(lines);
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const out: string[] = [];
    await serveStream(s, input, (l) => out.push(l));
    close();
    expect(out).toHaveLength(3);
    for (const l of out) expect(l.endsWith("\n") && !l.slice(0, -1).includes("\n")).toBe(true);
    expect(JSON.parse(out[2]!).result.structuredContent.costUsd).toBeCloseTo(4.25);
  });
});

describe("tools", () => {
  test("usage_summary: today's cost, tokens by type, sessions, cache hit rate, filters", () => {
    const r = call("usage_summary");
    expect(r.range.name).toBe("today");
    expect(r.costUsd).toBeCloseTo(4.25);
    expect(r.tokens).toEqual({ total: 4000, input: 400, output: 200, cacheRead: 3400, cacheWrite: 0, reasoning: 0 });
    expect(r.sessions).toBe(3);
    expect(r.cacheHitRate).toBeCloseTo(0.895, 3);
    expect(r.previousPeriod.costUsd).toBe(0);
    expect(r.lastActivity).toBe(new Date(NOW - 10 * MIN).toISOString());
    expect(r.note).toContain("API-equivalent");
    expect(call("usage_summary", { range: "all" }).costUsd).toBeCloseTo(14.25);
    expect(call("usage_summary", { range: "30d", project: "repo" }).costUsd).toBeCloseTo(2.25);
    expect(call("usage_summary", { range: "custom", from: new Date(NOW - 50 * 86_400_000).toISOString(), to: new Date(NOW - 30 * 86_400_000).toISOString() }).costUsd).toBe(10);
  });

  test("breakdown: rows by cost with shares, capped by limit", () => {
    const r = call("breakdown", { dimension: "project", limit: 1 });
    expect(r.rows).toEqual([expect.objectContaining({ key: REPO, label: "repo", costUsd: 2.25, share: 0.529 })]);
    expect(r.moreRows).toBe(true);
    expect(r.totalCostUsd).toBe(4.25);
    expect(call("breakdown", { dimension: "model", range: "all" }).rows.map((x: { key: string }) => x.key)).toEqual(["gpt-5-codex", "claude-opus-5-5", "claude-haiku-4-5"]);
  });

  test("session_cost: by id in either form, subagents included, else the working directory's latest session", () => {
    for (const id of ["s1", "claude:s1"]) {
      const r = call("session_cost", { session_id: id });
      expect(r.sessionId).toBe("claude:s1");
      expect(r.costUsd).toBeCloseTo(2.25);
      expect(r.ownCostUsd).toBeCloseTo(2);
      expect(r.subagents).toEqual({ count: 1, costUsd: 0.25, tokens: 1000 });
      expect(r.branch).toBe("feat/mcp");
      expect(r.title).toBe("Add an MCP server");
    }
    const byCwd = call("session_cost");
    expect(byCwd).toMatchObject({ sessionId: "claude:s1", resolvedBy: "cwd" });
    expect(call("session_cost", { cwd: "/work/other/deep" }).sessionId).toBe("codex:c1");
    const env = server(DB, { CLAUDE_CODE_SESSION_ID: "s1" });
    expect(call("session_cost", {}, env.s).resolvedBy).toBe("environment");
    env.close();
    expect(() => call("session_cost", { session_id: "nope" })).toThrow("No session nope");
  });

  test("branch_cost: the checked-out branch by default, or one named", () => {
    expect(gitBranch(join(REPO, "src"))).toBe("feat/mcp");
    const r = call("branch_cost");
    expect(r).toMatchObject({ branch: "feat/mcp", project: REPO, costUsd: 2.25, sessions: 1 });
    expect(r.latestSessions[0]).toMatchObject({ id: "claude:s1", subagents: 1 });
    expect(call("branch_cost", { branch: "main" })).toMatchObject({ project: "/work/other", costUsd: 2, longLived: true });
    expect(() => call("branch_cost", { branch: "gone" })).toThrow("No usage on branch gone");
  });

  test("limits: the latest stored reading with its reset time and age", () => {
    const r = call("limits");
    expect(r.windows).toEqual([
      { provider: "claude", plan: "max", window: "5h", usedPercent: 42, resetsAt: new Date(NOW + 80 * MIN).toISOString(), observedAt: new Date(NOW - 2 * MIN).toISOString(), ageMinutes: 2, status: "fresh" },
    ]);
  });

  test("budget_status: today and this month against the caps", () => {
    const r = call("budget_status");
    expect(r.user).toBe("alex");
    expect(r.budgets[0]).toMatchObject({ scope: "daily", capUsd: 10, spentUsd: 4.25, usedPercent: 42.5, remainingUsd: 5.75, status: "ok" });
    expect(r.budgets[1]).toMatchObject({ scope: "monthly", spentUsd: 4.25 });
  });

  test("failures: causes, tools and the latest failures, shortened", () => {
    const r = call("failures");
    expect(r.totals).toMatchObject({ calls: 3, failed: 2 });
    expect(r.causes.map((c: { cause: string }) => c.cause).sort()).toEqual(["edit_mismatch", "exit_code"]);
    expect(r.recent[0]).toMatchObject({ tool: "Bash", cause: "exit_code", sessionId: "claude:s1" });
    expect(r.recent[0].error.length).toBe(300);
    const edit = call("failures", { tool: "Edit" });
    expect(edit.recent).toEqual([expect.objectContaining({ tool: "Edit", error: "String to replace not found in file." })]);
    expect(edit.tools).toEqual([expect.objectContaining({ tool: "Edit", failed: 1, mainCause: "edit_mismatch" })]);
  });

  test("tips: worded in English", () => {
    const r = call("tips", { range: "all" });
    expect(Array.isArray(r.tips)).toBe(true);
    for (const tip of r.tips) expect(tip.title).not.toBe(tip.id);
  });

  test("a missing database is a tool error, and nothing is created", () => {
    const path = join(DIR, "nowhere", "usage.db");
    const { s, close } = server(path);
    send(s, request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
    const r = send(s, request("tools/call", { name: "usage_summary", arguments: {} })).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`No usage database at ${path}`);
    expect(existsSync(join(DIR, "nowhere"))).toBe(false);
    close();
  });
});

describe("mcp command", () => {
  test("the CLI serves stdio: only protocol messages on stdout, exits when stdin closes", async () => {
    const input = [
      request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      request("tools/list"),
      request("tools/call", { name: "session_cost", arguments: { session_id: "s1" } }),
    ].map((m) => JSON.stringify(m)).join("\n") + "\n";
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "mcp", "--db", DB], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HARNESS_DASHBOARD_HOME: join(DIR, "home"), CLAUDE_CODE_SESSION_ID: "" },
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const lines = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.id)).toEqual([lines[0].id, lines[1].id, lines[2].id]);
    expect(lines[0].result.serverInfo.name).toBe("harness-dashboard");
    expect(lines[1].result.tools).toHaveLength(8);
    expect(lines[2].result.structuredContent.costUsd).toBeCloseTo(2.25);
  });
});
