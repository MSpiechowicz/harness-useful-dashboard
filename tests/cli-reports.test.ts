import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUDGETS } from "../src/core/budgets.ts";
import { openDb } from "../src/core/db.ts";
import { formatCount, type ReportEnv, runReport, table } from "../src/core/reportCli.ts";
import { InputError } from "../src/core/reports.ts";
import { tempDir } from "./helpers.ts";

const MIN = 60_000;
const DAY = 86_400_000;
// Noon today: every fixture row of "today" falls on the same local day, whenever the tests run.
const NOW = new Date(new Date().setHours(12, 0, 0, 0)).getTime();
const DIR = tempDir("hd-reports-");
const DB = join(DIR, "usage.db");
const EMPTY = join(DIR, "empty.db");
const ODD = '/work/say "hi", ok';

/** Two projects today, one yesterday (one with a comma and quotes in its name), a user CSV would read as a formula, and a Claude 5-hour reading. */
function fixture(): void {
  const db = openDb(DB);
  const usage = db.prepare(
    `INSERT INTO usage (id, provider, session_id, prompt_id, ts, project, user, host, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'here', ?, 100, 50, 850, ?, ?)`,
  );
  usage.run("u1", "claude", "claude:s1", "p1", NOW - 30 * MIN, "/work/app", "alex", "claude-opus-5-5", 1000, 1.5);
  usage.run("u2", "claude", "claude:s1", "p2", NOW - 20 * MIN, "/work/app", "alex", "claude-opus-5-5", 1000, 0.5);
  usage.run("u3", "codex", "codex:c1", "p3", NOW - 10 * MIN, ODD, "@ops", "gpt-5-codex", 2000, 2);
  usage.run("u4", "codex", "codex:c0", "p4", NOW - DAY, "/work/app", "alex", "gpt-5-codex", 4000, 8);
  usage.run("u5", "claude", "claude:s0", "p5", NOW - 3 * DAY, "/work/app", "alex", "claude-opus-5-5", 1500, 1);
  db.prepare(
    `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, used_fraction, resets_at, observed_at)
     VALUES ('here', 'claude', 'five_hour', 1, 'claude', 'max', ?, 0.42, ?, ?)`,
  ).run(5 * 60 * MIN, NOW + 80 * MIN, NOW - 2 * MIN);
  db.close();
  openDb(EMPTY).close();
}
fixture();

const env = (patch: Partial<ReportEnv> = {}): ReportEnv => ({
  dbPath: DB, budgets: DEFAULT_BUDGETS, user: "alex", host: "here", now: NOW, env: {}, isTTY: false, ...patch,
});
const jsonOf = (cmd: "today" | "report" | "limits", flags: Record<string, string | boolean> = {}, patch: Partial<ReportEnv> = {}) =>
  JSON.parse(runReport(cmd, { ...flags, json: true }, env(patch)).out);

describe("today", () => {
  test("today against yesterday, top projects and models, the 5-hour limit", () => {
    const r = jsonOf("today");
    expect(Object.keys(r)).toEqual(["date", "today", "yesterday", "change", "topProjects", "topModels", "budgets", "claudeFiveHour"]);
    expect(r.today).toEqual({ costUsd: 4, tokens: 4000, sessions: 2, prompts: 3, modelCalls: 3 });
    expect(r.yesterday).toEqual({ costUsd: 8, tokens: 4000, sessions: 1, prompts: 1, modelCalls: 1 });
    expect(r.change).toEqual({ cost: -0.5, tokens: 0, sessions: 1, prompts: 2 });
    expect(r.topProjects.map((p: { label: string }) => p.label)).toEqual(["app", 'say "hi", ok']);
    expect(r.topModels[0]).toEqual({ key: "claude-opus-5-5", label: "claude-opus-5-5", costUsd: 2, share: 0.5, tokens: 2000 });
    expect(r.claudeFiveHour).toEqual({ usedPercent: 42, resetsAt: new Date(NOW + 80 * MIN).toISOString() });
    expect(r.budgets).toEqual([]);
  });

  test("the table, with budgets", () => {
    const { out, code } = runReport("today", {}, env({ budgets: { ...DEFAULT_BUDGETS, daily: 2.5 } }));
    expect(code).toBe(0);
    expect(out).toContain("Cost      $4.00      $8.00    -50%");
    // Budgets count this machine's user only: alex spent $2 of the $4.
    expect(out).toMatch(/Daily\s+\$2\.00 of \$2\.50\s+80%/);
    expect(out).toMatch(/Claude 5h limit\s+42%\s+resets in 1h20m/);
    expect(out).not.toContain(";");
  });

  test("filters narrow it down", () => {
    expect(jsonOf("today", { provider: "codex" }).today.costUsd).toBe(2);
    expect(jsonOf("today", { project: "app" }).filters).toEqual({ project: "/work/app" });
  });
});

describe("report", () => {
  test("a breakdown keeps the dashboard's field names, every row and the totals", () => {
    const r = jsonOf("report", { by: "project", range: "7d" });
    expect(Object.keys(r)).toEqual(["by", "range", "total", "rows"]);
    expect(r.range.name).toBe("7d");
    expect(r.total).toEqual({ cost: 13, tokens: 9500, messages: 5, sessions: 4, prompts: 5 });
    expect(Object.keys(r.rows[0])).toEqual([
      "key", "label", "cost", "share", "tokens", "tokenShare", "input", "output", "cacheRead", "cacheWrite", "reasoning",
      "messages", "sessions", "prompts", "cacheHitRate", "estimated", "firstTs", "lastTs",
    ]);
    expect(r.rows[0]).toMatchObject({ key: "/work/app", label: "app", cost: 11, estimated: false, lastTs: new Date(NOW - 20 * MIN).toISOString() });
  });

  test("by day: a row per day, idle days as zeros", () => {
    const from = new Date(NOW - 3 * DAY);
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const r = jsonOf("report", { by: "day", from: day(from), to: day(new Date(NOW)) });
    expect(r.range.name).toBe("custom");
    expect(r.rows.map((x: { cost: number }) => x.cost)).toEqual([1, 0, 8, 4]);
    expect(r.rows[1]).toMatchObject({ period: day(new Date(NOW - 2 * DAY)), sessions: 0, firstTs: null });
  });

  test("CSV: RFC 4180 quoting, formulas defused, the same columns with no rows", () => {
    const csv = runReport("report", { by: "user", range: "today", csv: true }, env()).out;
    const lines = csv.split("\r\n");
    expect(lines[0]).toStartWith("key,label,cost,share,");
    expect(lines.some((l) => l.startsWith("'@ops,'@ops,2,"))).toBe(true);
    const projects = runReport("report", { by: "project", range: "today", csv: true }, env()).out;
    expect(projects).toContain('"/work/say ""hi"", ok","say ""hi"", ok",2,');
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    const empty = runReport("report", { by: "model", csv: true }, env({ dbPath: EMPTY })).out;
    expect(empty).toBe(lines[0] + "\r\n");
  });

  test("the table shortens to --limit and shows the total", () => {
    const out = runReport("report", { by: "project", range: "7d", limit: "1" }, env()).out;
    expect(out).toContain("Usage by project, last 7 days");
    expect(out).toMatch(/app\s+\$11\.00\s+85%/);
    expect(out).toMatch(/Total\s+\$13\.00\s+9\.5k\s+4\s+5/);
    expect(out).toContain("1 more rows");
  });

  test("bad options are an InputError", () => {
    expect(() => runReport("report", { by: "branch" }, env())).toThrow(InputError);
    expect(() => runReport("report", { range: "week" }, env())).toThrow("--range must be one of");
    expect(() => runReport("report", { range: "7d", from: "2026-01-01" }, env())).toThrow("not both");
    expect(() => runReport("report", { from: "yesterday" }, env())).toThrow("from must be a date");
    expect(() => runReport("report", { json: true, csv: true }, env())).toThrow("not both");
    expect(() => runReport("limits", { csv: true }, env())).toThrow("report only");
    expect(() => runReport("report", { project: "nope" }, env())).toThrow("No project named nope");
  });
});

describe("limits", () => {
  const check = (flags: Record<string, string | boolean>, patch: Partial<ReportEnv> = {}) => runReport("limits", { check: true, ...flags }, env(patch)).code;

  test("the latest readings and budgets, and the check", () => {
    const r = jsonOf("limits", {}, { budgets: { ...DEFAULT_BUDGETS, monthly: 100 } });
    expect(Object.keys(r)).toEqual(["windows", "budgets", "check"]);
    expect(r.windows).toEqual([
      { provider: "claude", plan: "max", window: "5h", usedPercent: 42, resetsAt: new Date(NOW + 80 * MIN).toISOString(), observedAt: new Date(NOW - 2 * MIN).toISOString(), ageMinutes: 2, status: "fresh" },
    ]);
    expect(r.budgets[0]).toMatchObject({ scope: "monthly", capUsd: 100, status: "ok" });
    expect(r.check).toEqual({ warnPercent: 80, status: "ok", exitCode: 0 });
  });

  test("exit codes: 0 below the warning, 10 at it, 11 at 100%, 2 with no fresh reading", () => {
    expect(check({})).toBe(0);
    expect(check({ warn: "40" })).toBe(10);
    expect(check({}, { budgets: { ...DEFAULT_BUDGETS, daily: 2.5 } })).toBe(10); // alex's $2 of $2.50
    expect(check({}, { budgets: { ...DEFAULT_BUDGETS, daily: 2 } })).toBe(11);
    // Two hours on, the window has reset since the reading: nothing fresh to go by.
    expect(check({}, { now: NOW + 2 * 60 * MIN })).toBe(2);
    expect(check({}, { dbPath: EMPTY })).toBe(2);
    // A cap used up still says more than a missing reading.
    expect(check({}, { now: NOW + 2 * 60 * MIN, budgets: { ...DEFAULT_BUDGETS, daily: 2 } })).toBe(11);
    expect(runReport("limits", {}, env({ budgets: { ...DEFAULT_BUDGETS, daily: 2 } })).code).toBe(0); // without --check
    expect(() => check({ warn: "lots" })).toThrow("--warn");
  });

  test("the table", () => {
    const out = runReport("limits", { check: true }, env()).out;
    expect(out).toMatch(/claude max\s+5h\s+42%\s+resets in 1h20m\s+read 2m ago/);
    expect(out).toContain("None set.");
    expect(out).toMatch(/Check\s+all below 80%\s+exit 0/);
  });
});

describe("output", () => {
  test("colors only on a terminal, and never with NO_COLOR or --no-color", () => {
    const esc = "\x1b[";
    expect(runReport("today", {}, env({ isTTY: true })).out).toContain(esc);
    expect(runReport("today", {}, env({ isTTY: false })).out).not.toContain(esc);
    expect(runReport("today", {}, env({ isTTY: true, env: { NO_COLOR: "1" } })).out).not.toContain(esc);
    expect(runReport("today", { "no-color": true }, env({ isTTY: true })).out).not.toContain(esc);
    expect(runReport("today", { json: true }, env({ isTTY: true })).out).not.toContain(esc);
  });

  test("an empty database gives zeros, not errors", () => {
    const r = jsonOf("today", {}, { dbPath: EMPTY });
    expect(r.today).toEqual({ costUsd: 0, tokens: 0, sessions: 0, prompts: 0, modelCalls: 0 });
    expect(r.claudeFiveHour).toBeNull();
    expect(jsonOf("report", { by: "week" }, { dbPath: EMPTY }).rows).toEqual([]);
    expect(runReport("report", {}, env({ dbPath: EMPTY })).out).toContain("No usage in this range.");
    expect(runReport("today", {}, env({ dbPath: EMPTY })).out).toContain("No usage today or yesterday yet.");
  });

  test("compact numbers and aligned columns", () => {
    expect([950, 1000, 12_400, 999_999, 3_100_000, 1.2e9].map(formatCount)).toEqual(["950", "1k", "12.4k", "1000k", "3.1M", "1.2B"]);
    expect(table([["a", "1"], ["long", "100"]], ["l", "r"])).toEqual(["a       1", "long  100"]);
  });
});

describe("the commands", () => {
  const cli = (args: string[], home: string) =>
    Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { env: { ...process.env, HARNESS_DASHBOARD_HOME: home, NO_COLOR: "" } });

  test("a missing database: a clear message, exit code 2, nothing created", () => {
    const home = join(DIR, "no-home");
    const db = join(DIR, "nowhere", "usage.db");
    for (const cmd of ["today", "report", "limits"]) {
      const r = cli([cmd, "--db", db], home);
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain(`No usage database at ${db}`);
      expect(r.stdout.toString()).toBe("");
    }
    expect(existsSync(join(DIR, "nowhere"))).toBe(false);
    expect(existsSync(home)).toBe(false);
  });

  test("JSON on stdout and the check's exit code", () => {
    const home = join(DIR, "no-home");
    const r = cli(["report", "--db", DB, "--range", "all", "--by", "provider", "--json"], home);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString()).rows.map((x: { key: string }) => x.key)).toEqual(["codex", "claude"]);
    // The commands go by the clock: a reading taken a minute ago, 90% used.
    const live = join(DIR, "live.db");
    const db = openDb(live);
    db.prepare(
      `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, used_fraction, resets_at, observed_at)
       VALUES ('here', 'claude', 'five_hour', 1, 'claude', 'max', ?, 0.9, ?, ?)`,
    ).run(5 * 60 * MIN, Date.now() + 60 * MIN, Date.now() - MIN);
    db.close();
    expect(cli(["limits", "--check", "--db", live], home).exitCode).toBe(10);
    expect(cli(["limits", "--check", "--warn", "95", "--db", live], home).exitCode).toBe(0);
    expect(cli(["limits", "--check", "--db", EMPTY], home).exitCode).toBe(2);
    expect(cli(["report", "--by", "branch", "--db", DB], home).exitCode).toBe(2);
    expect(existsSync(home)).toBe(false);
  });
});
