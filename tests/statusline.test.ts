import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { fillTemplate, formatDuration, formatUsd, gather, parseInput, render, startOfDay, useColor } from "../src/core/statusline.ts";
import { memDb, tempDir } from "./helpers.ts";

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime(); // local time
const MIN = 60_000;

function fixture(db = memDb()) {
  const usage = db.prepare("INSERT INTO usage (id, provider, session_id, ts, user, model, cost_usd) VALUES (?, ?, ?, ?, ?, 'm', ?)");
  usage.run("u1", "claude", "claude:s1", NOW - 60 * MIN, "alex", 1.0);
  usage.run("u2", "claude", "claude:s1", NOW - 30 * MIN, "alex", 0.24);
  usage.run("u3", "claude", "claude:s1:agent-1", NOW - 20 * MIN, "alex", 0.5);
  usage.run("u4", "codex", "codex:x", NOW - 10 * MIN, "alex", 2.0);
  usage.run("u5", "codex", "codex:y", NOW - 10 * MIN, "sam", 9.0); // another user
  usage.run("u6", "claude", "claude:old", startOfDay(NOW) - MIN, "alex", 7.0); // yesterday
  db.prepare("INSERT INTO sessions (id, provider, native_id, parent_session_id) VALUES (?, 'claude', ?, ?)").run("claude:s1:agent-1", "s1", "claude:s1");
  const reading = db.prepare(
    `INSERT INTO limit_readings (host, report_key, window_id, slot, provider, used_fraction, resets_at, observed_at)
     VALUES (?, 'claude:login', ?, ?, 'claude', ?, ?, ?)`,
  );
  reading.run("here", "five_hour", 1, 0.42, NOW + 80 * MIN, NOW - 2 * MIN);
  reading.run("here", "seven_day", 1, 0.9, NOW + 3 * 1440 * MIN, NOW - 2 * MIN);
  return db;
}

const INPUT = JSON.stringify({
  session_id: "s1",
  transcript_path: "/t.jsonl",
  cwd: "/work",
  model: { id: "claude-opus-5-5", display_name: "Opus 5.5" },
  workspace: { current_dir: "/work", project_dir: "/work" },
  cost: { total_cost_usd: 0.99, total_duration_ms: 1000 },
});

const opts = { user: "alex", host: "here", now: NOW };

describe("statusline", () => {
  test("parses Claude Code's stdin and tolerates garbage", () => {
    expect(parseInput(INPUT)).toEqual({ sessionId: "s1", model: "Opus 5.5", cwd: "/work", costUsd: 0.99, fiveHour: null });
    expect(parseInput("not json")).toEqual({ sessionId: null, model: null, cwd: null, costUsd: null, fiveHour: null });
    const withLimits = parseInput(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1738425600 } } }));
    expect(withLimits.fiveHour).toEqual({ usedFraction: 0.235, resetsAt: 1738425600_000 });
  });

  test("full line: session with its subagents, today for this user, the 5-hour window", () => {
    const d = gather(fixture(), parseInput(INPUT), opts);
    expect(d.sessionCost).toBeCloseTo(1.74);
    expect(d.todayCost).toBeCloseTo(3.74);
    expect(d.limit).toEqual({ usedFraction: 0.42, resetsAt: NOW + 80 * MIN });
    expect(render(d, { color: false, now: NOW })).toBe("Opus 5.5 · session $1.74 · today $3.74 · 5h 42% (resets 1h20m)");
  });

  test("falls back to stdin's cost for a session not scanned yet, and to no limit when stale or reset", () => {
    const db = fixture();
    const input = parseInput(JSON.stringify({ session_id: "new", model: { display_name: "Sonnet" }, cost: { total_cost_usd: 0.5 } }));
    expect(gather(db, input, opts).sessionCost).toBe(0.5);
    expect(gather(db, input, { ...opts, now: NOW + 16 * MIN }).limit).toBeNull(); // older than 15 minutes
    expect(gather(db, input, { ...opts, now: NOW + 81 * MIN }).limit).toBeNull();
  });

  test("Claude Code's own rate limit reading wins over the stored one", () => {
    const input = parseInput(JSON.stringify({ session_id: "s1", rate_limits: { five_hour: { used_percentage: 77, resets_at: (NOW + 30 * MIN) / 1000 } } }));
    expect(gather(fixture(), input, opts).limit).toEqual({ usedFraction: 0.77, resetsAt: NOW + 30 * MIN });
  });

  test("without a database the line still shows what stdin knows", () => {
    const d = gather(null, parseInput(INPUT), opts);
    expect(render(d, { color: false, now: NOW })).toBe("Opus 5.5 · session $0.99");
    expect(render(gather(null, parseInput(""), opts), { color: false, now: NOW })).toBe("harness-dashboard");
  });

  test("reads a WAL database read-only while another connection writes", () => {
    const path = join(tempDir(), "usage.db");
    const writer = openDb(path, { journalMode: "wal" });
    fixture(writer);
    writer.exec("BEGIN IMMEDIATE");
    writer.exec("INSERT INTO usage (id, provider, session_id, ts, user, cost_usd) VALUES ('w', 'claude', 'claude:s1', 0, 'alex', 100)");
    const reader = openDb(path, { readonly: true });
    expect(gather(reader, parseInput(INPUT), opts).sessionCost).toBeCloseTo(1.74); // uncommitted row not seen
    writer.exec("COMMIT");
    reader.close();
    writer.close();
  });

  test("templates drop empty placeholders with their separator and keep unknown ones", () => {
    const v = { model: "M", session: "", today: "T", limit: "" };
    expect(fillTemplate("{model} · {session} · {today} · {limit}", v)).toBe("M · T");
    expect(fillTemplate("{session} | {today}", v)).toBe("T");
    expect(fillTemplate("[{model}] {today} {foo}", v)).toBe("[M] T {foo}");
    expect(fillTemplate("{session}", v)).toBe("");
  });

  test("formats money, durations and colors", () => {
    expect(formatUsd(1.236)).toBe("$1.24");
    expect(formatUsd(1234)).toBe("$1.2k");
    expect(formatDuration(80 * MIN)).toBe("1h20m");
    expect(formatDuration(5 * MIN)).toBe("5m");
    expect(formatDuration(50 * 60 * MIN)).toBe("2d2h");
    expect(useColor(false, {})).toBe(true);
    expect(useColor(false, { NO_COLOR: "1" })).toBe(false);
    expect(useColor(true, {})).toBe(false);
    const colored = render({ model: "M", sessionCost: null, todayCost: null, limit: { usedFraction: 0.95, resetsAt: null } }, { color: true, now: NOW });
    expect(colored).toContain("\x1b[31m95%");
  });
});
