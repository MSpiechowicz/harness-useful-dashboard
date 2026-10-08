import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scan } from "../src/core/ingest/index.ts";
import { claudeAssistant, claudeUser, CLAUDE_SESSION, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

const PROJ = ["claude", "projects", "-work-alpha"];
const PR_URL = "https://github.com/acme/app/pull/248";

/** An assistant reply that runs one shell command. */
function bash(id: string, ts: string, command: string, tool = "Bash") {
  return claudeAssistant({ id: `msg_${id}`, ts, content: [{ type: "tool_use", id: `toolu_${id}`, name: tool, input: { command } }] });
}

/** The result of that command: its text, and the record's toolUseResult with stdout. */
function bashResult(id: string, ts: string, output: string, opts: { error?: boolean; stdout?: string; gitBranch?: string } = {}) {
  return {
    type: "user",
    uuid: `r-${id}`,
    timestamp: ts,
    sessionId: CLAUDE_SESSION,
    cwd: "/work/alpha",
    gitBranch: opts.gitBranch ?? "main",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: output, is_error: opts.error ?? false }] },
    toolUseResult: { stdout: opts.stdout ?? output, stderr: "", interrupted: false },
  };
}

function prLink(ts: string) {
  return { type: "pr-link", sessionId: CLAUDE_SESSION, prNumber: 248, prUrl: PR_URL, prRepository: "acme/app", timestamp: ts };
}

function boundary(uuid: string, ts: string, meta: Record<string, unknown>, sidechain = false) {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    timestamp: ts,
    sessionId: CLAUDE_SESSION,
    cwd: "/work/alpha",
    gitBranch: "main",
    isSidechain: sidechain,
    compactMetadata: meta,
  };
}

function summary(uuid: string, ts: string, flagged = true, promptId?: string) {
  return {
    ...claudeUser("This session is being continued from a previous conversation.", { uuid, ts, promptId }),
    ...(flagged ? { isCompactSummary: true, isVisibleInTranscriptOnly: true } : {}),
  };
}

async function ingest(records: unknown[], promptTextLimit = 2000) {
  const root = tempDir();
  writeJsonl(join(root, ...PROJ, `${CLAUDE_SESSION}.jsonl`), records);
  const db = memDb();
  const res = await scan(db, testConfig(root, { promptTextLimit }), ID);
  expect(res.errors).toEqual([]);
  return { db, root };
}

const gitEvents = (db: ReturnType<typeof memDb>) => db.query<any, []>("SELECT * FROM git_events ORDER BY ts, id").all();

describe("Claude Code commits and pull requests", () => {
  test("a commit counts without prompt text, its subject only with it", async () => {
    const records = [
      claudeUser("Commit it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      bash("c1", "2026-09-01T10:00:01.000Z", 'git add -A && git commit -m "Fix login"'),
      bashResult("c1", "2026-09-01T10:00:02.000Z", "[feature/login 1a2b3c4] Fix login\n 1 file changed, 2 insertions(+)"),
    ];

    const bare = gitEvents((await ingest(records, 0)).db);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatchObject({ kind: "commit", provider: "claude", session_id: `claude:${CLAUDE_SESSION}`, project: "/work/alpha", branch: "feature/login", sha: "1a2b3c4", subject: null, agent: "main" });

    const kept = gitEvents((await ingest(records)).db);
    expect(kept[0]).toMatchObject({ sha: "1a2b3c4", subject: "Fix login" });
  });

  test("a commit whose output shows no commit line is one commit on the logged branch", async () => {
    const events = gitEvents(
      (
        await ingest([
          bash("c1", "2026-09-01T10:00:01.000Z", "git commit -qm wip"),
          bashResult("c1", "2026-09-01T10:00:02.000Z", "", { gitBranch: "dev", stdout: "" }),
        ])
      ).db,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "commit:claude:toolu_c1", kind: "commit", branch: "dev", sha: null });
  });

  test("the PowerShell tool commits and opens PRs as Bash does", async () => {
    const { db } = await ingest([
      bash("w1", "2026-09-01T10:00:01.000Z", 'git add -A; git commit -m "Fix login"; gh pr create --fill', "PowerShell"),
      bashResult("w1", "2026-09-01T10:00:02.000Z", `[main 7a8b9c0] Fix login\r\n 1 file changed\r\n${PR_URL}\r\n`),
    ]);
    expect(gitEvents(db).map((e) => [e.kind, e.sha, e.url])).toEqual([
      ["commit", "7a8b9c0", null],
      ["pr", null, PR_URL],
    ]);
  });

  test("the PowerShell tool keeps the backslashes in a Windows temp path", async () => {
    const { db } = await ingest([
      bash("w2", "2026-09-01T10:00:01.000Z", "Set-Location C:\\Users\\me\\AppData\\Local\\Temp\\probe; git commit -m a", "PowerShell"),
      bashResult("w2", "2026-09-01T10:00:02.000Z", "[main 1111111] a"),
      bash("w3", "2026-09-01T10:00:03.000Z", "Set-Location C:\\Users\\me\\app; git commit -m b", "PowerShell"),
      bashResult("w3", "2026-09-01T10:00:04.000Z", "[main 2222222] b"),
    ]);
    expect(gitEvents(db).map((e) => e.sha)).toEqual(["2222222"]);
  });

  test("a quiet commit takes its sha from the git log after it, else its subject from the command", async () => {
    const records = [
      bash("q1", "2026-09-01T10:00:01.000Z", 'git add -A && git commit -qm "ci: Update the actions\n\nCo-Authored-By: x" && git log --oneline -1'),
      bashResult("q1", "2026-09-01T10:00:02.000Z", "ce489b1 ci: Update the actions"),
      bash("q2", "2026-09-01T10:00:03.000Z", "git commit -q -F - <<'EOF'\nfix: Keep the session\n\nBody\nEOF"),
      bashResult("q2", "2026-09-01T10:00:04.000Z", ""),
    ];
    const rows = (db: ReturnType<typeof memDb>) => gitEvents(db).map((e) => [e.id, e.sha, e.subject]);

    expect(rows((await ingest(records)).db)).toEqual([
      ["commit:/work/alpha:ce489b1", "ce489b1", "ci: Update the actions"],
      ["commit:claude:toolu_q2", null, "fix: Keep the session"],
    ]);
    // Without prompt text: the sha, no subject.
    expect(rows((await ingest(records, 0)).db)).toEqual([
      ["commit:/work/alpha:ce489b1", "ce489b1", null],
      ["commit:claude:toolu_q2", null, null],
    ]);
  });

  test("a commit stored before by its call alone becomes its sha's row on a re-read", async () => {
    const records = [
      bash("q1", "2026-09-01T10:00:01.000Z", "git commit -qm wip && git log --oneline -1"),
      bashResult("q1", "2026-09-01T10:00:02.000Z", "ce489b1 wip"),
    ];
    const { db, root } = await ingest(records);
    // As an older version stored it: keyed by its call, without sha or subject.
    db.query("UPDATE git_events SET id = 'commit:claude:toolu_q1', sha = NULL, subject = NULL").run();

    await scan(db, testConfig(root), ID, { full: true });
    expect(gitEvents(db).map((e) => [e.id, e.sha, e.subject])).toEqual([["commit:/work/alpha:ce489b1", "ce489b1", "wip"]]);
  });

  test("a failed commit and a command that only mentions one make nothing", async () => {
    const { db } = await ingest([
      bash("c1", "2026-09-01T10:00:01.000Z", 'git commit -m "x"'),
      bashResult("c1", "2026-09-01T10:00:02.000Z", "nothing to commit, working tree clean", { error: true }),
      bash("c2", "2026-09-01T10:00:03.000Z", 'echo "git commit"'),
      bashResult("c2", "2026-09-01T10:00:04.000Z", "[main 9f8e7d6] looks like a commit"),
    ]);
    expect(gitEvents(db)).toEqual([]);
  });

  test("a throwaway repository, nothing to commit and a PR without a URL make nothing", async () => {
    const { db } = await ingest([
      bash("s1", "2026-09-01T10:00:01.000Z", 'tmp=$(mktemp -d) && git init -q "$tmp" && cd "$tmp" && git commit -q --allow-empty -m baseline'),
      bashResult("s1", "2026-09-01T10:00:02.000Z", ""),
      bash("s2", "2026-09-01T10:00:03.000Z", "cd /tmp/probe && git commit -m 'fix: example'"),
      bashResult("s2", "2026-09-01T10:00:04.000Z", "[main 5555555] fix: example\n 1 file changed"),
      bash("n1", "2026-09-01T10:00:05.000Z", "git commit -am wip || true"),
      bashResult("n1", "2026-09-01T10:00:06.000Z", "On branch main\nnothing to commit, working tree clean"),
      bash("w1", "2026-09-01T10:00:07.000Z", "gh pr create --web"),
      bashResult("w1", "2026-09-01T10:00:08.000Z", "Opening https://github.com/acme/app/compare/main...feature in your browser."),
    ]);
    expect(gitEvents(db)).toEqual([]);
  });

  test("one command that commits, pushes and opens a PR gives one commit and one PR", async () => {
    const { db } = await ingest([
      bash("b1", "2026-09-01T10:00:01.000Z", 'git add -A && git commit -m "Add docs" && git push -u origin feature && gh pr create --fill'),
      bashResult("b1", "2026-09-01T10:00:02.000Z", `[feature 2b3c4d5] Add docs\n 1 file changed\nTo github.com:acme/app.git\n${PR_URL}\n`),
    ]);
    expect(gitEvents(db).map((e) => [e.id, e.kind, e.branch, e.sha, e.url])).toEqual([
      ["commit:/work/alpha:2b3c4d5", "commit", "feature", "2b3c4d5", null],
      ["pr:github.com/acme/app#248", "pr", "main", null, PR_URL],
    ]);
  });

  test("a PR linked again and again, and opened by gh pr create, is one row", async () => {
    const { db } = await ingest([
      claudeUser("Open a PR", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      bash("p1", "2026-09-01T10:00:01.000Z", "gh pr create --fill"),
      bashResult("p1", "2026-09-01T10:00:02.000Z", `Creating pull request for feature into main\n\n${PR_URL}\n`),
      prLink("2026-09-01T10:00:03.000Z"),
      prLink("2026-09-01T10:05:00.000Z"),
    ]);
    const events = gitEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "pr", repo: "github.com/acme/app", number: 248, url: PR_URL, branch: "main", project: "/work/alpha", ts: Date.parse("2026-09-01T10:00:02.000Z") });
  });

  test("a pr-link alone takes the last cwd and branch logged", async () => {
    const { db } = await ingest([
      claudeUser("Hi", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      prLink("2026-09-01T10:00:03.000Z"),
      prLink("2026-09-01T10:00:04.000Z"),
    ]);
    const events = gitEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "pr:github.com/acme/app#248", project: "/work/alpha", branch: "main" });
  });
});

describe("Claude Code compactions", () => {
  test("stored with the session's model, an older record without postTokens too", async () => {
    const { db } = await ingest([
      claudeUser("Go", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:01.000Z", model: "claude-sonnet-5-5" }),
      boundary("b1", "2026-09-01T10:10:00.000Z", { trigger: "auto", preTokens: 160_000, durationMs: 30_000 }),
      boundary("b2", "2026-09-01T10:20:00.000Z", { trigger: "manual", preTokens: 120_000, postTokens: 8_000, durationMs: 25_000 }),
    ]);
    const rows = db.query<any, []>("SELECT * FROM compactions ORDER BY ts").all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: `claude:${CLAUDE_SESSION}:b1:compact`, model: "claude-sonnet-5-5", agent: "main", trigger: "auto", pre_tokens: 160_000, post_tokens: null, duration_ms: 30_000, project: "/work/alpha" });
    expect(rows[1]).toMatchObject({ trigger: "manual", pre_tokens: 120_000, post_tokens: 8_000 });
    expect(rows[0].cost_usd).toBeGreaterThan(0);
  });

  test("a subagent's compaction belongs to its agent", async () => {
    const root = tempDir();
    const subDir = join(root, ...PROJ, CLAUDE_SESSION, "subagents");
    writeJsonl(join(root, ...PROJ, `${CLAUDE_SESSION}.jsonl`), [claudeUser("Go", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" })]);
    writeJsonl(join(subDir, "agent-abc.jsonl"), [
      claudeAssistant({ id: "msg_sub", ts: "2026-09-01T10:00:06.000Z", sidechain: true, model: "claude-haiku-4-5-20251001" }),
      boundary("sb1", "2026-09-01T10:30:00.000Z", { trigger: "auto", preTokens: 150_000, postTokens: 5_000, durationMs: 20_000 }, true),
    ]);
    writeFileSync(join(subDir, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_agent" }));
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const rows = db.query<any, []>("SELECT * FROM compactions").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent: "Explore", model: "claude-haiku-4-5", session_id: `claude:${CLAUDE_SESSION}` });
  });

  test("a summary logged under the prompt it continues (mid-turn compaction) keeps that prompt", async () => {
    const records = [
      claudeUser("Refactor the parser", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z", promptId: "shared" }),
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:01.000Z" }),
      boundary("b1", "2026-09-01T10:10:00.000Z", { trigger: "auto", preTokens: 160_000, durationMs: 30_000 }),
      summary("u2", "2026-09-01T10:10:01.000Z", true, "shared"),
      claudeAssistant({ id: "msg_2", ts: "2026-09-01T10:10:05.000Z" }),
    ];
    const prompt = `claude:${CLAUDE_SESSION}:shared`;
    const promptIds = (db: ReturnType<typeof memDb>) => db.query<any, []>("SELECT id FROM prompts").all().map((p) => p.id);
    const usagePrompts = (db: ReturnType<typeof memDb>) => db.query<any, []>("SELECT id, prompt_id FROM usage ORDER BY id").all();
    const expected = [
      { id: "claude:msg_1", prompt_id: prompt },
      { id: "claude:msg_2", prompt_id: prompt },
    ];

    const { db, root } = await ingest(records);
    expect(promptIds(db)).toEqual([prompt]);
    expect(usagePrompts(db)).toEqual(expected);

    // A database where the summary took its prompt with it: a full re-read brings the prompt back.
    db.query("DELETE FROM prompts WHERE id = ?").run(prompt);
    expect(promptIds(db)).toEqual([]);
    await scan(db, testConfig(root), ID, { full: true });
    expect(promptIds(db)).toEqual([prompt]);
    expect(usagePrompts(db)).toEqual(expected);
  });

  test("a compact summary is no prompt, and one stored as a prompt before goes on a re-read", async () => {
    const records = (flagged: boolean) => [
      claudeUser("Refactor the parser", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:01.000Z" }),
      boundary("b1", "2026-09-01T10:10:00.000Z", { trigger: "auto", preTokens: 160_000, durationMs: 30_000 }),
      summary("u2", "2026-09-01T10:10:01.000Z", flagged),
      claudeAssistant({ id: "msg_2", ts: "2026-09-01T10:10:05.000Z" }),
    ];
    const first = `claude:${CLAUDE_SESSION}:p-u1`;

    // Fresh: only the real prompt, and the reply after the summary belongs to it.
    const fresh = (await ingest(records(true))).db;
    expect(fresh.query<any, []>("SELECT id FROM prompts").all().map((p) => p.id)).toEqual([first]);
    expect(fresh.query<any, []>("SELECT prompt_id FROM usage WHERE id = 'claude:msg_2'").get().prompt_id).toBe(first);

    // A database that stored the summary as a prompt (as before): a full re-read removes it and moves its usage back.
    const { db, root } = await ingest(records(false));
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM prompts").get().n).toBe(2);
    expect(db.query<any, []>("SELECT prompt_id FROM usage WHERE id = 'claude:msg_2'").get().prompt_id).toBe(`claude:${CLAUDE_SESSION}:p-u2`);

    writeJsonl(join(root, ...PROJ, `${CLAUDE_SESSION}.jsonl`), records(true));
    await scan(db, testConfig(root), ID, { full: true });
    expect(db.query<any, []>("SELECT id FROM prompts").all().map((p) => p.id)).toEqual([first]);
    expect(db.query<any, []>("SELECT prompt_id FROM usage WHERE id = 'claude:msg_2'").get().prompt_id).toBe(first);
  });
});
