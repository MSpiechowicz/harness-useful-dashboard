import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUDGETS } from "../src/core/budgets.ts";
import { parseSettings } from "../src/core/config.ts";
import { buildDigest, type DigestContext, digestFileName, digestRange, dueSlot, isoWeek, lastDigest, latestSlot, markSlot, rememberDigest, runDigest, writeDigestFile } from "../src/core/digest.ts";
import { openDb } from "../src/core/db.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { InputError, usageReport } from "../src/core/reports.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { tempDir } from "./helpers.ts";

const MIN = 60_000;
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
// Wednesday 2026-10-07 noon: last week is Monday 09-28 to Sunday 10-04, the week before it 09-21 to 09-27.
const NOW = at(2026, 10, 7);
const DIR = tempDir("hd-digest-");
const DB = join(DIR, "usage.db");

function fixture(): void {
  const db = openDb(DB);
  const usage = db.prepare(
    `INSERT INTO usage (id, provider, session_id, prompt_id, ts, project, user, host, model, input_tokens, output_tokens, total_tokens, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, 'alex', 'here', ?, 100, 50, ?, ?)`,
  );
  // Last week
  usage.run("a1", "claude", "claude:s1", "p1", at(2026, 9, 28, 10), "/work/app", "claude-opus-5-5", 1000, 6);
  usage.run("a2", "claude", "claude:s1", "p2", at(2026, 10, 4, 23), "/work/app", "claude-opus-5-5", 1000, 2);
  usage.run("a3", "codex", "codex:c1", "p3", at(2026, 10, 1, 9), "/work/api", "gpt-5-codex", 3000, 4);
  // The week before
  usage.run("b1", "claude", "claude:s0", "p0", at(2026, 9, 22, 10), "/work/app", "claude-opus-5-5", 2000, 6);
  // This week, and the boundary: Sunday midnight belongs to the next week
  usage.run("c1", "claude", "claude:s2", "p9", at(2026, 10, 5, 0), "/work/app", "claude-opus-5-5", 500, 50);
  usage.run("c2", "claude", "claude:s2", "p8", at(2026, 10, 6, 10), "/work/app", "claude-opus-5-5", 500, 50);
  const edit = db.prepare("INSERT INTO tool_calls (id, session_id, provider, ts, project, tool, lines_added, lines_removed) VALUES (?, 'claude:s1', 'claude', ?, '/work/app', 'Edit', ?, ?)");
  edit.run("t1", at(2026, 9, 29), 30, 10);
  edit.run("t2", at(2026, 9, 30), 40, 20);
  const outcome = db.prepare("INSERT INTO outcomes (id, provider, session_id, ts, project, model, kind, tool, reason) VALUES (?, 'claude', 'claude:s1', ?, '/work/app', 'claude-opus-5-5', ?, ?, ?)");
  outcome.run("o1", at(2026, 9, 29), "tool_error", "Edit", "edit_mismatch");
  outcome.run("o2", at(2026, 9, 29, 13), "tool_error", "Edit", "edit_mismatch");
  outcome.run("o3", at(2026, 9, 30), "tool_error", "Bash", "exit_code");
  outcome.run("o4", at(2026, 9, 30, 13), "tool_ok", "Read", null);
  outcome.run("o5", at(2026, 10, 1), "api_error", null, "rate_limit");
  db.prepare(
    `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, used_fraction, resets_at, observed_at)
     VALUES ('here', 'claude', 'five_hour', ?, 'claude', 'max', ?, ?, ?, ?)`,
  ).run(1, 300 * MIN, 0.4, at(2026, 9, 30, 15), at(2026, 9, 30, 12));
  db.prepare(
    `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, plan, window_ms, used_fraction, resets_at, observed_at)
     VALUES ('here', 'claude', 'five_hour', ?, 'claude', 'max', ?, ?, ?, ?)`,
  ).run(2, 300 * MIN, 0.92, at(2026, 9, 30, 15), at(2026, 9, 30, 14));
  db.close();
}
fixture();

function context(patch: Partial<DigestContext> = {}) {
  const db = openDb(DB, { readonly: true });
  const prices = PriceBook.fromDb(db);
  const c: DigestContext = {
    db, queries: new Queries(db, () => prices), prices, budgets: { ...DEFAULT_BUDGETS, monthly: 50 }, user: "alex", host: "here", now: NOW, lang: "en", hiddenTips: [], ...patch,
  };
  return { c, db };
}

describe("digest content", () => {
  test("the numbers are those of the reports for the same days", () => {
    const { c, db } = context();
    const d = buildDigest(c, "last");
    const week = usageReport(c, { by: "project", range: "custom", from: "2026-09-28", to: "2026-10-04" });
    const before = usageReport(c, { by: "project", range: "custom", from: "2026-09-21", to: "2026-09-27" });
    expect(d.from).toBe("2026-09-28");
    expect(d.to).toBe("2026-10-04");
    expect(d.totals).toEqual({ costUsd: 12, tokens: 5000, sessions: 2, prompts: 3 });
    expect(d.totals.costUsd).toBe(week.total.cost);
    expect(d.totals.tokens).toBe(week.total.tokens);
    expect(d.totals.sessions).toBe(week.total.sessions);
    expect(d.previous.costUsd).toBe(before.total.cost);
    expect(d.change.cost).toBe(1);
    expect(d.change.tokens).toBe(1.5);
    expect(d.top.projects.map((p) => [p.label, p.costUsd])).toEqual(week.rows.map((r) => [String(r.label), Math.round(Number(r.cost) * 1e4) / 1e4]));
    expect(d.top.models[0]!.key).toBe("claude-opus-5-5");
    expect(d.top.providers.map((p) => p.key)).toEqual(["claude", "codex"]);
    // 100 lines changed for 12 dollars of the week's spend
    expect(d.lines).toMatchObject({ changed: 100, added: 70, removed: 30, costPer100Usd: 12 });
    expect(d.failures).toEqual({ toolFailures: 3, toolCalls: 4, reasons: [{ reason: "edit_mismatch", count: 2 }, { reason: "exit_code", count: 1 }], apiErrors: 1 });
    expect(d.limits).toEqual([{ name: "Claude max 5h", peakPercent: 92, fullCycles: 0 }]);
    db.close();
  });

  test("the budget shows the month so far and the pace", () => {
    const { c, db } = context();
    const d = buildDigest(c, "last");
    // October so far: this week's 100 and last week's 6 + ... the month's spend counts from the 1st
    expect(d.budgets).toHaveLength(1);
    expect(d.budgets[0]).toMatchObject({ scope: "monthly", capUsd: 50 });
    expect(d.budgets[0]!.projectedUsd).toBeGreaterThan(d.budgets[0]!.spentUsd!);
    expect(d.markdown).toContain("Monthly budget");
    db.close();
  });

  test("the Markdown is compact and readable as plain text", () => {
    const { c, db } = context();
    const { markdown } = buildDigest(c, "last");
    expect(markdown).toContain("# Weekly digest: 2026-09-28 to 2026-10-04");
    expect(markdown).toContain("| Cost | $12.00 | $6.00 | +100% |");
    expect(markdown).toContain("- `claude`: $8.00 (67%)");
    expect(markdown).toContain("Claude max 5h: peak 92%");
    expect(markdown).toContain("Top causes: Edit didn't match the file (2), Command failed (1)");
    expect(markdown).toContain("API errors: 1");
    expect(markdown).not.toContain(";");
    expect(markdown.split("\n").length).toBeLessThan(60);
    db.close();
  });

  test("it is written in the UI language", () => {
    const { c, db } = context({ lang: "de" });
    const { markdown } = buildDigest(c, "last");
    expect(markdown).toContain("# Wochenrückblick: 2026-09-28 bis 2026-10-04");
    expect(markdown).toContain("| Kosten | $12.00 |");
    expect(markdown).toContain("Häufigste Ursachen");
    db.close();
  });

  test("names from the data can't read as Markdown", () => {
    const path = join(DIR, "odd.db");
    const w = openDb(path);
    w.prepare("INSERT INTO usage (id, provider, session_id, prompt_id, ts, project, user, host, model, total_tokens, cost_usd) VALUES ('x1', 'claude', 's', 'q', ?, ?, 'alex', 'here', 'm', 10, 1)").run(at(2026, 10, 2), "/work/x[1](evil)|`**");
    w.close();
    const db = openDb(path, { readonly: true });
    const prices = PriceBook.fromDb(db);
    const { markdown } = buildDigest({ db, queries: new Queries(db, () => prices), prices, budgets: DEFAULT_BUDGETS, user: "alex", host: "here", now: NOW, lang: "en", hiddenTips: [] }, "last");
    expect(markdown).toContain("- `x[1](evil) **`: $1.00 (100%)");
    db.close();
  });

  test("nothing used says so", () => {
    const { c, db } = context({ now: at(2026, 1, 14) });
    const d = buildDigest(c, "last");
    expect(d.markdown).toContain("No usage in this period.");
    db.close();
  });

  test("the command prints the Markdown, JSON or writes a file, and reads only", () => {
    const env = { dbPath: DB, budgets: DEFAULT_BUDGETS, hiddenTips: [], lang: "en" as const, user: "alex", host: "here", now: NOW };
    expect(runDigest({}, env).out).toContain("# Weekly digest: 2026-09-28 to 2026-10-04");
    const json = JSON.parse(runDigest({ json: true }, env).out);
    expect(json.totals.costUsd).toBe(12);
    expect(json.markdown).toBeUndefined();
    const thisWeek = runDigest({ week: "this" }, env).out;
    expect(thisWeek).toContain("Usage digest: 2026-10-01 to 2026-10-07");
    const file = join(DIR, "out.md");
    expect(runDigest({ out: file }, env).wrote).toBe(file);
    expect(readFileSync(file, "utf8")).toContain("Weekly digest");
    expect(() => runDigest({ week: "next" }, env)).toThrow(InputError);
    expect(() => runDigest({ json: true, out: file }, env)).toThrow(InputError);
    expect(() => runDigest({}, { ...env, dbPath: join(DIR, "missing.db") })).toThrow(InputError);
    expect(existsSync(join(DIR, "missing.db"))).toBe(false);
  });
});

describe("week boundaries", () => {
  test("last week is the previous Monday to Sunday, whatever day it is asked on", () => {
    for (const day of [5, 6, 7, 8, 9, 10, 11]) {
      // Monday 10-05 to Sunday 10-11: all of them ask for 09-28 to 10-05
      const r = digestRange(at(2026, 10, day, 15), "last");
      expect([r.from, r.to]).toEqual([at(2026, 9, 28, 0), at(2026, 10, 5, 0)]);
      expect([r.prevFrom, r.prevTo]).toEqual([at(2026, 9, 21, 0), at(2026, 9, 28, 0)]);
    }
  });

  test("the last 7 days run from the midnight 6 days back to now", () => {
    const r = digestRange(NOW, "this");
    expect([r.from, r.to, r.prevFrom, r.prevTo]).toEqual([at(2026, 10, 1, 0), NOW, at(2026, 9, 24, 0), at(2026, 10, 1, 0)]);
  });

  test("ISO weeks and file names, across the year's end", () => {
    expect(isoWeek(at(2026, 10, 4))).toEqual({ year: 2026, week: 40 });
    expect(isoWeek(at(2026, 1, 1))).toEqual({ year: 2026, week: 1 });
    expect(isoWeek(at(2027, 1, 1))).toEqual({ year: 2026, week: 53 });
    expect(isoWeek(at(2024, 12, 30))).toEqual({ year: 2025, week: 1 });
    expect(digestFileName(digestRange(NOW, "last"))).toBe("2026-W40.md");
    expect(digestFileName(digestRange(at(2027, 1, 6), "last"))).toBe("2026-W53.md");
  });

  // The time zone is read when the process starts, so each zone runs in a child process with TZ set.
  const child = (tz: string, script: string) => {
    const out = Bun.spawnSync(["bun", "-e", script], { env: { ...process.env, TZ: tz }, stdout: "pipe", stderr: "pipe" });
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    return JSON.parse(out.stdout.toString());
  };
  const SCRIPT = (now: string) => `
    import { digestRange, digestFileName, latestSlot } from ${JSON.stringify(join(import.meta.dir, "../src/core/digest.ts"))};
    const now = ${now};
    const r = digestRange(now, "last");
    const h = (t) => { const d = new Date(t); return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]; };
    const slot = latestSlot(now, 1, 9);
    console.log(JSON.stringify({ from: h(r.from), to: h(r.to), prevFrom: h(r.prevFrom), hours: (r.to - r.from) / 3600000, prevHours: (r.from - r.prevFrom) / 3600000, file: digestFileName(r), slot: h(slot) }));
  `;

  test("a week with the clocks going back is 7 calendar days, 169 hours long", () => {
    // Europe/Warsaw changes on Sunday 2026-10-25, America/New_York on Sunday 2026-11-01
    const warsaw = child("Europe/Warsaw", SCRIPT("new Date(2026, 9, 28, 12).getTime()"));
    expect(warsaw).toMatchObject({ from: [2026, 10, 19, 0, 0], to: [2026, 10, 26, 0, 0], prevFrom: [2026, 10, 12, 0, 0], hours: 169, prevHours: 168, file: "2026-W43.md", slot: [2026, 10, 26, 9, 0] });
    const ny = child("America/New_York", SCRIPT("new Date(2026, 10, 4, 12).getTime()"));
    expect(ny).toMatchObject({ from: [2026, 10, 26, 0, 0], to: [2026, 11, 2, 0, 0], hours: 169, file: "2026-W44.md" });
  });

  test("a week with the clocks going forward is 167 hours long, and Monday 9:00 stays 9:00", () => {
    // Europe/Warsaw changes on Sunday 2026-03-29
    const warsaw = child("Europe/Warsaw", SCRIPT("new Date(2026, 2, 31, 12).getTime()"));
    expect(warsaw).toMatchObject({ from: [2026, 3, 23, 0, 0], to: [2026, 3, 30, 0, 0], hours: 167, prevHours: 168, file: "2026-W13.md", slot: [2026, 3, 30, 9, 0] });
    const auckland = child("Pacific/Auckland", SCRIPT("new Date(2026, 8, 30, 12).getTime()"));
    expect(auckland).toMatchObject({ from: [2026, 9, 21, 0, 0], to: [2026, 9, 28, 0, 0], hours: 167 });
  });
});

describe("schedule", () => {
  const cfg = { enabled: true, day: 1, hour: 9, dir: "" };

  test("the latest slot is the last time the day and hour passed", () => {
    expect(latestSlot(at(2026, 10, 5, 9), 1, 9)).toBe(at(2026, 10, 5, 9));
    expect(latestSlot(at(2026, 10, 5, 8), 1, 9)).toBe(at(2026, 9, 28, 9));
    expect(latestSlot(NOW, 1, 9)).toBe(at(2026, 10, 5, 9));
    expect(latestSlot(NOW, 0, 23)).toBe(at(2026, 10, 4, 23));
    expect(latestSlot(NOW, 3, 12)).toBe(NOW);
  });

  test("a week is due once, and again the next week", () => {
    const db = openDb(":memory:");
    expect(dueSlot(db, "h", { ...cfg, enabled: false }, NOW)).toBeNull();
    const slot = dueSlot(db, "h", cfg, NOW)!;
    expect(slot).toBe(at(2026, 10, 5, 9));
    markSlot(db, "h", slot);
    expect(dueSlot(db, "h", cfg, NOW)).toBeNull();
    expect(dueSlot(db, "h", cfg, at(2026, 10, 11, 23))).toBeNull();
    expect(dueSlot(db, "h", cfg, at(2026, 10, 12, 9))).toBe(at(2026, 10, 12, 9));
    // another machine on a shared database has its own bookkeeping
    expect(dueSlot(db, "other", cfg, NOW)).toBe(slot);
  });

  test("an app that was off catches up the latest week only, never an older one", () => {
    const db = openDb(":memory:");
    markSlot(db, "h", at(2026, 9, 14, 9));
    // off for three weeks: one digest, for the latest slot
    expect(dueSlot(db, "h", cfg, NOW)).toBe(at(2026, 10, 5, 9));
    // never later than a week ago
    expect(NOW - dueSlot(db, "h", cfg, NOW)!).toBeLessThan(7 * 86_400_000);
  });
});

describe("files", () => {
  test.skipIf(process.platform === "win32")("the folder and file are private to this account", () => {
    const dir = join(tempDir(), "reports", "digests");
    const path = writeDigestFile(dir, { file: "2026-W40.md", markdown: "# hi\n" });
    expect(path).toBe(join(dir, "2026-W40.md"));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // a file that was there with looser rights is tightened
    writeFileSync(join(dir, "old.md"), "x", { mode: 0o644 });
    writeDigestFile(dir, { file: "old.md", markdown: "y" });
    expect(statSync(join(dir, "old.md")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "old.md"), "utf8")).toBe("y");
  });

  test("the last digest is read back, and a path that isn't one of ours isn't", () => {
    const db = openDb(":memory:");
    const dir = tempDir();
    expect(lastDigest(db, "h")).toBeNull();
    const path = writeDigestFile(dir, { file: "2026-W41.md", markdown: "# one\n" });
    rememberDigest(db, "h", path);
    expect(lastDigest(db, "h")).toMatchObject({ path, markdown: "# one\n" });
    writeFileSync(join(dir, "secret.txt"), "private");
    rememberDigest(db, "h", join(dir, "secret.txt"));
    expect(lastDigest(db, "h")).toBeNull();
  });
});

describe("settings input", () => {
  test("keeps a valid schedule and refuses the rest", () => {
    expect(parseSettings({ digest: { enabled: true, day: 5, hour: 18, dir: " /srv/digests " } })).toEqual({ patch: { digest: { enabled: true, day: 5, hour: 18, dir: "/srv/digests" } } });
    expect(parseSettings({ digest: { dir: "" } })).toEqual({ patch: { digest: { dir: "" } } });
    expect(parseSettings({ digest: { dir: "~/digests" } })).toHaveProperty("patch");
    for (const bad of [{ enabled: "yes" }, { day: 7 }, { day: -1 }, { day: 1.5 }, { hour: 24 }, { hour: "9" }, { dir: "relative/path" }, { dir: 3 }, { dir: "/x".repeat(3000) }, { dir: "/a\0b" }]) {
      expect(parseSettings({ digest: bad })).toHaveProperty("error");
    }
    expect(parseSettings({ digest: "on" })).toHaveProperty("error");
  });
});

describe("the app and its routes", () => {
  const token = "d".repeat(64);
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;
  let home: string;

  beforeAll(() => {
    const root = tempDir();
    home = join(root, "home");
    process.env.HARNESS_DASHBOARD_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false } } }));
    app = new App(join(root, "test.db"));
    handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token, port: 4317 });
  });
  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
  });

  const req = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) =>
    handle(new Request(`http://localhost:4317${path}`, { method, headers: { host: "localhost:4317", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const signed = { authorization: `Bearer ${token}` };
  const post = { ...signed, "x-harness-dashboard": "1" };

  test("the routes need the sign-in, and writing needs the custom header", async () => {
    expect((await req("/api/digest")).status).toBe(401);
    expect((await req("/api/digest", "POST", { "x-harness-dashboard": "1" })).status).toBe(401);
    expect((await req("/api/digest", "POST")).status).toBe(403);
    expect((await req("/api/digest", "POST", signed)).status).toBe(403);
    expect((await req("/api/digest", "POST", { ...post, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await req("/api/digest", "POST", { ...post, origin: "https://evil.example" })).status).toBe(403);
    expect((await req("/api/digest", "GET", signed)).status).toBe(200);
  });

  test("off by default, and the settings route validates the digest", async () => {
    expect(app.cfg.digest).toEqual({ enabled: false, day: 1, hour: 9, dir: "" });
    const bad = await req("/api/settings", "POST", post, { digest: { day: 9 } });
    expect(bad.status).toBe(400);
    expect(app.cfg.digest.day).toBe(1);
  });

  test("Write one now saves the file and returns the path and the Markdown", async () => {
    expect(((await (await req("/api/digest", "GET", signed)).json()) as { last: unknown }).last).toBeNull();
    const res = await req("/api/digest", "POST", post);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; markdown: string };
    expect(body.path).toStartWith(join(home, "digests"));
    expect(readFileSync(body.path, "utf8")).toBe(body.markdown);
    expect(body.markdown).toContain("Usage digest");
    if (process.platform !== "win32") {
      expect(statSync(join(home, "digests")).mode & 0o777).toBe(0o700);
      expect(statSync(body.path).mode & 0o777).toBe(0o600);
    }
    const last = ((await (await req("/api/digest", "GET", signed)).json()) as { last: unknown }).last;
    expect(last).toMatchObject({ path: body.path, markdown: body.markdown });
    expect((await req("/api/digest?week=last", "POST", post)).status).toBe(200);
  });

  test("a folder from the settings is used, created when it is missing", async () => {
    const dir = join(tempDir(), "mine");
    const saved = await req("/api/settings", "POST", post, { digest: { dir } });
    expect(saved.status).toBe(200);
    const body = (await (await req("/api/digest", "POST", post)).json()) as { path: string };
    expect(body.path).toStartWith(dir);
    expect(existsSync(body.path)).toBe(true);
    await req("/api/settings", "POST", post, { digest: { dir: "" } });
  });

  test("the weekly check writes once, notifies once, and catches up after a restart", async () => {
    const shown: string[][] = [];
    app.notifier = async (title, body) => (shown.push([title, body]), true);
    expect(app.checkDigest(NOW)).toBeNull();
    expect(shown).toHaveLength(0);

    // Turned on in mid-week: this week's slot has gone by, so nothing is written for it
    await req("/api/settings", "POST", post, { digest: { enabled: true } });
    const now = Date.now();
    expect(app.checkDigest(now)).toBeNull();

    // The next Monday 9:00 comes: a digest of the week that ended, and a notification
    const monday = latestSlot(now, 1, 9) + 7 * 86_400_000;
    const first = app.checkDigest(monday + 5 * MIN);
    expect(first).not.toBeNull();
    expect(first!.digest.week).toBe("last");
    expect(first!.path).toEndWith(first!.digest.file);
    expect(shown).toHaveLength(1);
    expect(shown[0]![0]).toBe("Your weekly digest is ready");
    expect(shown[0]![1]).toContain("tokens in");

    // Checked again, or in the days after: once a week
    expect(app.checkDigest(monday + 10 * MIN)).toBeNull();
    expect(app.checkDigest(monday + 3 * 86_400_000)).toBeNull();
    expect(shown).toHaveLength(1);

    // The app was off over the next Monday: it writes that week's digest when it starts, once
    const later = monday + 7 * 86_400_000 + 4 * 3_600_000;
    expect(app.checkDigest(later)).not.toBeNull();
    expect(app.checkDigest(later + 3_600_000)).toBeNull();
    expect(shown).toHaveLength(2);
  });

  test("the notification is in the UI language", async () => {
    const shown: string[] = [];
    app.notifier = async (title) => (shown.push(title), true);
    await req("/api/language", "POST", post, { language: "pl" });
    const next = latestSlot(Date.now(), 1, 9) + 28 * 86_400_000;
    app.checkDigest(next);
    expect(shown).toEqual(["Podsumowanie tygodnia jest gotowe"]);
  });
});
