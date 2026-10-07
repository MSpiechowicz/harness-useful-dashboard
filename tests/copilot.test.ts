import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const SID = "3f0a1c22-6b41-4d0e-9c7a-5e2b8d4f1a00";
const eventsFile = (root: string) => join(root, "copilot", "session-state", SID, "events.jsonl");
const START = Date.parse("2026-10-06T10:00:00.000Z");

let n = 0;
const ev = (type: string, ts: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type, data, id: `e${++n}`, timestamp: ts, parentId: null, ...extra });
const start = () =>
  ev("session.start", "2026-10-06T10:00:00.000Z", {
    sessionId: SID, version: 1, producer: "copilot-agent", copilotVersion: "1.0.92", startTime: "2026-10-06T10:00:00.000Z", selectedModel: "claude-sonnet-4.5",
    context: { cwd: "/home/u/my-app", gitRoot: "/home/u/my-app", branch: "main", repository: "acme/my-app" },
  });
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({ requests: { count: cost, cost }, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: 0 } });
const shutdown = (ts: string, metrics: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ev("session.shutdown", ts, { shutdownType: "routine", sessionStartTime: START, totalApiDurationMs: 9100, currentModel: "gpt-5.4", modelMetrics: metrics, ...extra });

function turn() {
  return [
    ev("user.message", "2026-10-06T10:00:05.000Z", { content: "Add a /health endpoint", messageId: "m-1", interactionId: "int-1" }),
    ev("assistant.turn_start", "2026-10-06T10:00:05.100Z", { turnId: "0", model: "claude-sonnet-4.5" }),
    ev("assistant.message", "2026-10-06T10:00:08.000Z", {
      messageId: "am-1", content: "I'll read the router.", model: "claude-sonnet-4.5", outputTokens: 42,
      toolRequests: [
        { toolCallId: "toolu_01", name: "view", arguments: { path: "/home/u/my-app/src/router.ts" } },
        { toolCallId: "toolu_02", name: "bash", arguments: { command: "npm test", description: "Run tests" } },
        { toolCallId: "toolu_03", name: "edit", arguments: { path: "/home/u/my-app/src/router.ts" } },
      ],
    }),
    ev("tool.execution_complete", "2026-10-06T10:00:08.300Z", { toolCallId: "toolu_01", success: true, result: { content: "export const r = 1" } }),
    ev("tool.execution_complete", "2026-10-06T10:00:12.000Z", { toolCallId: "toolu_02", success: false, error: { message: "Command exited with code 1", code: "failure" } }),
    ev("tool.execution_complete", "2026-10-06T10:00:13.000Z", { toolCallId: "toolu_03", success: false, error: { message: "The user rejected this tool call.", code: "rejected" } }),
    ev("abort", "2026-10-06T10:00:14.000Z", { reason: "user initiated" }),
  ];
}

describe("Copilot CLI ingest", () => {
  test("a session's shutdown totals become usage rows per model, billed through Copilot", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), [
      start(),
      ...turn(),
      ev("session.model_change", "2026-10-06T10:01:00.000Z", { previousModel: "claude-sonnet-4.5", newModel: "gpt-5.4" }),
      shutdown("2026-10-06T10:02:00.000Z", { "claude-sonnet-4.5": usage(41000, 180, 30000, 9000, 2), "gpt-5.4": usage(0, 0, 0, 0, 0) }, { totalPremiumRequests: 2 }),
    ]);
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const rows = db.query<any, []>("SELECT * FROM usage").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "copilot", model: "claude-sonnet-4.5", billing: "github-copilot", premium_requests: 2, project: "/home/u/my-app",
      input_tokens: 2000, output_tokens: 180, cache_read_tokens: 30000, cache_write_tokens: 9000, agent: "main", is_subagent: 0,
      ts: Date.parse("2026-10-06T10:02:00.000Z"),
    });
    expect(rows[0].prompt_id).toBe(`copilot:${SID}:e2`);

    expect(db.query<any, []>("SELECT * FROM sessions").get()).toMatchObject({ id: `copilot:${SID}`, client: "copilot-cli", client_version: "1.0.92", git_branch: "main", project: "/home/u/my-app" });
    expect(db.query<any, []>("SELECT text FROM prompts").get()).toEqual({ text: "Add a /health endpoint" });
    expect(db.query<any, []>("SELECT tool, file_path FROM tool_calls ORDER BY id").all()).toEqual([
      { tool: "view", file_path: "/home/u/my-app/src/router.ts" },
      { tool: "bash", file_path: null },
      { tool: "edit", file_path: "/home/u/my-app/src/router.ts" },
    ]);
    expect(db.query<any, []>("SELECT tool, kind, reason, input, model FROM outcomes ORDER BY ts").all()).toEqual([
      { tool: "view", kind: "tool_ok", reason: null, input: null, model: "claude-sonnet-4.5" },
      { tool: "bash", kind: "tool_error", reason: "exit_code", input: "npm test", model: "claude-sonnet-4.5" },
      { tool: "edit", kind: "tool_rejected", reason: "rejected", input: "/home/u/my-app/src/router.ts", model: "claude-sonnet-4.5" },
      { tool: null, kind: "interrupt", reason: null, input: null, model: "claude-sonnet-4.5" },
    ]);
  });

  test("a resumed session's next shutdown adds only what grew since, per agent", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), [start(), ...turn(), shutdown("2026-10-06T10:02:00.000Z", { "claude-sonnet-4.5": usage(41000, 180, 30000, 9000, 2) })]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    appendFileSync(
      eventsFile(root),
      [
        ev("session.resume", "2026-10-06T11:00:00.000Z", { resumeTime: "2026-10-06T11:00:00.000Z", eventCount: 12, selectedModel: "gpt-5.4", context: { cwd: "/home/u/my-app" } }),
        ev("user.message", "2026-10-06T11:00:05.000Z", { content: "Now the tests" }),
        shutdown("2026-10-06T11:05:00.000Z", {}, {
          agentMetrics: {
            main: { modelMetrics: { "claude-sonnet-4.5": usage(60000, 300, 45000, 9000, 3), "gpt-5.4-1m": usage(5000, 50, 1000, 0, 1) } },
            "agent-7": { agentName: "explore", modelMetrics: { "claude-haiku-4.5": usage(8000, 90, 0, 0, 0) } },
          },
        }),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    await scan(db, testConfig(root), ID);
    const rows = db.query<any, []>("SELECT model, agent, is_subagent, input_tokens, output_tokens, cache_read_tokens, premium_requests FROM usage ORDER BY ts, model").all();
    expect(rows).toEqual([
      { model: "claude-sonnet-4.5", agent: "main", is_subagent: 0, input_tokens: 2000, output_tokens: 180, cache_read_tokens: 30000, premium_requests: 2 },
      { model: "claude-haiku-4.5", agent: "explore", is_subagent: 1, input_tokens: 8000, output_tokens: 90, cache_read_tokens: 0, premium_requests: 0 },
      // 60000 - 41000 more input, 15000 of it cache reads.
      { model: "claude-sonnet-4.5", agent: "main", is_subagent: 0, input_tokens: 4000, output_tokens: 120, cache_read_tokens: 15000, premium_requests: 1 },
      // The long-context variant is priced as its model.
      { model: "gpt-5.4", agent: "main", is_subagent: 0, input_tokens: 4000, output_tokens: 50, cache_read_tokens: 1000, premium_requests: 1 },
    ]);
  });

  test("a session without a shutdown keeps its prompts and tools but has no tokens", async () => {
    const root = tempDir();
    writeJsonl(eventsFile(root), [start(), ...turn()]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT count(*) AS n FROM usage").get()).toEqual({ n: 0 });
    expect(db.query<any, []>("SELECT count(*) AS n FROM tool_calls").get()).toEqual({ n: 3 });
    expect(db.query<any, []>("SELECT count(*) AS n FROM prompts").get()).toEqual({ n: 1 });
  });
});
