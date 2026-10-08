import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeRoots, liveClaudeSessions } from "../src/core/claudeRegistry.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries, sessionStatus, type SessionStatusInput } from "../src/core/queries.ts";
import { ID, memDb, tempDir, testConfig } from "./helpers.ts";

const SEC = 1000;
const MIN = 60 * SEC;
const NOW = new Date(2026, 8, 1, 12, 0, 0).getTime();

const claudeHere = (over: Partial<SessionStatusInput> = {}): SessionStatusInput => ({
  provider: "claude", host: "here", thisHost: "here", nativeId: "s1", lastTs: NOW - 5 * MIN, now: NOW, registry: new Set(["s1"]), ...over,
});

describe("sessionStatus", () => {
  test("a Claude session of this machine is open while the registry lists it, however quiet", () => {
    expect(sessionStatus("idle", claudeHere())).toBe("idle");
    expect(sessionStatus("idle", claudeHere({ lastTs: NOW - 5 * 60 * MIN }))).toBe("idle");
  });

  test("missing from the registry and quiet for 90 seconds or more, it is closed", () => {
    expect(sessionStatus("working", claudeHere({ registry: new Set(), lastTs: NOW - 90 * SEC }))).toBe("closed");
    expect(sessionStatus("idle", claudeHere({ registry: new Set(["other"]) }))).toBe("closed");
  });

  test("activity in the last 90 seconds is never overridden", () => {
    expect(sessionStatus("working", claudeHere({ registry: new Set(), lastTs: NOW - 89 * SEC }))).toBe("working");
    // Another machine's clock ahead of ours.
    expect(sessionStatus("idle", claudeHere({ registry: new Set(), lastTs: NOW + 20 * MIN }))).toBe("idle");
  });

  test("another machine's session, another harness, or no registry: closed after 30 minutes without activity", () => {
    for (const over of [{ host: "elsewhere" }, { provider: "codex" }, { registry: null }, { thisHost: null }] as Partial<SessionStatusInput>[]) {
      const empty = { registry: over.registry === null ? null : new Set<string>(), ...over };
      expect(sessionStatus("idle", claudeHere({ ...empty, lastTs: NOW - 30 * MIN }))).toBe("idle");
      expect(sessionStatus("error", claudeHere({ ...empty, lastTs: NOW - 30 * MIN - 1 }))).toBe("closed");
    }
  });
});

describe("Claude Code's session registry", () => {
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  /** A pid nothing runs as: above the kernel's limit of 2^22. */
  const DEAD_PID = 99_999_999;
  let clock = NOW;
  /** Each read past the 15-second cache. */
  const later = () => (clock += 20 * SEC);

  function root(files: Record<string, unknown>): string {
    const dir = tempDir("hd-claude-");
    mkdirSync(join(dir, "sessions"));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "sessions", name), typeof body === "string" ? body : JSON.stringify(body));
    return dir;
  }

  test.skipIf(process.platform === "win32")("lists the sessions of running processes, and never opens a key file", () => {
    const dir = root({
      [`${process.pid}.json`]: { pid: process.pid, sessionId: "alive", cwd: "/work", kind: "interactive" },
      [`${DEAD_PID}.json`]: { pid: DEAD_PID, sessionId: "dead" },
      "12.json": "{ not json",
      "notes.json": { pid: process.pid, sessionId: "wrong-name" },
      [`${process.pid}.json.bak`]: { pid: process.pid, sessionId: "backup" },
    });
    writeFileSync(join(dir, "sessions", "13.json"), JSON.stringify({ pid: process.pid, sessionId: "too-big", pad: "x".repeat(70_000) }));
    const key = join(dir, "sessions", `${process.pid}.0123abcd.key`);
    writeFileSync(key, "secret");
    chmodSync(key, 0o000);

    const touched: string[] = [];
    const record = (name: "openSync" | "readFileSync" | "lstatSync" | "statSync") => {
      const original = fs[name] as (...a: unknown[]) => unknown;
      spies.push(spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
        touched.push(String(a[0]));
        return original(...a);
      }) as never));
    };
    record("openSync");
    record("readFileSync");
    record("lstatSync");
    record("statSync");

    expect(liveClaudeSessions([dir], later())).toEqual(new Set(["alive"]));
    expect(touched.some((p) => p.endsWith(".key"))).toBe(false);
    expect(touched).toContain(join(dir, "sessions", `${process.pid}.json`));
  });

  test.skipIf(process.platform !== "linux")("a pid reused by a newer process is dead", () => {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
    const same = root({ [`${process.pid}.json`]: { pid: process.pid, sessionId: "same", procStart: start } });
    const reused = root({ [`${process.pid}.json`]: { pid: process.pid, sessionId: "reused", procStart: String(Number(start) + 1) } });
    expect(liveClaudeSessions([same], later())).toEqual(new Set(["same"]));
    expect(liveClaudeSessions([reused], later())).toEqual(new Set());
  });

  test.skipIf(process.platform === "win32")("links are not followed, and a folder without a registry gives null", () => {
    const target = join(tempDir("hd-target-"), "x.json");
    writeFileSync(target, JSON.stringify({ pid: process.pid, sessionId: "linked" }));
    const dir = root({});
    symlinkSync(target, join(dir, "sessions", `${process.pid}.json`));
    expect(liveClaudeSessions([dir], later())).toEqual(new Set());

    expect(liveClaudeSessions([tempDir("hd-empty-")], later())).toBeNull();
    expect(liveClaudeSessions([], later())).toBeNull();
  });

  test.skipIf(process.platform === "win32")("read again only after 15 seconds", () => {
    const dir = root({});
    const at = later();
    expect(liveClaudeSessions([dir], at)).toEqual(new Set());
    writeFileSync(join(dir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "new" }));
    expect(liveClaudeSessions([dir], at + 14 * SEC)).toEqual(new Set());
    expect(liveClaudeSessions([dir], at + 15 * SEC)).toEqual(new Set(["new"]));
  });

  test("the roots: above each configured projects folder, and CLAUDE_CONFIG_DIR", () => {
    const cfg = testConfig("/r");
    expect(claudeRoots(cfg, {})).toEqual(["/r/claude"]);
    expect(claudeRoots(cfg, { CLAUDE_CONFIG_DIR: "/c" })).toEqual(["/r/claude", "/c"]);
    expect(claudeRoots(cfg, { CLAUDE_CONFIG_DIR: "/r/claude/" })).toEqual(["/r/claude"]);
  });
});

describe("Live with the registry", () => {
  function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
    return {
      provider: "claude", sessionId: "claude:a", promptId: null, ts: NOW - 5 * MIN, project: "/work/alpha", model: "claude-sonnet-4-5",
      skill: null, agent: "main", isSubagent: false, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: 1,
      ...over,
    };
  }

  function seed() {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    for (const [id, provider] of [["claude:a", "claude"], ["claude:b", "claude"], ["codex:c", "codex"]] as const) {
      w.session({ id, provider, nativeId: id.split(":")[1]!, project: "/work/alpha" });
    }
    w.usage(usage({ id: "a1" }));
    w.usage(usage({ id: "b1", sessionId: "claude:b" }));
    w.usage(usage({ id: "c1", provider: "codex", sessionId: "codex:c", ts: NOW - 40 * MIN }));
    return db;
  }

  test("Claude sessions of this machine are judged by the registry, others by 30 quiet minutes", () => {
    const q = new Queries(seed(), () => new PriceBook());
    const status = (opts?: { host: string; claudeLive: Set<string> | null }) =>
      Object.fromEntries(q.live({}, 60, NOW, opts).sessions.map((s) => [s.id, s.status]));

    expect(status({ host: ID.host, claudeLive: new Set(["a"]) })).toEqual({ "claude:a": "idle", "claude:b": "closed", "codex:c": "closed" });
    expect(status({ host: "another-host", claudeLive: new Set(["a"]) })).toEqual({ "claude:a": "idle", "claude:b": "idle", "codex:c": "closed" });
    expect(status()).toEqual({ "claude:a": "idle", "claude:b": "idle", "codex:c": "closed" });
  });
});
