import { describe, expect, test } from "bun:test";
import { budgetAlerts, budgetStatus, DEFAULT_BUDGETS, limitAlerts, takeNew } from "../src/core/budgets.ts";
import { parseSettings } from "../src/core/config.ts";
import type { LimitReport } from "../src/core/limits.ts";
import { notifyCommand } from "../src/server/notify.ts";
import { memDb } from "./helpers.ts";

const NOW = new Date(2026, 9, 15, 12, 0); // Oct 15, local noon
const at = (d: number, h = 10) => new Date(2026, 9, d, h).getTime();

function db() {
  const db = memDb();
  const ins = db.prepare("INSERT INTO usage (id, provider, session_id, ts, user, project, cost_usd) VALUES (?, 'claude', 's', ?, ?, ?, ?)");
  ins.run("a", at(15), "ada", "/work/alpha", 12);
  ins.run("b", at(15), "ada", "/work/beta", 6);
  ins.run("c", at(3), "ada", "/work/alpha", 100);
  ins.run("d", at(15), "bob", "/work/alpha", 50); // someone else on a shared database
  ins.run("e", new Date(2026, 8, 30, 10).getTime(), "ada", "/work/alpha", 999); // last month
  return db;
}

describe("budget status", () => {
  test("today, this month and per project, for this user only, in local time", () => {
    const items = budgetStatus(db(), { ...DEFAULT_BUDGETS, daily: 20, monthly: 200, projects: { "/work/alpha": 100 } }, "ada", NOW);
    expect(items.map((i) => [i.scope, i.project, i.spent, i.period])).toEqual([
      ["daily", null, 18, "2026-10-15"],
      ["monthly", null, 118, "2026-10"],
      ["project", "/work/alpha", 112, "2026-10"],
    ]);
    expect(items[0]!.fraction).toBeCloseTo(0.9);
    // 118 over 14.5 days, carried to 31 days.
    expect(items[1]!.projected).toBeCloseTo((118 / 14.5) * 31, 6);
  });

  test("no caps, no items", () => {
    expect(budgetStatus(db(), DEFAULT_BUDGETS, "ada", NOW)).toEqual([]);
  });
});

describe("alerts", () => {
  test("at 80% and at 100%, each once per period", () => {
    const d = db();
    const items = budgetStatus(d, { ...DEFAULT_BUDGETS, daily: 20, monthly: 200, projects: { "/work/alpha": 100 } }, "ada", NOW);
    const alerts = budgetAlerts(items, "host", "en");
    expect(alerts.map((a) => a.body)).toEqual(["90% of today's budget used: $18.00 of $20.00.", "alpha used up its monthly budget: $112 of $100."]);
    expect(takeNew(d, alerts)).toHaveLength(2);
    expect(takeNew(d, alerts)).toHaveLength(0);
    // Over the cap later the same day: the 100% alert is new.
    const over = budgetAlerts([{ ...items[0]!, spent: 21, fraction: 1.05 }], "host", "en");
    expect(takeNew(d, over).map((a) => a.body)).toEqual(["Today's budget is used up: $21.00 of $20.00."]);
  });

  test("in the UI's language", () => {
    const items = budgetStatus(db(), { ...DEFAULT_BUDGETS, daily: 20 }, "ada", NOW);
    expect(budgetAlerts(items, "host", "de")[0]!.body).toBe("90% des heutigen Budgets verbraucht: $18.00 von $20.00.");
  });

  test("plan limits at 80% used, once per window and reset", () => {
    const now = Date.now();
    const report: LimitReport = {
      key: "claude:login",
      provider: "claude",
      plan: "max",
      account: null,
      source: "claude",
      observedAt: now,
      windows: [
        { id: "five_hour", windowMs: 5 * 3_600_000, scope: null, label: null, usedFraction: 0.85, resetsAt: now + 80 * 60_000 },
        { id: "seven_day", windowMs: 7 * 86_400_000, scope: null, label: null, usedFraction: 0.4, resetsAt: now + 3 * 86_400_000 },
      ],
    };
    const alerts = limitAlerts([report], "host", "en", now);
    expect(alerts.map((a) => a.body)).toEqual(["Claude max: 85% of the 5h limit used. Resets in 1h 20m."]);
    const d = memDb();
    expect(takeNew(d, alerts)).toHaveLength(1);
    expect(takeNew(d, limitAlerts([report], "host", "en", now))).toHaveLength(0);
  });
});

describe("settings", () => {
  test("budgets are checked", () => {
    expect(parseSettings({ budgets: { daily: 25, monthly: null, projects: { "/work/a": 50, "/work/b": 0 }, notify: false } })).toEqual({
      patch: { budgets: { daily: 25, monthly: null, projects: { "/work/a": 50 }, notify: false } },
    });
    for (const budgets of [{ daily: -1 }, { monthly: "10" }, { projects: [] }, { notify: 1 }]) expect("error" in parseSettings({ budgets })).toBe(true);
    expect("error" in parseSettings({ language: "xx" })).toBe(true);
  });
});

describe("notification command", () => {
  test("text goes in as arguments or environment, never into a script", () => {
    const evil = `"; rm -rf ~; echo "`;
    const mac = notifyCommand("Harness Dashboard", evil, "darwin")!;
    expect(mac.cmd.at(-1)).toBe(evil);
    expect(mac.cmd.slice(0, -2).join(" ")).not.toContain(evil);
    const win = notifyCommand("Harness Dashboard", evil, "win32")!;
    expect(win.cmd.join(" ")).not.toContain(evil);
    expect(win.env?.HD_BODY).toBe(evil);
  });
});
