import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { apiErrorOf, classifyApiError, statusFromText } from "../src/core/apiErrors.ts";
import { friction } from "../src/core/friction.ts";
import { scan } from "../src/core/ingest/index.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { CLAUDE_SESSION, claudeAssistant, claudeUser, codexMeta, codexTurn, codexUserMessage, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

describe("API error classes", () => {
  const cases: [string | null, number | null, string, string][] = [
    [null, null, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "overloaded"],
    [null, null, 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', "rate_limit"],
    [null, null, 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', "server_error"],
    [null, null, "API Error: Request timed out.", "timeout"],
    [null, null, "API Error: Connection error.", "network"],
    [null, null, "getaddrinfo ETIMEOUT chatgpt.com", "network"],
    [null, null, "Codex websocket transport error: websocket closed (1006)", "network"],
    [null, null, "The socket connection was closed unexpectedly.", "network"],
    [null, null, 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}', "context_length"],
    [null, null, "Credit balance is too low", "billing"],
    [null, 429, "You exceeded your current quota, please check your plan and billing details.", "billing"],
    ["authentication_failed", null, "Login expired · Please run /login", "auth"],
    ["oauth_org_not_allowed", 403, "Your organization has disabled Claude subscription access for Claude Code", "auth"],
    [null, null, "Incorrect API key provided: sk-svcac****", "auth"],
    [null, null, "Codex error event: The usage limit has been reached (code=usage_limit_reached)", "rate_limit"],
    [null, null, "exceeded retry limit, last status: 429 Too Many Requests", "rate_limit"],
    [null, 503, "upstream connect error", "server_error"],
    [null, 504, "Gateway Timeout", "timeout"],
    ["model_not_found", 404, "There's an issue with the selected model.", "other"],
    [null, null, "Codex error event: This request was blocked by our safety systems.", "other"],
  ];
  for (const [code, status, text, cls] of cases) {
    test(`${cls}: ${text.slice(0, 60)}`, () => expect(apiErrorOf(code, status, text, 0).reason).toBe(cls as never));
  }

  test("the status is read from the message when the harness gives none", () => {
    expect(statusFromText("API Error: 529 {}")).toBe(529);
    expect(statusFromText("exceeded retry limit, last status: 429 Too Many Requests")).toBe(429);
    expect(statusFromText('{"statusCode": 502}')).toBe(502);
    expect(statusFromText("Request timed out")).toBeNull();
    expect(classifyApiError(null, 529, "")).toBe("overloaded");
  });

  test("the message is kept on one line with secrets replaced, and not at all when prompt text is not", () => {
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    expect(apiErrorOf(null, 401, `invalid x-api-key\n ${key}`, 2000)).toEqual({ kind: "api_error", reason: "auth", status: 401, detail: "invalid x-api-key [redacted]" });
    expect(apiErrorOf(null, null, "API Error: 529 Overloaded", 0)).toEqual({ kind: "api_error", reason: "overloaded", status: 529, detail: null });
  });
});

const apiErrors = (db: ReturnType<typeof memDb>) =>
  db.query<any, []>("SELECT provider, model, reason, status, detail FROM outcomes WHERE kind = 'api_error' ORDER BY ts").all();

describe("API errors from the logs", () => {
  test("Claude Code: an API error reply goes to the session's model, never counted as a tool failure", async () => {
    const root = tempDir();
    const apiError = (uuid: string, ts: string, text: string, extra: Record<string, unknown>) => ({
      ...claudeAssistant({ id: `syn-${uuid}`, ts, model: "<synthetic>", content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }),
      uuid,
      isApiErrorMessage: true,
      ...extra,
    });
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:05.000Z" }),
      apiError("e1", "2026-09-01T10:00:10.000Z", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {}),
      apiError("e2", "2026-09-01T10:00:20.000Z", "Login expired · Please run /login", { error: "authentication_failed" }),
      apiError("e3", "2026-09-01T10:00:30.000Z", "Your organization has disabled access", { error: "oauth_org_not_allowed", apiErrorStatus: 403 }),
      // Older versions log every attempt they retry.
      {
        type: "system", subtype: "api_error", uuid: "s1", timestamp: "2026-09-01T10:00:40.000Z", sessionId: CLAUDE_SESSION, cwd: "/work/alpha",
        error: { status: 429, error: { type: "error", error: { type: "rate_limit_error", message: "Rate limited" } } }, retryAttempt: 1,
      },
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(apiErrors(db)).toEqual([
      { provider: "claude", model: "claude-opus-5-5", reason: "overloaded", status: 529, detail: expect.stringContaining("API Error: 529") },
      { provider: "claude", model: "claude-opus-5-5", reason: "auth", status: null, detail: "Login expired · Please run /login" },
      { provider: "claude", model: "claude-opus-5-5", reason: "auth", status: 403, detail: "Your organization has disabled access" },
      { provider: "claude", model: "claude-opus-5-5", reason: "rate_limit", status: 429, detail: "Rate limited" },
    ]);

    const fr = friction(db, {}, "day");
    expect(fr.totals.errors).toBe(0);
    expect(fr.models.map((m) => m.key)).not.toContain("<synthetic>");
    expect(fr.apiErrors.total).toBe(4);
    expect(fr.apiErrors.classes.map((c) => [c.cls, c.count])).toEqual([["rate_limit", 1], ["overloaded", 1], ["auth", 2]]);
    expect(fr.apiErrors.models).toEqual([{ provider: "claude", model: "claude-opus-5-5", count: 4, lastTs: Date.parse("2026-09-01T10:00:40.000Z"), topClass: "auth" }]);
    expect(fr.apiErrors.recent[0]).toMatchObject({ reason: "rate_limit", status: 429, sessionId: `claude:${CLAUDE_SESSION}` });
    expect(fr.apiErrors.series.find((s) => s.key === "auth")?.data).toEqual([2]);

    const live = new Queries(db, () => new PriceBook()).live({}, 60, Date.parse("2026-09-01T10:05:00.000Z"));
    expect(live.feed.filter((e) => e.kind === "api_error").map((e) => [e.reason, e.status])).toEqual([["rate_limit", 429], ["auth", 403], ["auth", null], ["overloaded", 529]]);
    expect(live.sessions[0]).toMatchObject({ errors: 0, apiErrors: 4 });
  });

  test("Codex: error and stream_error events", async () => {
    const root = tempDir();
    const ev = (ts: string, ordinal: number, payload: Record<string, unknown>) => ({ timestamp: ts, ordinal, type: "event_msg", payload });
    writeJsonl(join(root, "codex", "sessions", "2026", "09", "01", "rollout-api.jsonl"), [
      codexMeta("thread-1"),
      codexTurn("gpt-6-sol"),
      codexUserMessage("Go", "m1"),
      ev("2026-09-01T10:00:05.000Z", 5, { type: "stream_error", message: "Reconnecting... 1/5", codex_error_info: { response_stream_disconnected: { http_status_code: 502 } } }),
      ev("2026-09-01T10:00:09.000Z", 6, { type: "error", message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(apiErrors(db)).toEqual([
      { provider: "codex", model: "gpt-6-sol", reason: "network", status: 502, detail: "Reconnecting... 1/5" },
      { provider: "codex", model: "gpt-6-sol", reason: "rate_limit", status: null, detail: "You've hit your usage limit." },
    ]);
  });

  test("omp: a response that stopped on an error", async () => {
    const root = tempDir();
    const UUID = "01a0e876-219c-727f-a821-4f01fdcb0f55";
    writeJsonl(join(root, "omp", "sessions", "-work-alpha", `2026-09-28T14-40-51-100Z_${UUID}.jsonl`), [
      { type: "session", version: 3, id: UUID, timestamp: "2026-09-28T14:40:51.100Z", cwd: "/work/alpha" },
      { type: "message", id: "u1", timestamp: "2026-09-28T14:43:17.000Z", message: { role: "user", content: [{ type: "text", text: "Go" }] } },
      {
        type: "message",
        id: "a1",
        timestamp: "2026-09-28T14:43:22.000Z",
        message: {
          role: "assistant", content: [], api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-sol",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "error",
          errorMessage: "Codex error event: The usage limit has been reached (code=usage_limit_reached)",
        },
      },
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(apiErrors(db)).toEqual([
      { provider: "omp", model: "gpt-6-sol", reason: "rate_limit", status: null, detail: "Codex error event: The usage limit has been reached (code=usage_limit_reached)" },
    ]);
  });
});
