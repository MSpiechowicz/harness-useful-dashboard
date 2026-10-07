import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSettings } from "../src/core/config.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { claudeAssistant, claudeUser, CLAUDE_SESSION, tempDir, writeJsonl } from "./helpers.ts";

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** A small reader for the text format: checks every line is a comment or a well-formed sample, and unescapes labels. */
function parse(text: string) {
  const help = new Map<string, string>();
  const type = new Map<string, string>();
  const samples: Sample[] = [];
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.trimEnd().split("\n")) {
    const h = /^# HELP (\w+) (.+)$/.exec(line);
    const t = /^# TYPE (\w+) (counter|gauge)$/.exec(line);
    if (h) help.set(h[1]!, h[2]!);
    else if (t) type.set(t[1]!, t[2]!);
    else {
      const m = /^(\w+)(?:\{((?:\w+="(?:[^"\\]|\\.)*",?)*)\})? (-?[\d.e+-]+)$/.exec(line);
      expect(m, line).not.toBeNull();
      const labels: Record<string, string> = {};
      for (const l of (m![2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
      samples.push({ name: m![1]!, labels, value: Number(m![3]) });
    }
  }
  return { help, type, samples };
}

const sum = (samples: Sample[], name: string, where: Partial<Record<string, string>> = {}) =>
  samples.filter((s) => s.name === name && Object.entries(where).every(([k, v]) => s.labels[k] === v)).reduce((a, s) => a + s.value, 0);

describe("GET /metrics", () => {
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const env = ["HARNESS_DASHBOARD_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"] as const;
  const prev = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  const APP_TOKEN = "a".repeat(64);

  beforeAll(async () => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "omp");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ sources: { piDirs: [join(root, "pi")], opencodeDirs: [join(root, "opencode")] } }));
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("hello", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" }),
      claudeUser("again", { uuid: "u2", ts: "2026-09-01T10:05:00.000Z" }),
      claudeAssistant({ id: "m2", ts: "2026-09-01T10:05:01.000Z" }),
    ]);
    app = new App(join(root, "test.db"));
    await app.scanNow();
    // What a scan of these logs doesn't give: a user name that needs escaping, outcomes, edits, a limit reading, a tag.
    const db = app.db;
    db.query("INSERT INTO usage (id, provider, session_id, ts, project, user, model, input_tokens, output_tokens, reasoning_tokens, total_tokens, cost_usd) VALUES ('x1', 'codex', 'codex:s', ?, '/work/we ird\"dir', 'a\"b\\c\nd', 'openai/gpt-5.6', 10, 30, 5, 40, 0.5)").run(Date.now());
    const outcome = db.prepare("INSERT INTO outcomes (id, provider, session_id, ts, project, model, kind, tool, reason) VALUES (?, 'claude', 'claude:s1', ?, '/work/alpha', 'claude-opus-5-5', ?, ?, ?)");
    outcome.run("o1", 1, "tool_ok", "Bash", null);
    outcome.run("o2", 2, "tool_error", "Bash", "exit_code");
    outcome.run("o3", 3, "tool_rejected", "Edit", null);
    outcome.run("o4", 4, "api_error", null, "rate_limit");
    db.query("INSERT INTO tool_calls (id, session_id, provider, ts, project, tool, model, lines_added, lines_removed) VALUES ('t1', 'claude:s1', 'claude', 1, '/work/alpha', 'Edit', 'claude-opus-5-5', 7, 2)").run();
    const now = Date.now();
    db.query(
      "INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, scope, label, used_fraction, resets_at, observed_at) VALUES (?, 'claude:main', '5h', 1, 'claude', 'max', 18000000, NULL, NULL, 0.42, ?, ?)",
    ).run(app.identity.host, now + 3_600_000, now);
    db.query("INSERT INTO session_tags (session_id, tag) VALUES (?, 'client-a')").run(`claude:${CLAUDE_SESSION}`);
    handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token: APP_TOKEN, port: 4317 });
  });

  afterAll(() => {
    app.close();
    for (const k of env) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  const get = (headers: Record<string, string> = {}, path = "/metrics") => handle(new Request(`http://localhost:4317${path}`, { headers: { host: "localhost:4317", ...headers } }));
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const settings = (body: unknown) =>
    handle(new Request("http://localhost:4317/api/settings", { method: "POST", headers: { host: "localhost:4317", "x-harness-dashboard": "1", authorization: `Bearer ${APP_TOKEN}` }, body: JSON.stringify(body) }));
  const token = () => app.cfg.metrics.token;

  test("is off by default: there is no such route", async () => {
    expect(app.cfg.metrics).toEqual({ enabled: false, token: "", projectLabels: true });
    expect((await get()).status).toBe(404);
    expect((await get(bearer(APP_TOKEN))).status).toBe(404);
  });

  test("turning it on makes a token, which only the server can set", async () => {
    const r = await settings({ metrics: { enabled: true, token: "mine", projectLabels: true } });
    expect(r.status).toBe(200);
    const first = token();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // The same change again keeps it, a request for a new one makes one.
    await settings({ metrics: { enabled: true } });
    expect(token()).toBe(first);
    await settings({ metrics: { regenerateToken: true } });
    expect(token()).toMatch(/^[0-9a-f]{64}$/);
    expect(token()).not.toBe(first);
    expect((await get(bearer(first))).status).toBe(401);
    expect((await get(bearer(token()))).status).toBe(200);
  });

  test("refuses a missing, wrong or the app's own token, and the sign-in cookie", async () => {
    for (const headers of [{} as Record<string, string>, bearer("wrong"), bearer(token().slice(0, 63)), bearer(APP_TOKEN), { authorization: token() }, { cookie: `hd_auth_4317=${APP_TOKEN}` }]) {
      const res = await get(headers);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(await res.text()).not.toContain("harness_");
    }
    // And the metrics token opens nothing of the API.
    expect((await get(bearer(token()), "/api/summary")).status).toBe(401);
  });

  test("answers other methods with 405 and cross-site or rebinding requests with 403", async () => {
    const post = (headers: Record<string, string>) => handle(new Request("http://localhost:4317/metrics", { method: "POST", headers: { host: "localhost:4317", ...bearer(token()), ...headers } }));
    expect((await post({ "x-harness-dashboard": "1" })).status).toBe(405);
    expect((await post({})).status).toBe(403);
    expect((await get({ ...bearer(token()), "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await get({ ...bearer(token()), origin: "https://evil.example" })).status).toBe(403);
    expect((await get({ ...bearer(token()), host: "evil.example" })).status).toBe(403);
    expect((await get({ ...bearer(token()), "sec-fetch-site": "same-origin" })).status).toBe(200);
  });

  test("serves the text format with a help and a type per metric", async () => {
    const res = await get(bearer(token()));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const { help, type, samples } = parse(await res.text());
    for (const name of new Set(samples.map((s) => s.name))) {
      expect(help.has(name), name).toBe(true);
      expect(type.has(name), name).toBe(true);
    }
    for (const [name, kind] of type) {
      expect(name.startsWith("harness_")).toBe(true);
      if (kind === "counter") expect(name.endsWith("_total")).toBe(true);
    }
    expect(type.get("harness_cost_usd_total")).toBe("counter");
    expect(type.get("harness_live_sessions")).toBe("gauge");
    expect(help.get("harness_cost_usd_total")).toContain("rate()");
    expect(samples.find((s) => s.name === "harness_build_info")!.value).toBe(1);
  });

  test("the counters match the dashboard's totals", async () => {
    const { samples } = parse(await (await get(bearer(token()))).text());
    const t = app.queries.summary({});
    expect(sum(samples, "harness_cost_usd_total")).toBeCloseTo(t.cost, 9);
    expect(sum(samples, "harness_requests_total")).toBe(t.messages);
    expect(sum(samples, "harness_sessions_total")).toBe(t.sessions);
    expect(sum(samples, "harness_prompts_total")).toBe(t.prompts);
    expect(sum(samples, "harness_tokens_total", { type: "input" })).toBe(t.input);
    expect(sum(samples, "harness_tokens_total", { type: "cache_read" })).toBe(t.cacheRead);
    expect(sum(samples, "harness_tokens_total", { type: "cache_write" })).toBe(t.cacheWrite);
    expect(sum(samples, "harness_tokens_total", { type: "reasoning" })).toBe(t.reasoning);
    // The dashboard's output includes reasoning, the metric's types don't overlap.
    expect(sum(samples, "harness_tokens_total", { type: "output" }) + t.reasoning).toBe(t.output);
    expect(t.messages).toBeGreaterThan(2);
    const codex = { provider: "codex", model: "gpt-5.6" };
    expect(sum(samples, "harness_tokens_total", { ...codex, type: "output" })).toBe(25);
    expect(sum(samples, "harness_tokens_total", { ...codex, type: "reasoning" })).toBe(5);
  });

  test("labels use folder names, models normalized, and escape quotes, backslashes and newlines", async () => {
    const text = await (await get(bearer(token()))).text();
    expect(text).toContain('project="alpha"');
    expect(text).toContain('project="we ird\\"dir"');
    expect(text).toContain('user="a\\"b\\\\c\\nd"');
    expect(text).not.toContain("/work/");
    expect(text).not.toContain("openai/gpt");
    const { samples } = parse(text);
    expect(samples.find((s) => s.labels.user?.includes("\n"))!.labels.user).toBe('a"b\\c\nd');
  });

  test("tool calls, failures, API errors, lines, tags, plan limits and live sessions", async () => {
    const { samples } = parse(await (await get(bearer(token()))).text());
    const one = (name: string, where: Record<string, string>) => samples.find((s) => s.name === name && Object.entries(where).every(([k, v]) => s.labels[k] === v))?.value;
    expect(one("harness_tool_calls_total", { provider: "claude", tool: "Bash", outcome: "ok" })).toBe(1);
    expect(one("harness_tool_calls_total", { provider: "claude", tool: "Bash", outcome: "error" })).toBe(1);
    expect(one("harness_tool_calls_total", { provider: "claude", tool: "Edit", outcome: "declined" })).toBe(1);
    expect(one("harness_tool_failures_total", { tool: "Bash", reason: "exit_code" })).toBe(1);
    expect(one("harness_tool_failures_total", { tool: "Edit", reason: "rejected" })).toBe(1);
    expect(one("harness_api_errors_total", { provider: "claude", model: "claude-opus-5-5", class: "rate_limit" })).toBe(1);
    expect(one("harness_lines_added_total", { provider: "claude", model: "claude-opus-5-5", project: "alpha" })).toBe(7);
    expect(one("harness_lines_removed_total", { project: "alpha" })).toBe(2);
    expect(one("harness_tag_cost_usd_total", { tag: "client-a" })).toBeGreaterThan(0);
    expect(one("harness_plan_limit_used_ratio", { provider: "claude", plan: "max", window: "5h" })).toBeCloseTo(0.42);
    expect(one("harness_plan_limit_resets_at_seconds", { provider: "claude", window: "5h" })).toBeGreaterThan(Date.now() / 1000);
    for (const status of ["working", "idle", "error"]) expect(one("harness_live_sessions", { status })).toBeDefined();
    expect(one("harness_last_scan_timestamp_seconds", {})).toBeGreaterThan(0);
  });

  test("budget gauges appear for the caps that are set", async () => {
    expect(parse(await (await get(bearer(token()))).text()).samples.some((s) => s.name === "harness_budget_cap_usd")).toBe(false);
    app.updateConfig({ budgets: { daily: 10, monthly: 100, projects: { "/work/alpha": 5 } } });
    const { samples } = parse(await (await get(bearer(token()))).text());
    expect(samples.filter((s) => s.name === "harness_budget_cap_usd").map((s) => [s.labels.scope, s.labels.project, s.value])).toEqual<(string | number | undefined)[][]>([
      ["daily", undefined, 10],
      ["monthly", undefined, 100],
      ["project", "alpha", 5],
    ]);
    expect(samples.filter((s) => s.name === "harness_budget_spent_usd")).toHaveLength(3);
  });

  test("a new row shows in the next scrape, and with project labels off projects add up", async () => {
    const before = sum(parse(await (await get(bearer(token()))).text()).samples, "harness_requests_total");
    app.db.query("INSERT INTO usage (id, provider, session_id, ts, project, user, model, total_tokens, cost_usd) VALUES ('x2', 'claude', 'claude:z', ?, '/work/beta', 'tester', 'claude-opus-5-5', 1, 0.1)").run(Date.now());
    await settings({ metrics: { projectLabels: false } });
    const text = await (await get(bearer(token()))).text();
    const { samples } = parse(text);
    expect(sum(samples, "harness_requests_total")).toBe(before + 1);
    expect(text).not.toContain("project=");
    expect(samples.filter((s) => s.name === "harness_budget_cap_usd")).toHaveLength(2);
    await settings({ metrics: { projectLabels: true } });
    expect(await (await get(bearer(token()))).text()).toContain('project="beta"');
  });

  test("turning it off removes the route again, and the token is kept for next time", async () => {
    const kept = token();
    await settings({ metrics: { enabled: false } });
    expect((await get(bearer(kept))).status).toBe(404);
    await settings({ metrics: { enabled: true } });
    expect(token()).toBe(kept);
    expect((await get(bearer(kept))).status).toBe(200);
  });

  test("settings input: only booleans, and a token sent by a client is dropped", () => {
    expect(parseSettings({ metrics: { enabled: true, projectLabels: false, regenerateToken: true, token: "x" } })).toEqual({ patch: { metrics: { enabled: true, projectLabels: false, regenerateToken: true } } });
    expect(parseSettings({ metrics: { enabled: "yes" } })).toEqual({ error: "invalid value for metrics.enabled" });
    expect(parseSettings({ metrics: [] })).toEqual({ error: "invalid value for metrics" });
  });
});
