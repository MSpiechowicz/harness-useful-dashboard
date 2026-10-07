import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { activePlans, chatgptWindows, claudeLimits, claudeWindows, codexLimits, copilotWindows, LimitsCache, loginLimits, ompReports, planFor } from "../src/core/limits.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { codexMeta, codexTokenCount, codexTurn, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;

describe("Claude limits", () => {
  test("reads the windows Anthropic reports, the 5-hour one first", () => {
    const windows = claudeWindows({
      seven_day_opus: { utilization: 40, resets_at: "2026-10-09T10:00:00Z" },
      five_hour: { utilization: 7, resets_at: "2026-10-05T15:00:00Z" },
      seven_day: { utilization: 10.5, resets_at: "2026-10-09T10:00:00Z" },
      seven_day_oauth_apps: { utilization: 3, resets_at: null },
      extra_usage: { is_enabled: false },
      seven_day_sonnet: null,
    });
    expect(windows.map((w) => [w.id, w.windowMs, w.scope, w.usedFraction])).toEqual([
      ["five_hour", 5 * HOUR, null, 0.07],
      ["seven_day", 168 * HOUR, null, 0.105],
      ["seven_day_opus", 168 * HOUR, "Opus", 0.4],
    ]);
    expect(windows[0]!.resetsAt).toBe(Date.parse("2026-10-05T15:00:00Z"));
  });

  const login = (expiresAt: number) => JSON.stringify({ claudeAiOauth: { accessToken: "secret-token", expiresAt, subscriptionType: "max" } });
  const deps = (file: string | null, fetchImpl: typeof fetch) => ({
    now: () => NOW,
    home: "/home/me",
    env: {},
    platform: "linux" as const,
    readFile: (p: string) => (p === join("/home/me", ".claude", ".credentials.json") ? file : null),
    fetch: fetchImpl,
  });

  test("asks with the Claude Code login and reports the plan", async () => {
    let auth = "";
    const report = await claudeLimits(
      deps(login(NOW + HOUR), (async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).Authorization!;
        return Response.json({ five_hour: { utilization: 20, resets_at: "2026-10-05T15:00:00Z" } });
      }) as unknown as typeof fetch),
    );
    expect(auth).toBe("Bearer secret-token");
    expect(report).toMatchObject({ provider: "claude", plan: "max", source: "claude", windows: [{ id: "five_hour", usedFraction: 0.2 }] });
  });

  test("no login is no report, an expired one is a problem and is never sent", async () => {
    let called = false;
    const spy = (async () => ((called = true), Response.json({}))) as unknown as typeof fetch;
    expect(await claudeLimits(deps(null, spy))).toBeNull();
    await expect(claudeLimits(deps(login(NOW - 1), spy))).rejects.toThrow("expired");
    expect(called).toBe(false);
  });

  test("a rejected login is reported without the provider's answer", async () => {
    const res = (async () => new Response("token secret-token is invalid", { status: 401 })) as unknown as typeof fetch;
    const err = await claudeLimits(deps(login(NOW + HOUR), res)).catch((e: Error) => e);
    expect((err as Error).message).toBe("unauthorized");
  });
});

describe("asking sparingly", () => {
  test("a reading is kept for 5 minutes, and a 429 backs off while the last reading stays", async () => {
    let now = NOW;
    let calls = 0;
    let status = 200;
    const cache = new LimitsCache({
      now: () => now,
      home: "/home/me",
      env: {},
      platform: "linux",
      readFile: (p: string) => (p === join("/home/me", ".claude", ".credentials.json") ? JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: NOW + 24 * HOUR } }) : null),
      fetch: (async () => {
        calls++;
        return status === 200 ? Response.json({ five_hour: { utilization: 20, resets_at: null } }) : new Response("", { status, headers: { "retry-after": "600" } });
      }) as unknown as typeof fetch,
    });
    const db = memDb();
    const on = { claude: true, omp: false, codex: false };
    await cache.get(db, ID.host, on);
    now += 90_000;
    await cache.get(db, ID.host, on);
    expect(calls).toBe(1);
    // Refresh asks again once the reading is a minute old.
    await cache.get(db, ID.host, on, true);
    expect(calls).toBe(2);

    status = 429;
    now += 6 * 60_000;
    const limited = await cache.get(db, ID.host, on);
    expect(calls).toBe(3);
    expect(limited.reports.map((r) => r.provider)).toEqual(["claude"]);
    expect(limited.problems).toEqual([{ source: "claude", code: "rate-limited", retryAt: now + 10 * 60_000 }]);
    // Not asked again during the wait, not even with Refresh.
    now += 5 * 60_000;
    await cache.get(db, ID.host, on, true);
    expect(calls).toBe(3);
    status = 200;
    now += 6 * 60_000;
    const back = await cache.get(db, ID.host, on);
    expect(calls).toBe(4);
    expect(back.problems).toEqual([]);
  });
});

describe("after a restart", () => {
  test("a first answer of 'too often' shows the last stored reading, not nothing", async () => {
    const db = memDb();
    const resets = NOW + 2 * HOUR;
    const make = (status: number) =>
      new LimitsCache({
        now: () => NOW,
        home: "/home/me",
        env: {},
        platform: "linux",
        readFile: (p: string) => (p === join("/home/me", ".claude", ".credentials.json") ? JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: NOW + 24 * HOUR } }) : null),
        fetch: (async () =>
          status === 200 ? Response.json({ five_hour: { utilization: 42, resets_at: new Date(resets).toISOString() } }) : new Response("", { status })) as unknown as typeof fetch,
      });
    const on = { claude: true, omp: false, codex: false };
    // The app before the restart took a reading, which went into the history.
    await make(200).get(db, ID.host, on);
    // A new process (empty memory) is told to wait.
    const after = await make(429).get(db, ID.host, on);
    expect(after.problems.map((p) => p.code)).toEqual(["rate-limited"]);
    expect(after.reports).toHaveLength(1);
    expect(after.reports[0]!.windows.map((w) => [w.id, w.usedFraction])).toEqual([["five_hour", 0.42]]);
    // Once that window has reset, its old use means nothing: no reading rather than a wrong one.
    const later = new LimitsCache({ now: () => resets + 60_000, home: "/home/me", env: {}, platform: "linux", readFile: () => JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: resets + 24 * HOUR } }), fetch: (async () => new Response("", { status: 429 })) as unknown as typeof fetch });
    expect((await later.get(db, ID.host, on)).reports).toEqual([]);
  });
});

describe("omp limits", () => {
  const usage = {
    reports: [
      {
        provider: "github-copilot",
        fetchedAt: NOW - 1000,
        metadata: { planType: "pro", email: "ma*", accountId: "a1" },
        limits: [
          { id: "premium", label: "Premium requests", window: { durationMs: 30 * 24 * HOUR, resetsAt: NOW + 5 * HOUR }, amount: { used: 120, limit: 300, unit: "requests" } },
          { id: "balance", label: "Credit", amount: { remaining: 4.2, unit: "usd" } },
        ],
      },
      { provider: "anthropic", metadata: { email: "ma*", accountId: "b1" }, limits: [{ id: "x", window: { durationMs: 5 * HOUR }, amount: { usedFraction: 0.5, unit: "percent" } }] },
      { provider: "anthropic", metadata: { email: "jo*", accountId: "b2" }, limits: [{ id: "x", window: { durationMs: 5 * HOUR }, amount: { usedFraction: 0.1, unit: "percent" } }] },
    ],
  };

  test("maps providers, counted limits and accounts, and skips balances", () => {
    const reports = ompReports(usage, NOW);
    expect(reports.map((r) => [r.provider, r.account])).toEqual([["copilot", null], ["claude", "ma*"], ["claude", "jo*"]]);
    expect(reports[0]!.windows).toEqual([
      { id: "premium", windowMs: 30 * 24 * HOUR, scope: null, label: "Premium requests", usedFraction: 0.4, resetsAt: NOW + 5 * HOUR, used: 120, limit: 300, unit: "requests" },
    ]);
  });

  test("a cache asks once a minute and keeps a failure apart from the others", async () => {
    let runs = 0;
    // On macOS the Claude login is also looked for in the keychain: only omp's runs count here.
    const cache = new LimitsCache({
      now: () => NOW,
      home: "/nowhere",
      platform: "linux",
      readFile: () => null,
      run: async (cmd) => (cmd.includes("usage") && runs++, JSON.stringify(usage)),
    });
    const db = memDb();
    const enabled = { claude: true, omp: true, codex: true };
    const first = await cache.get(db, ID.host, enabled);
    await cache.get(db, ID.host, enabled);
    expect(runs).toBe(1);
    expect(first.reports.length).toBe(3);
    expect(first.problems).toEqual([]);
    expect((await cache.get(db, ID.host, { ...enabled, omp: false })).reports).toEqual([]);
  });
});

describe("pi and OpenCode logins", () => {
  // A ChatGPT login token carries its account in its claims.
  const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const answers = (seen: { url: string; headers: Record<string, string> }[]) =>
    (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (url.includes("anthropic.com")) return Response.json({ five_hour: { utilization: 30, resets_at: "2026-10-05T15:00:00Z" } });
      if (url.includes("chatgpt.com"))
        return Response.json({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 600 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: (NOW + 86_400_000) / 1000 } } });
      if (url.includes("github.com")) return Response.json({ copilot_plan: "individual", quota_reset_date: "2026-11-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, unlimited: false } } });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

  test("each login is asked at its own provider, and an expired one isn't sent", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const auth = {
      anthropic: { type: "oauth", access: "sk-ant-expired", refresh: "r", expires: NOW - 1 },
      "openai-codex": { type: "oauth", access: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } }), refresh: "r", expires: NOW + HOUR },
      "github-copilot": { type: "oauth", access: "copilot-api-token", refresh: "ghu_github", expires: NOW + HOUR },
      openrouter: { type: "api_key", key: "sk-or" },
    };
    const deps = { now: () => NOW, home: "/home/me", env: {}, platform: "linux" as const, fetch: answers(seen), readFile: (p: string) => (p === join("/home/me", ".pi", "agent", "auth.json") ? JSON.stringify(auth) : null) };
    const { reports, problem } = await loginLimits("pi", deps);
    expect(problem).toBe("expired");
    expect(seen.some((s) => s.url.includes("anthropic"))).toBe(false);
    expect(seen.find((s) => s.url.includes("chatgpt"))!.headers["ChatGPT-Account-Id"]).toBe("acct_1");
    expect(seen.find((s) => s.url.includes("github"))!.headers.Authorization).toBe("token ghu_github");
    expect(reports.map((r) => [r.key, r.provider, r.plan, r.source])).toEqual([
      ["pi:codex", "codex", "plus", "pi"],
      ["pi:copilot", "copilot", "individual", "pi"],
    ]);
    expect(reports[0]!.windows.map((w) => [w.windowMs, w.usedFraction, w.resetsAt])).toEqual([
      [5 * HOUR, 0.4, NOW + 600_000],
      [168 * HOUR, 0.1, NOW + 86_400_000],
    ]);
    expect(reports[1]!.windows).toEqual([{ id: "premium", windowMs: null, scope: null, label: "Premium requests", usedFraction: 0.6, resetsAt: Date.parse("2026-11-01"), used: 180, limit: 300, unit: "requests" }]);
  });

  test("OpenCode's logins live in its data folder, its ChatGPT login is named openai", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const auth = { anthropic: { type: "oauth", access: "sk-ant", refresh: "r", expires: NOW + HOUR }, openai: { type: "oauth", access: "tok", refresh: "r", expires: NOW + HOUR, accountId: "acct_2" } };
    const deps = { now: () => NOW, home: "/home/me", env: { XDG_DATA_HOME: "/data" }, platform: "linux" as const, fetch: answers(seen), readFile: (p: string) => (p === join("/data", "opencode", "auth.json") ? JSON.stringify(auth) : null) };
    const { reports, problem } = await loginLimits("opencode", deps);
    expect(problem).toBeNull();
    expect(reports.map((r) => [r.provider, r.source])).toEqual([["claude", "opencode"], ["codex", "opencode"]]);
    expect(seen.find((s) => s.url.includes("chatgpt"))!.headers["ChatGPT-Account-Id"]).toBe("acct_2");
  });

  test("windows are read from ChatGPT's and Copilot's answers", () => {
    expect(chatgptWindows({}, NOW)).toEqual([]);
    expect(copilotWindows({ quota_snapshots: { premium_interactions: { unlimited: true } } })).toEqual([]);
  });
});

describe("plans in use", () => {
  test("each harness counts against its own plan, omp against what it billed through", () => {
    expect(planFor("claude", null)).toEqual({ provider: "claude", source: "claude" });
    expect(planFor("codex", null)).toEqual({ provider: "codex", source: "codex" });
    expect(planFor("omp", "github-copilot")).toEqual({ provider: "copilot", source: "omp" });
    expect(planFor("omp", "anthropic")).toEqual({ provider: "claude", source: "omp" });
    expect(planFor("pi", "anthropic")).toEqual({ provider: "claude", source: "pi" });
    expect(planFor("opencode", "openai")).toEqual({ provider: "codex", source: "opencode" });
    expect(planFor("opencode", "github-copilot")).toEqual({ provider: "copilot", source: "opencode" });
    expect(planFor("omp", null)).toBeNull();
    expect(planFor("cursor", null)).toBeNull();
  });

  test("only the plans in use are asked about and shown", async () => {
    const db = memDb();
    const w = new DbWriter(db, PriceBook.fromDb(db), ID);
    const call = (id: string, provider: "claude" | "omp", ts: number, billing: string | null = null) =>
      w.usage({ id, provider, sessionId: `${provider}:s`, promptId: null, ts, project: null, model: "m", skill: null, agent: "main", isSubagent: false,
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, billing });
    call("a", "omp", NOW - 10 * 60_000, "github-copilot");
    call("b", "claude", NOW - 3 * HOUR);
    const active = activePlans(db, NOW - HOUR);
    expect(active).toEqual([{ provider: "copilot", source: "omp" }]);

    let claudeAsked = false;
    const cache = new LimitsCache({
      now: () => NOW,
      home: "/nowhere",
      platform: "linux",
      readFile: () => ((claudeAsked = true), null),
      run: async () =>
        JSON.stringify({
          reports: [
            { provider: "github-copilot", limits: [{ id: "p", amount: { usedFraction: 0.2 } }] },
            { provider: "anthropic", limits: [{ id: "x", amount: { usedFraction: 0.5 } }] },
          ],
        }),
    });
    const result = await cache.get(db, ID.host, { claude: true, omp: true, codex: true }, false, active);
    expect(result.reports.map((r) => r.provider)).toEqual(["copilot"]);
    expect(claudeAsked).toBe(false);
  });
});

describe("Codex limits", () => {
  const rateLimits = (used: number, resetsAt: number, secondary: unknown = null) => ({
    limit_id: "codex",
    primary: { used_percent: used, window_minutes: 10080, resets_at: resetsAt / 1000 },
    secondary,
    plan_type: "prolite",
  });
  const withLimits = (entry: ReturnType<typeof codexTokenCount>, limits: unknown) => ({ ...entry, payload: { ...entry.payload, rate_limits: limits } });

  test("keeps the latest reading from the logs, and a window that has passed reads as reset", async () => {
    const root = tempDir();
    const file = join(root, "codex", "sessions", "2026", "10", "05", "rollout-a.jsonl");
    writeJsonl(file, [
      codexMeta("thread-a"),
      codexTurn("gpt-5"),
      withLimits(codexTokenCount(100, { input: 100, cached: 0, output: 0 }, 1, "2026-10-05T10:00:00.000Z"), rateLimits(30, NOW + 48 * HOUR, { used_percent: 5, window_minutes: 300, resets_at: (NOW + HOUR) / 1000 })),
      withLimits(codexTokenCount(200, { input: 100, cached: 0, output: 0 }, 2, "2026-10-05T11:00:00.000Z"), rateLimits(51, NOW + 48 * HOUR)),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const report = codexLimits(db, ID.host, NOW)!;
    // The 5-hour window was missing from the latest reading: it's gone.
    expect(report).toMatchObject({ provider: "codex", plan: "prolite", source: "codex", windows: [{ id: "primary", windowMs: 10080 * 60_000, usedFraction: 0.51 }] });
    expect(codexLimits(db, ID.host, NOW + 49 * HOUR)!.windows[0]).toMatchObject({ usedFraction: 0, resetsAt: null, reset: true });

    // Reading an older log again doesn't roll the reading back.
    new DbWriter(db, PriceBook.fromDb(db), ID).limit({ provider: "codex", windowId: "primary", windowMinutes: 10080, usedPercent: 10, resetsAt: null, plan: null, ts: Date.parse("2026-10-01T00:00:00Z") });
    expect(codexLimits(db, ID.host, NOW)!.windows[0]!.usedFraction).toBe(0.51);
  });
});

describe("live usage", () => {
  test("tokens per minute by provider, and active sessions with their subagents folded in", async () => {
    const root = tempDir();
    writeJsonl(join(root, "codex", "sessions", "2026", "10", "05", "rollout-b.jsonl"), [
      codexMeta("thread-b"),
      codexTurn("gpt-5"),
      codexTokenCount(1000, { input: 1000, cached: 0, output: 0 }, 1, "2026-10-05T11:58:10.000Z"),
      codexTokenCount(1500, { input: 400, cached: 0, output: 100 }, 2, "2026-10-05T11:59:30.000Z"),
      codexTokenCount(1600, { input: 100, cached: 0, output: 0 }, 3, "2026-10-05T10:00:00.000Z"),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const live = new Queries(db, () => PriceBook.fromDb(db)).live({}, 5, NOW);
    expect(live.from).toBe(NOW - 4 * 60_000);
    expect(live.series).toEqual([{ key: "codex", data: [0, 0, 1000, 500, 0] }]);
    expect(live.sessions.map((s) => [s.id, s.tokens])).toEqual([["codex:thread-b", 1600]]);
    expect(live.lastTs).toBe(Date.parse("2026-10-05T11:59:30.000Z"));
  });
});
