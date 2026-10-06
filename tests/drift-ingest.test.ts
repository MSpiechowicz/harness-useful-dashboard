import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import {
  CLAUDE_SESSION,
  claudeAssistant,
  claudeUser,
  codexMeta,
  codexRecord,
  codexUserMessage,
  ID,
  memDb,
  tempDir,
  testConfig,
  writeJsonl,
} from "./helpers.ts";

const meta = (db: ReturnType<typeof memDb>) => db.query<any, []>("SELECT * FROM response_meta ORDER BY usage_id").all();
const outcomes = (db: ReturnType<typeof memDb>) => db.query<any, []>("SELECT id, model, kind FROM outcomes ORDER BY ts, id").all();

const toolResult = (uuid: string, ts: string, results: { id: string; error?: boolean; text?: string }[]) => ({
  type: "user",
  uuid,
  timestamp: ts,
  sessionId: CLAUDE_SESSION,
  cwd: "/work/alpha",
  message: { role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, is_error: r.error, content: r.text ?? "ok" })) },
});

describe("drift signals: Claude Code", () => {
  test("response time, effort, tool outcomes and interrupts", async () => {
    const root = tempDir();
    const a = (o: Parameters<typeof claudeAssistant>[0], extra: Record<string, unknown> = {}) => ({ ...claudeAssistant(o), ...extra });
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      a({ id: "msg_1", ts: "2026-09-01T10:00:03.000Z", content: [{ type: "thinking", thinking: "" }] }, { effort: "high" }),
      a({ id: "msg_1", ts: "2026-09-01T10:00:05.000Z", content: [{ type: "tool_use", id: "t_ok", name: "Read", input: {} }, { type: "tool_use", id: "t_err", name: "Bash", input: {} }, { type: "tool_use", id: "t_no", name: "Bash", input: {} }] }, { effort: "high" }),
      toolResult("r1", "2026-09-01T10:00:09.000Z", [
        { id: "t_ok" },
        { id: "t_err", error: true, text: "Exit code 1" },
        { id: "t_no", error: true, text: "The user doesn't want to proceed with this tool use." },
      ]),
      a({ id: "msg_2", ts: "2026-09-01T10:00:11.000Z", model: "claude-sonnet-5-5" }, { effort: "high" }),
      claudeUser("[Request interrupted by user]", { uuid: "u2", ts: "2026-09-01T10:00:12.000Z" }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);

    expect(meta(db)).toEqual([
      { usage_id: "claude:msg_1", start_ts: Date.parse("2026-09-01T10:00:00.000Z"), end_ts: Date.parse("2026-09-01T10:00:05.000Z"), ttft_ms: null, effort: "high", stop_reason: null },
      { usage_id: "claude:msg_2", start_ts: Date.parse("2026-09-01T10:00:09.000Z"), end_ts: Date.parse("2026-09-01T10:00:11.000Z"), ttft_ms: null, effort: "high", stop_reason: null },
    ]);
    expect(outcomes(db)).toEqual([
      { id: "claude:t_err", model: "claude-opus-5-5", kind: "tool_error" },
      { id: "claude:t_no", model: "claude-opus-5-5", kind: "tool_rejected" },
      { id: "claude:t_ok", model: "claude-opus-5-5", kind: "tool_ok" },
      { id: `claude:${CLAUDE_SESSION}:u2:interrupt`, model: "claude-sonnet-5-5", kind: "interrupt" },
    ]);
  });
});

describe("drift signals: Codex", () => {
  test("response time from the last input, effort, tool outcomes and interrupts", async () => {
    const root = tempDir();
    const ev = (ts: string, payload: Record<string, unknown>, type = "event_msg") => ({ timestamp: ts, type, payload });
    writeJsonl(join(root, "codex", "sessions", "2026", "09", "01", "rollout-e.jsonl"), [
      codexMeta("thread-e"),
      ev("2026-09-01T10:00:01.000Z", { model: "gpt-6", cwd: "/work/beta", effort: "xhigh" }, "turn_context"),
      codexUserMessage("go", "item-1", "2026-09-01T10:00:02.000Z"),
      codexRecord("resp-1", { input: 100, cached: 0, output: 50 }, "2026-09-01T10:00:06.000Z"),
      ev("2026-09-01T10:00:07.000Z", { type: "item_completed", item: { type: "CommandExecution", id: "exec-1", status: "completed" } }),
      ev("2026-09-01T10:00:07.500Z", { type: "item_completed", item: { type: "CommandExecution", id: "exec-2", status: "failed" } }),
      ev("2026-09-01T10:00:08.000Z", { type: "custom_tool_call_output", call_id: "c1", output: "x" }, "response_item"),
      codexRecord("resp-2", { input: 100, cached: 0, output: 50 }, "2026-09-01T10:00:10.000Z"),
      ev("2026-09-01T10:00:11.000Z", { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);

    expect(meta(db).map((m) => [m.usage_id, m.start_ts, m.end_ts, m.effort])).toEqual([
      ["codex:thread-e:resp-1", Date.parse("2026-09-01T10:00:02.000Z"), Date.parse("2026-09-01T10:00:06.000Z"), "xhigh"],
      ["codex:thread-e:resp-2", Date.parse("2026-09-01T10:00:08.000Z"), Date.parse("2026-09-01T10:00:10.000Z"), "xhigh"],
    ]);
    expect(outcomes(db)).toEqual([
      { id: "codex:thread-e:exec-1", model: "gpt-6", kind: "tool_ok" },
      { id: "codex:thread-e:exec-2", model: "gpt-6", kind: "tool_error" },
      { id: "codex:thread-e:turn-1:interrupt", model: "gpt-6", kind: "interrupt" },
    ]);
  });
});

describe("drift signals: omp", () => {
  test("exact timing, thinking level, tool results and aborts", async () => {
    const root = tempDir();
    const UUID = "01a0e876-219c-727f-a821-4f01fdcb0f55";
    const t0 = Date.parse("2026-09-28T14:43:17.000Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const reply = (id: string, start: number, extra: Record<string, unknown> = {}) => ({
      type: "message", id, timestamp: iso(start + 5000),
      message: { role: "assistant", content: [], provider: "openai-codex", model: "gpt-6-sol", usage: { input: 10, output: 400 }, timestamp: start, completedAt: start + 5000, duration: 5000, ttft: 1200, stopReason: "toolUse", ...extra },
    });
    const result = (id: string, callId: string, at: number, isError: boolean, text = "ok") => ({
      type: "message", id, timestamp: iso(at), message: { role: "toolResult", toolCallId: callId, toolName: "bash", isError, content: [{ type: "text", text }], timestamp: at },
    });
    writeJsonl(join(root, "omp", "sessions", "-work-alpha", `2026-09-28T14-40-51-100Z_${UUID}.jsonl`), [
      { type: "session", version: 3, id: UUID, timestamp: iso(t0 - 1000), cwd: "/work/alpha" },
      { type: "thinking_level_change", id: "k1", timestamp: iso(t0 - 500), thinkingLevel: "high" },
      { type: "message", id: "u1", timestamp: iso(t0), message: { role: "user", content: [{ type: "text", text: "go" }] } },
      reply("a1", t0 + 100),
      result("r1", "call_1", t0 + 5200, false),
      result("r2", "call_2", t0 + 5300, true, "Command exited with code 2"),
      result("r3", "call_3", t0 + 5400, true, "Skipped due to a queued background completion"),
      reply("a2", t0 + 6000, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);

    expect(meta(db)).toEqual([
      { usage_id: `omp:${UUID}:a1`, start_ts: t0 + 100, end_ts: t0 + 5100, ttft_ms: 1200, effort: "high", stop_reason: "toolUse" },
      { usage_id: `omp:${UUID}:a2`, start_ts: t0 + 6000, end_ts: t0 + 11000, ttft_ms: 1200, effort: "high", stop_reason: "aborted" },
    ]);
    expect(outcomes(db)).toEqual([
      { id: `omp:${UUID}:call_1`, model: "gpt-6-sol", kind: "tool_ok" },
      { id: `omp:${UUID}:call_2`, model: "gpt-6-sol", kind: "tool_error" },
      { id: `omp:${UUID}:call_3`, model: "gpt-6-sol", kind: "tool_rejected" },
      { id: `omp:${UUID}:a2:interrupt`, model: "gpt-6-sol", kind: "interrupt" },
    ]);
  });
});
