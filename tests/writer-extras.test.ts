import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { DbWriter, recomputeCosts } from "../src/core/ingest/writer.ts";
import type { CompactionRecord, GitEventRecord, OutcomeRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { localDayStart, rollupCutoff } from "../src/core/rollup.ts";
import { ID, memDb } from "./helpers.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const DAY = 86_400_000;

const commit = (patch: Partial<GitEventRecord> = {}): GitEventRecord => ({
  kind: "commit",
  provider: "claude",
  sessionId: "claude:s1",
  ts: NOW,
  project: "/work/app",
  agent: "main",
  branch: "feat",
  callId: "call-1",
  sha: "1a2b3c4",
  subject: "Keep the session",
  ...patch,
});

const pr = (patch: Partial<GitEventRecord> = {}): GitEventRecord =>
  commit({ kind: "pr", sha: null, subject: null, repo: "github.com/Acme/App", number: 12, url: "https://github.com/Acme/App/pull/12", ...patch });

const gitRows = (db: Database) =>
  db.query<{ id: string; session_id: string; ts: number; branch: string | null; subject: string | null; url: string | null }, []>(
    "SELECT id, session_id, ts, branch, subject, url FROM git_events ORDER BY id",
  ).all();

describe("git events", () => {
  test("a commit counts once per project and sha, with its first sighting", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.gitEvent(commit({ ts: NOW + 1000, sessionId: "claude:s2", callId: "call-2", branch: null, subject: null }));
    w.gitEvent(commit());
    w.gitEvent(commit({ project: "/work/other" }));
    expect(gitRows(db)).toEqual([
      { id: "commit:/work/app:1a2b3c4", session_id: "claude:s1", ts: NOW, branch: "feat", subject: "Keep the session", url: null },
      { id: "commit:/work/other:1a2b3c4", session_id: "claude:s1", ts: NOW, branch: "feat", subject: "Keep the session", url: null },
    ]);
  });

  test("a commit without a sha is keyed by its call, and one with neither is dropped", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.gitEvent(commit({ sha: null }));
    w.gitEvent(commit({ sha: null }));
    w.gitEvent(commit({ sha: null, callId: null }));
    expect(gitRows(db).map((r) => r.id)).toEqual(["commit:call-1"]);
  });

  test("a pull request counts once per repository and number, with the earliest time", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.gitEvent(pr({ ts: NOW + 5000, url: null }));
    w.gitEvent(pr({ repo: "github.com/acme/app", sessionId: "claude:s0", ts: NOW }));
    expect(gitRows(db)).toEqual([
      { id: "pr:github.com/acme/app#12", session_id: "claude:s0", ts: NOW, branch: "feat", subject: null, url: "https://github.com/Acme/App/pull/12" },
    ]);
  });

  test("a later sighting fills the project and user a stored row lacks, and never replaces them", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.gitEvent(pr({ project: null }));
    db.exec("UPDATE git_events SET user = NULL");

    w.gitEvent(pr({ ts: NOW + 1000 }));
    w.gitEvent(pr({ ts: NOW + 2000, project: "/work/other" }));
    const row = () => db.query<{ project: string | null; user: string | null }, []>("SELECT project, user FROM git_events").get()!;
    expect(row()).toEqual({ project: "/work/app", user: ID.user });
  });

  test("a branch name is cut at 200 characters, whatever read it", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.gitEvent(commit({ branch: "b".repeat(5000), sha: null }));
    w.gitEvent(pr({ branch: "p".repeat(300) }));
    expect(gitRows(db).map((r) => r.branch?.length)).toEqual([200, 200]);
  });

  test("a subject older than the detail kept is not stored", () => {
    const db = memDb();
    new DbWriter(db, new PriceBook(), ID, NOW).gitEvent(commit({ ts: NOW - DAY }));
    expect(gitRows(db)[0]!.subject).toBeNull();
  });
});

describe("compactions", () => {
  const MODEL = "claude-sonnet-4-5";
  const compaction = (patch: Partial<CompactionRecord> = {}): CompactionRecord => ({
    id: "claude:s1:u1:compact",
    provider: "claude",
    sessionId: "claude:s1",
    ts: NOW,
    project: "/work/app",
    model: MODEL,
    agent: "main",
    trigger: "auto",
    preTokens: 150_000,
    postTokens: 8_000,
    durationMs: 30_000,
    ...patch,
  });
  const rows = (db: Database) =>
    db.query<{ id: string; cost_usd: number; estimated: number }, []>("SELECT id, cost_usd, estimated FROM compactions ORDER BY id").all();

  test("the context read at the cache-read rate and the summary at the output rate, unless a cost is reported", () => {
    const db = memDb();
    const prices = new PriceBook();
    const r = prices.rates(MODEL);
    const w = new DbWriter(db, prices, ID);
    w.compaction(compaction());
    w.compaction(compaction({ id: "claude:s1:u2:compact", postTokens: null }));
    w.compaction(compaction({ id: "copilot:s9:c1:compact", provider: "copilot", costUsd: 0.25 }));
    expect(rows(db)).toEqual([
      { id: "claude:s1:u1:compact", cost_usd: (150_000 * r.cacheRead + 8_000 * r.output) / 1e6, estimated: 1 },
      { id: "claude:s1:u2:compact", cost_usd: (150_000 * r.cacheRead) / 1e6, estimated: 1 },
      { id: "copilot:s9:c1:compact", cost_usd: 0.25, estimated: 0 },
    ]);
    expect(rows(db)[0]!.cost_usd).toBeGreaterThan(0);
  });

  test("re-pricing changes the estimates only", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.compaction(compaction());
    w.compaction(compaction({ id: "copilot:s9:c1:compact", provider: "copilot", costUsd: 0.25 }));
    recomputeCosts(db, new PriceBook([{ pattern: MODEL, input: 10, output: 50, cacheRead: 1 }]));
    expect(rows(db)).toEqual([
      { id: "claude:s1:u1:compact", cost_usd: (150_000 * 1 + 8_000 * 50) / 1e6, estimated: 1 },
      { id: "copilot:s9:c1:compact", cost_usd: 0.25, estimated: 0 },
    ]);
  });
});

describe("rolled-up outcomes", () => {
  const OLD = NOW - 10 * DAY;
  const outcome = (patch: Partial<OutcomeRecord>): OutcomeRecord => ({
    id: "o",
    provider: "claude",
    sessionId: "claude:s1",
    ts: OLD,
    project: "/work/app",
    model: "claude-sonnet-4-5",
    agent: "main",
    kind: "tool_ok",
    ...patch,
  });

  test("a successful call is skipped only when its session-day on this host is counted already", () => {
    const db = memDb();
    const roll = db.query("INSERT INTO outcome_days (ts, host, provider, session_id, n) VALUES (?, ?, 'claude', ?, 3)");
    roll.run(localDayStart(OLD), ID.host, "claude:s1");
    roll.run(localDayStart(OLD), "other-host", "claude:s3");
    const w = new DbWriter(db, new PriceBook(), ID, 0, rollupCutoff(NOW));

    w.outcome(outcome({ id: "rolled" }));
    w.outcome(outcome({ id: "error", kind: "tool_error" }));
    w.outcome(outcome({ id: "other-session", sessionId: "claude:s2" }));
    w.outcome(outcome({ id: "other-day", ts: OLD - DAY }));
    w.outcome(outcome({ id: "other-host", sessionId: "claude:s3" }));
    w.outcome(outcome({ id: "recent", ts: NOW }));

    const ids = db.query<{ id: string }, []>("SELECT id FROM outcomes ORDER BY id").all().map((r) => r.id);
    expect(ids).toEqual(["error", "other-day", "other-host", "other-session", "recent"]);
  });
});

describe("Copilot session totals", () => {
  const SID = "copilot:s1";
  const shutdown: UsageRecord = {
    id: `${SID}:evt-1:main|gpt-5`,
    provider: "copilot",
    sessionId: SID,
    promptId: null,
    ts: NOW,
    project: "/work/app",
    model: "gpt-5",
    skill: null,
    agent: "main",
    isSubagent: false,
    input: 10_000,
    output: 2_000,
    cacheRead: 5_000,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 500,
    billing: "github-copilot",
    premiumRequests: 3,
    rollup: true,
  };
  const call: UsageRecord = { ...shutdown, id: `${SID}:u:${NOW}:0:main:gpt-5:10000:2000`, rollup: undefined, premiumRequests: 0 };
  const totals = (db: Database) =>
    db.query<{ tokens: number; cost: number; premium: number }, []>(
      "SELECT SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost, SUM(premium_requests) AS premium FROM usage",
    ).get()!;
  const callOnly = (db: Database) => {
    const c = db.query<{ total_tokens: number; cost_usd: number }, [string]>("SELECT total_tokens, cost_usd FROM usage WHERE id = ?").get(call.id)!;
    return { tokens: c.total_tokens, cost: c.cost_usd, premium: 3 };
  };

  test("the totals keep their premium requests and give up their tokens to the calls, whichever comes first", () => {
    const totalsFirst = memDb();
    const a = new DbWriter(totalsFirst, new PriceBook(), ID);
    a.usage(shutdown);
    a.usage(call);
    a.supersedeRollups(SID);
    a.usage(shutdown); // read again

    const callsFirst = memDb();
    const b = new DbWriter(callsFirst, new PriceBook(), ID);
    b.usage(call);
    b.supersedeRollups(SID);
    b.usage(shutdown);

    expect(totals(totalsFirst)).toEqual(callOnly(totalsFirst));
    expect(totals(callsFirst)).toEqual(callOnly(callsFirst));
    expect(totals(callsFirst).tokens).toBe(17_000);
  });

  test("totals of a session without calls of its own keep their tokens", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.usage(shutdown);
    w.supersedeRollups(SID);
    expect(totals(db).tokens).toBe(17_000);
    expect(totals(db).premium).toBe(3);
  });
});

describe("notPrompt", () => {
  test("a record that is no prompt goes, and its usage and tool calls move to the prompt before it", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    const base = { sessionId: "claude:s1", provider: "claude" as const, skill: null, isCommand: false };
    w.prompt({ ...base, id: "claude:s1:p1", ts: NOW, text: "Fix the login" });
    w.prompt({ ...base, id: "claude:s1:summary", ts: NOW + 1000, text: "This session is being continued…" });
    w.usage({
      id: "u1", provider: "claude", sessionId: "claude:s1", promptId: "claude:s1:summary", ts: NOW + 2000, project: "/work/app",
      model: "claude-sonnet-4-5", skill: null, agent: "main", isSubagent: false,
      input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    });
    w.tool({
      id: "t1", usageId: "u1", sessionId: "claude:s1", promptId: "claude:s1:summary", provider: "claude", ts: NOW + 2000,
      project: "/work/app", tool: "Read", filePath: null, skill: null, agent: "main",
    });

    w.notPrompt("claude:s1:summary", "claude:s1:p1");

    expect(db.query<{ id: string }, []>("SELECT id FROM prompts").all()).toEqual([{ id: "claude:s1:p1" }]);
    expect(db.query<{ prompt_id: string }, []>("SELECT prompt_id FROM usage").get()!.prompt_id).toBe("claude:s1:p1");
    expect(db.query<{ prompt_id: string }, []>("SELECT prompt_id FROM tool_calls").get()!.prompt_id).toBe("claude:s1:p1");
  });

  test("a prompt named as its own previous one stays, with its usage", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.prompt({ id: "claude:s1:p1", sessionId: "claude:s1", provider: "claude", skill: null, isCommand: false, ts: NOW, text: "Fix the login" });
    w.usage({
      id: "u1", provider: "claude", sessionId: "claude:s1", promptId: "claude:s1:p1", ts: NOW + 1000, project: "/work/app",
      model: "claude-sonnet-4-5", skill: null, agent: "main", isSubagent: false,
      input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    });

    w.notPrompt("claude:s1:p1", "claude:s1:p1");

    expect(db.query<{ id: string }, []>("SELECT id FROM prompts").all()).toEqual([{ id: "claude:s1:p1" }]);
    expect(db.query<{ prompt_id: string }, []>("SELECT prompt_id FROM usage").get()!.prompt_id).toBe("claude:s1:p1");
  });
});
