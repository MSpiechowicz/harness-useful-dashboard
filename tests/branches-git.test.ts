import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { branchDetail, branches, branchId } from "../src/core/branches.ts";
import type { GitEventRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { ID, memDb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();
const ALPHA = "/work/alpha";
const BETA = "/work/beta";

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: null, ts: NOW - DAY, project: ALPHA, model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 100, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: 1,
    ...over,
  };
}

function commit(over: Partial<GitEventRecord> & { sha: string }): GitEventRecord {
  return {
    kind: "commit", provider: "claude", sessionId: "claude:s1", ts: NOW - DAY, project: ALPHA, agent: "main", branch: "feat/x", callId: null,
    subject: `Commit ${over.sha}`, ...over,
  };
}

function pr(over: Partial<GitEventRecord> & { number: number }): GitEventRecord {
  return {
    kind: "pr", provider: "claude", sessionId: "claude:s1", ts: NOW - DAY, project: ALPHA, agent: "main", branch: "feat/x", callId: null,
    repo: "github.com/acme/app", url: `https://github.com/acme/app/pull/${over.number}`, ...over,
  };
}

/** A feature branch with commits and a pull request, a main branch with a commit and no PR, and a branch without usage. */
function seed(): Database {
  const db = memDb();
  const w = new DbWriter(db, new PriceBook(), ID);
  w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: ALPHA, gitBranch: "feat/x" });
  w.session({ id: "codex:c1", provider: "codex", nativeId: "c1", project: BETA, gitBranch: "main" });
  w.usage(usage({ id: "u1", costUsd: 2 }));
  w.usage(usage({ id: "u2", costUsd: 1, ts: NOW - 2 * DAY }));
  w.usage(usage({ id: "u3", provider: "codex", sessionId: "codex:c1", project: BETA, model: "gpt-5-codex", costUsd: 4 }));

  w.gitEvent(commit({ sha: "aaaaaaa1", ts: NOW - 3 * DAY }));
  w.gitEvent(commit({ sha: "bbbbbbb2", ts: NOW - DAY }));
  // Before the range the table is asked for: counted on the branch's page, not in the range.
  w.gitEvent(commit({ sha: "ccccccc3", ts: NOW - 40 * DAY }));
  w.gitEvent(pr({ number: 7, ts: NOW - DAY / 2 }));
  w.gitEvent(commit({ sha: "ddddddd4", provider: "codex", sessionId: "codex:c1", project: BETA, branch: "main" }));
  // A PR whose link isn't https: listed without one.
  w.gitEvent(pr({ number: 9, provider: "codex", sessionId: "codex:c1", project: BETA, branch: "main", repo: "github.com/acme/beta", url: "http://github.com/acme/beta/pull/9" }));
  // Commits on a branch nothing was spent on: not a row.
  w.gitEvent(commit({ sha: "eeeeeee5", branch: "orphan" }));
  return db;
}

const RANGE = { from: NOW - 30 * DAY, to: NOW };

describe("branches with commits and pull requests", () => {
  test("rows count the commits and PRs in range, with the cost per each", () => {
    const { rows } = branches(seed(), RANGE);
    const feat = rows.find((r) => r.branch === "feat/x")!;
    expect(feat).toMatchObject({ project: ALPHA, cost: 3, commits: 2, prs: 1, costPerCommit: 1.5, costPerPr: 3 });

    const main = rows.find((r) => r.branch === "main")!;
    expect(main).toMatchObject({ project: BETA, cost: 4, commits: 1, prs: 1, costPerCommit: 4, costPerPr: 4 });

    expect(rows.map((r) => r.branch)).not.toContain("orphan");
  });

  test("a branch without commits has no cost per commit", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: ALPHA, gitBranch: "feat/x" });
    w.usage(usage({ id: "u1" }));
    expect(branches(db, {}).rows[0]).toMatchObject({ commits: 0, prs: 0, costPerCommit: null, costPerPr: null });
  });

  test("the model and skill filters leave commits counted, provider and range filter them", () => {
    const db = seed();
    expect(branches(db, { ...RANGE, model: "claude-sonnet-4-5" }).rows.find((r) => r.branch === "feat/x")).toMatchObject({ commits: 2, prs: 1 });
    expect(branches(db, { ...RANGE, provider: "codex" }).rows).toEqual([expect.objectContaining({ branch: "main", commits: 1, prs: 1 })]);
    expect(branches(db, { from: NOW - 2.5 * DAY, to: NOW }).rows.find((r) => r.branch === "feat/x")).toMatchObject({ commits: 1, prs: 1 });
  });

  test("the branch page counts every commit and lists them newest first, linked through the branch's GitHub PR", () => {
    const d = branchDetail(seed(), branchId("feat/x", ALPHA));
    expect(d.totals).toMatchObject({ commits: 3, prs: 1 });
    expect(d.commits.map((c) => c.sha)).toEqual(["bbbbbbb2", "aaaaaaa1", "ccccccc3"]);
    expect(d.commits[0]).toEqual({
      id: `commit:${ALPHA}:bbbbbbb2`, ts: NOW - DAY, branch: "feat/x", sha: "bbbbbbb2", subject: "Commit bbbbbbb2", project: ALPHA,
      sessionId: "claude:s1", provider: "claude", url: "https://github.com/acme/app/commit/bbbbbbb2",
    });
    expect(d.prs).toEqual([
      { id: "pr:github.com/acme/app#7", ts: NOW - DAY / 2, repo: "github.com/acme/app", number: 7, url: "https://github.com/acme/app/pull/7", branch: "feat/x", sessionId: "claude:s1", provider: "claude" },
    ]);
  });

  test("links are https only and never guessed", () => {
    const d = branchDetail(seed(), branchId("main", BETA));
    expect(d.prs[0]).toMatchObject({ number: 9, url: null });
    // The branch's PR is on github.com, so its commit links there.
    expect(d.commits[0]!.url).toBe("https://github.com/acme/beta/commit/ddddddd4");

    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: ALPHA, gitBranch: "feat/y" });
    w.usage(usage({ id: "u1" }));
    w.gitEvent(commit({ sha: "fffffff6", branch: "feat/y" }));
    w.gitEvent(pr({ number: 3, branch: "feat/y", repo: "gitlab.example.com/acme/app", url: "https://gitlab.example.com/acme/app/pull/3" }));
    expect(branchDetail(db, branchId("feat/y", ALPHA)).commits[0]!.url).toBeNull();
  });

  test("a stored pull request link is kept only as a plain https page of it", () => {
    const db = memDb();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: ALPHA, gitBranch: "feat/z" });
    w.usage(usage({ id: "u1" }));
    const links: [number, string][] = [
      [1, "https://github.com/acme/app/pull/1"],
      [2, "https://git.example.com:8443/acme/app/pull/2"],
      [3, "https://user:pw@github.com/acme/app/pull/3"],
      [4, "https://github.com/acme/app/pull/4?x=1"],
      [5, "https://github.com/acme/app/pull/5#files"],
      [6, "https://github.com/acme/app/issues/6"],
      [7, "javascript:alert(1)//https://github.com/acme/app/pull/7"],
      [8, "https://github.com/acme/.github/pull/8"],
      [9, "https://github.com/acme/../pull/9"],
      [10, "https://github.com/./app/pull/10"],
      [11, "https://github.com/../../pull/11"],
    ];
    for (const [number, url] of links) w.gitEvent(pr({ number, branch: "feat/z", url }));

    const shown = (prs: { number: number | null; url: string | null }[]) => Object.fromEntries(prs.map((p) => [p.number, p.url]));
    const expected = { 1: links[0]![1], 2: links[1]![1], 3: null, 4: null, 5: null, 6: null, 7: null, 8: links[7]![1], 9: null, 10: null, 11: null };
    expect(shown(branchDetail(db, branchId("feat/z", ALPHA)).prs)).toEqual(expected);
    expect(shown(new Queries(db, () => new PriceBook()).sessionDetail("claude:s1").git.prs)).toEqual(expected);
  });
});

describe("sessions with compactions and git", () => {
  function withCompactions(): Database {
    const db = seed();
    const w = new DbWriter(db, new PriceBook(), ID);
    w.session({ id: "omp:sub", provider: "omp", nativeId: "sub", project: ALPHA, parentSessionId: "claude:s1", agent: "Scout" });
    w.gitEvent(commit({ sha: "1234567a", provider: "omp", sessionId: "omp:sub", ts: NOW - DAY / 4 }));
    const base = { provider: "claude" as const, sessionId: "claude:s1", project: ALPHA, model: "claude-sonnet-4-5", agent: "main", durationMs: 4000 };
    w.compaction({ ...base, id: "claude:s1:c1:compact", ts: NOW - 1.5 * DAY, trigger: "auto", preTokens: 150_000, postTokens: 4_000 });
    w.compaction({ ...base, id: "claude:s1:c2:compact", ts: NOW - DAY, trigger: "manual", preTokens: 90_000, postTokens: null, costUsd: 0.5 });
    return db;
  }

  test("a session's page lists its compactions oldest first, and the commits and PRs of it and its subagents", () => {
    const d = new Queries(withCompactions(), () => new PriceBook()).sessionDetail("claude:s1");
    expect(d.compactions.map((c) => [c.id, c.trigger, c.preTokens, c.postTokens, c.estimated])).toEqual([
      ["claude:s1:c1:compact", "auto", 150_000, 4_000, true],
      ["claude:s1:c2:compact", "manual", 90_000, null, false],
    ]);
    expect(d.compactions[0]!.costUsd).toBeGreaterThan(0);
    expect(d.compactions[1]).toMatchObject({ costUsd: 0.5, durationMs: 4000, model: "claude-sonnet-4-5", agent: "main" });
    expect(d.git.commits.map((c) => c.sha)).toEqual(["1234567a", "bbbbbbb2", "eeeeeee5", "aaaaaaa1", "ccccccc3"]);
    expect(d.git.prs.map((p) => p.number)).toEqual([7]);
    expect(d.git).toMatchObject({ commitCount: 5, prCount: 1 });
  });

  test("the sessions list counts each row's compactions", () => {
    const { rows } = new Queries(withCompactions(), () => new PriceBook()).sessions({}, {});
    expect(Object.fromEntries(rows.map((r) => [r.id, r.compactions]))).toEqual({ "claude:s1": 2, "codex:c1": 0 });
  });
});

describe("a database from before schema 18", () => {
  function v17(): Database {
    const db = seed();
    db.exec(`DROP TABLE git_events; DROP TABLE compactions; DROP VIEW outcome_counts; DROP TABLE outcome_days; DROP TABLE chart_notes;
             UPDATE meta SET value = '17' WHERE key = 'schema_version'; DELETE FROM meta WHERE key = 'min_reader_schema'`);
    return db;
  }

  test("branches, the branch page and sessions read without the new tables", () => {
    const db = v17();
    expect(branches(db, RANGE).rows.find((r) => r.branch === "feat/x")).toMatchObject({ cost: 3, commits: 0, prs: 0, costPerCommit: null });
    expect(branchDetail(db, branchId("feat/x", ALPHA))).toMatchObject({ totals: { commits: 0, prs: 0 }, commits: [], prs: [] });

    const q = new Queries(db, () => new PriceBook());
    expect(q.sessionDetail("claude:s1")).toMatchObject({ compactions: [], git: { commits: [], prs: [] } });
    expect(q.sessions({}, {}).rows.every((r) => r.compactions === 0)).toBe(true);
  });
});
