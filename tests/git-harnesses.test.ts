import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../src/core/config.ts";
import { KILO } from "../src/core/ingest/cline.ts";
import { scan } from "../src/core/ingest/index.ts";
import { ingestOpencode } from "../src/core/ingest/opencode.ts";
import type { GitEventRecord, IngestSink } from "../src/core/ingest/types.ts";
import { codexMeta, codexTurn, ID, memDb, tempDir, testConfig, writeFileAt, writeJsonl } from "./helpers.ts";

/** Commits and pull requests that shell calls in Codex, omp, pi, OpenCode, Kilo 7 and Gemini CLI logs made. */

const COMMIT_OUT = "[feat/login 1a2b3c4] Fix the login redirect\n 2 files changed, 10 insertions(+), 3 deletions(-)\n";
const PR_OUT = "Creating pull request for feat/login into main in acme/app\n\nhttps://github.com/acme/app/pull/42\n";
/** One command that commits, pushes and opens a PR: both count. */
const SHIP = "git add -A && git commit -m 'Add docs' && git push -u origin feat/docs && gh pr create --fill";
const SHIP_OUT = "[feat/docs 2b3c4d5] Add docs\n 1 file changed\nTo github.com:acme/app.git\n * [new branch] feat/docs -> feat/docs\nhttps://github.com/acme/app/pull/43\n";
const T = Date.parse("2026-10-05T12:00:00.000Z");
/** Commands that make no commit or PR the session's project gets, with what they printed. */
const SCRATCH_GIT = "tmp=$(mktemp -d)\ngit init -q \"$tmp\"\ncd \"$tmp\"\ngit commit -q --allow-empty -m baseline";
const SCRATCH_CD = "cd /tmp/probe && git commit -m 'fix: example'";
const SCRATCH_CD_OUT = "[main 5555555] fix: example\n 1 file changed\n";
const NOTHING = "git commit -am wip || true";
const NOTHING_OUT = "On branch feat/login\nnothing to commit, working tree clean\n";
const PR_WEB = "gh pr create --web";
const PR_WEB_OUT = "Opening https://github.com/acme/app/compare/main...feat/login in your browser.\n";

async function gitEvents(root: string, patch: Partial<AppConfig> = {}) {
  const db = memDb();
  const res = await scan(db, testConfig(root, patch), ID);
  expect(res.errors).toEqual([]);
  return db.query<any, []>("SELECT id, kind, provider, session_id, project, agent, branch, sha, subject, repo, number, url FROM git_events ORDER BY id").all();
}

// ---- Codex -----------------------------------------------------------------

const rollout = (root: string) => join(root, "codex", "sessions", "2026", "10", "05", "rollout-git.jsonl");
const codexEvent = (payload: Record<string, unknown>, ts = "2026-10-05T12:00:05.000Z") => ({ timestamp: ts, type: "event_msg", payload });
const commandItem = (id: string, command: unknown, output: string, extra: Record<string, unknown> = {}) =>
  codexEvent({
    type: "item_completed",
    item: { type: "CommandExecution", id, command, cwd: "/work/beta", status: "completed", exit_code: 0, stdout: output, stderr: "", aggregated_output: output, ...extra },
  });

describe("Codex commits and PRs", () => {
  test("a commit with its sha and branch, a PR with its URL, both from one command, failed, echoed, throwaway and empty ones give nothing", async () => {
    const root = tempDir();
    writeJsonl(rollout(root), [
      { ...codexMeta("thread-g"), timestamp: "2026-10-05T12:00:00.000Z" },
      codexTurn("gpt-6", "2026-10-05T12:00:01.000Z"),
      commandItem("exec-1", ["/usr/bin/bash", "-lc", "git add -A && git commit -m 'Fix the login redirect'"], COMMIT_OUT),
      commandItem("exec-2", ["/usr/bin/bash", "-lc", "gh pr create --fill"], PR_OUT),
      // Failed: non-zero exit, or a failed item.
      commandItem("exec-3", ["/usr/bin/bash", "-lc", "git commit -m x && git push"], "[feat/login 9999999] x\nerror: failed to push", { status: "failed", exit_code: 1 }),
      commandItem("exec-4", ["/usr/bin/bash", "-lc", "git commit -m y"], "[feat/login 8888888] y\n", { exit_code: 128 }),
      // Not a commit: the words are only printed.
      commandItem("exec-5", ["/usr/bin/bash", "-lc", "echo git commit"], "[feat/login 7777777] not a commit\n"),
      // A commit whose output names none: one commit, keyed by its call, on the session's branch.
      commandItem("exec-6", "git commit -q -m 'Quiet'", ""),
      // None: a throwaway repository with and without a sha, nothing to commit, a PR without a URL.
      commandItem("exec-7", ["/usr/bin/bash", "-lc", SCRATCH_GIT], ""),
      commandItem("exec-8", ["/usr/bin/bash", "-lc", SCRATCH_CD], SCRATCH_CD_OUT),
      commandItem("exec-9", ["/usr/bin/bash", "-lc", NOTHING], NOTHING_OUT),
      commandItem("exec-10", ["/usr/bin/bash", "-lc", PR_WEB], PR_WEB_OUT),
      commandItem("exec-11", ["/usr/bin/bash", "-lc", SHIP], SHIP_OUT),
    ]);

    expect(await gitEvents(root)).toEqual([
      { id: "commit:/work/beta:1a2b3c4", kind: "commit", provider: "codex", session_id: "codex:thread-g", project: "/work/beta", agent: "main", branch: "feat/login", sha: "1a2b3c4", subject: "Fix the login redirect", repo: null, number: null, url: null },
      { id: "commit:/work/beta:2b3c4d5", kind: "commit", provider: "codex", session_id: "codex:thread-g", project: "/work/beta", agent: "main", branch: "feat/docs", sha: "2b3c4d5", subject: "Add docs", repo: null, number: null, url: null },
      { id: "commit:codex:thread-g:exec-6", kind: "commit", provider: "codex", session_id: "codex:thread-g", project: "/work/beta", agent: "main", branch: "dev", sha: null, subject: "Quiet", repo: null, number: null, url: null },
      { id: "pr:github.com/acme/app#42", kind: "pr", provider: "codex", session_id: "codex:thread-g", project: "/work/beta", agent: "main", branch: "dev", sha: null, subject: null, repo: "github.com/acme/app", number: 42, url: "https://github.com/acme/app/pull/42" },
      { id: "pr:github.com/acme/app#43", kind: "pr", provider: "codex", session_id: "codex:thread-g", project: "/work/beta", agent: "main", branch: "dev", sha: null, subject: null, repo: "github.com/acme/app", number: 43, url: "https://github.com/acme/app/pull/43" },
    ]);
  });

  test("older exec_command_end events, and no subject when no prompt text is kept", async () => {
    const root = tempDir();
    writeJsonl(rollout(root), [
      { ...codexMeta("thread-e"), timestamp: "2026-10-05T12:00:00.000Z" },
      codexEvent({ type: "exec_command_end", call_id: "call_1", command: ["bash", "-lc", "git commit -am 'Bump'"], exit_code: 0, stdout: "[main (root-commit) abcdef0] Bump\n", stderr: "", aggregated_output: "[main (root-commit) abcdef0] Bump\n" }),
      codexEvent({ type: "exec_command_end", call_id: "call_2", command: ["bash", "-lc", "git commit -m 'Nope'"], exit_code: 1, stdout: "nothing to commit, working tree clean\n", stderr: "" }),
    ]);

    expect((await gitEvents(root, { promptTextLimit: 0 })).map((e) => [e.id, e.branch, e.sha, e.subject])).toEqual([["commit:/work/beta:abcdef0", "main", "abcdef0", null]]);
  });
});

// ---- omp and pi --------------------------------------------------------------

const OMP_UUID = "01a0e876-219c-727f-a821-4f01fdcb0f55";
const PI_UUID = "0199b1a0-0000-7000-8000-00000000000a";
const piFamilyFile = (root: string, harness: "omp" | "pi", uuid: string) => join(root, harness, "sessions", "-work-alpha", `2026-10-05T12-00-00-000Z_${uuid}.jsonl`);

function piFamilyLog(uuid: string) {
  const at = (s: number) => new Date(T + s * 1000).toISOString();
  const bash = (id: string, command: string) => ({ type: "toolCall", id, name: "bash", arguments: { command, timeout: 30 } });
  const result = (id: string, text: string, isError = false, s = 3) => ({
    type: "message", id: `r-${id}`, timestamp: at(s), message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError },
  });
  return [
    { type: "session", version: 3, id: uuid, timestamp: at(0), cwd: "/work/alpha" },
    { type: "message", id: "u1", timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "Ship it" }] } },
    {
      type: "message",
      id: "a1",
      timestamp: at(2),
      message: {
        role: "assistant",
        content: [
          bash("c1", "git add -A\ngit commit -m \"$(cat <<'EOF'\nFix the login redirect\nEOF\n)\""),
          bash("c2", "git push -u origin feat/login && gh pr create --title Fix --body Body"),
          bash("c3", "git commit -m broken"),
          bash("c4", "echo git commit"),
          bash("c5", SCRATCH_GIT),
          bash("c6", SCRATCH_CD),
          bash("c7", NOTHING),
          bash("c8", PR_WEB),
          bash("c9", SHIP),
        ],
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
      },
    },
    result("c1", COMMIT_OUT),
    result("c2", `${PR_OUT}\n\nWall time: 3.65 seconds`),
    result("c3", "[feat/login 9999999] broken\nhook failed\n\nCommand exited with code 1", true),
    result("c4", "[feat/login 7777777] not a commit"),
    // None: a throwaway repository with and without a sha, nothing to commit, a PR without a URL.
    result("c5", ""),
    result("c6", SCRATCH_CD_OUT),
    result("c7", NOTHING_OUT),
    result("c8", PR_WEB_OUT),
    result("c9", SHIP_OUT),
  ];
}

describe("omp and pi commits and PRs", () => {
  test("a commit with its sha and branch, a PR with its URL, both from one command, failed, echoed, throwaway and empty ones give nothing", async () => {
    const root = tempDir();
    writeJsonl(piFamilyFile(root, "omp", OMP_UUID), piFamilyLog(OMP_UUID));

    const events = await gitEvents(root);
    expect(events.map((e) => [e.id, e.provider, e.session_id, e.branch, e.sha, e.subject, e.url])).toEqual([
      ["commit:/work/alpha:1a2b3c4", "omp", `omp:${OMP_UUID}`, "feat/login", "1a2b3c4", "Fix the login redirect", null],
      ["commit:/work/alpha:2b3c4d5", "omp", `omp:${OMP_UUID}`, "feat/docs", "2b3c4d5", "Add docs", null],
      ["pr:github.com/acme/app#42", "omp", `omp:${OMP_UUID}`, null, null, null, "https://github.com/acme/app/pull/42"],
      ["pr:github.com/acme/app#43", "omp", `omp:${OMP_UUID}`, null, null, null, "https://github.com/acme/app/pull/43"],
    ]);
  });

  test("the call is flagged from its command, so it works with no prompt text kept", async () => {
    const root = tempDir();
    writeJsonl(piFamilyFile(root, "pi", PI_UUID), piFamilyLog(PI_UUID));

    const events = await gitEvents(root, { promptTextLimit: 0 });
    expect(events.map((e) => [e.id, e.provider, e.session_id, e.subject, e.number])).toEqual([
      ["commit:/work/alpha:1a2b3c4", "pi", `pi:${PI_UUID}`, null, null],
      ["commit:/work/alpha:2b3c4d5", "pi", `pi:${PI_UUID}`, null, null],
      ["pr:github.com/acme/app#42", "pi", `pi:${PI_UUID}`, null, 42],
      ["pr:github.com/acme/app#43", "pi", `pi:${PI_UUID}`, null, 43],
    ]);
  });
});

// ---- OpenCode and Kilo 7 -----------------------------------------------------

function opencodeLike(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT,
                          agent TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.query("INSERT INTO session (id, project_id, directory, title, version, agent, time_created, time_updated) VALUES ('ses_g', 'p1', '/work/gamma', 'Ship', '1.18.30', 'build', ?, ?)").run(T, T + 60_000);
  db.query("INSERT INTO message VALUES ('msg_a', 'ses_g', ?, ?, ?)").run(
    T + 1000,
    T + 9000,
    JSON.stringify({ role: "assistant", modelID: "claude-sonnet-5-5", providerID: "anthropic", path: { cwd: "/work/gamma" }, time: { created: T + 1000, completed: T + 9000 } }),
  );
  const bash = (id: string, command: string, state: Record<string, unknown>) =>
    db.query("INSERT INTO part VALUES (?, 'msg_a', 'ses_g', ?, ?, ?)").run(id, T + 2000, T + 2000, JSON.stringify({
      type: "tool", callID: `call_${id}`, tool: "bash", state: { input: { command, description: "Run" }, time: { start: T + 2000, end: T + 3000 }, ...state },
    }));
  bash("p1", "git commit -m 'Fix the login redirect'", { status: "completed", output: COMMIT_OUT, metadata: { output: COMMIT_OUT, exit: 0 } });
  bash("p2", "gh pr create --fill", { status: "completed", output: PR_OUT, metadata: { output: PR_OUT, exit: 0 } });
  // Failed: bash completes with a non-zero exit, or the call errors.
  bash("p3", "git commit -m x", { status: "completed", output: "[feat/login 9999999] x\n", metadata: { exit: 1 } });
  bash("p4", "git commit -m y", { status: "error", error: "Command failed" });
  bash("p5", "echo git commit", { status: "completed", output: "[feat/login 7777777] z\n", metadata: { exit: 0 } });
  // None: a throwaway repository with and without a sha, nothing to commit, a PR without a URL.
  bash("p6", SCRATCH_GIT, { status: "completed", output: "", metadata: { exit: 0 } });
  bash("p7", SCRATCH_CD, { status: "completed", output: SCRATCH_CD_OUT, metadata: { exit: 0 } });
  bash("p8", NOTHING, { status: "completed", output: NOTHING_OUT, metadata: { exit: 0 } });
  bash("p9", PR_WEB, { status: "completed", output: PR_WEB_OUT, metadata: { exit: 0 } });
  db.close();
}

describe("OpenCode and Kilo 7 commits and PRs", () => {
  test("a commit with its sha and branch, a PR with its URL, failed, echoed, throwaway and empty ones give nothing", async () => {
    const root = tempDir();
    opencodeLike(join(root, "opencode", "opencode.db"));

    expect((await gitEvents(root)).map((e) => [e.id, e.provider, e.session_id, e.project, e.branch, e.sha, e.subject, e.repo, e.number])).toEqual([
      ["commit:/work/gamma:1a2b3c4", "opencode", "opencode:ses_g", "/work/gamma", "feat/login", "1a2b3c4", "Fix the login redirect", null, null],
      ["pr:github.com/acme/app#42", "opencode", "opencode:ses_g", "/work/gamma", null, null, null, "github.com/acme/app", 42],
    ]);
  });

  test("Kilo Code 7's database gives them under Kilo's ids", () => {
    const root = tempDir();
    const path = join(root, "kilo", "kilo.db");
    opencodeLike(path);
    const events: GitEventRecord[] = [];
    const sink: IngestSink = { session() {}, prompt() {}, usage() {}, tool() {}, gitEvent: (e) => events.push(e) };

    ingestOpencode(path, sink, { since: 0, promptTextLimit: 0, flavor: KILO });
    expect(events.map((e) => [e.kind, e.provider, e.sessionId, e.callId, e.sha ?? null, e.subject ?? null, e.url ?? null])).toEqual([
      ["commit", "kilo", "kilo:ses_g", "kilo:call_p1", "1a2b3c4", null, null],
      ["pr", "kilo", "kilo:ses_g", "kilo:call_p2", null, null, "https://github.com/acme/app/pull/42"],
    ]);
  });
});

// ---- Gemini CLI ----------------------------------------------------------------

const GEMINI_SID = "8f14e45f-ceea-4e7a-9b1c-2d3e4f5a6b7c";
const geminiDir = (root: string) => join(root, "gemini", "tmp", "my-app");

function shellCall(n: number, command: string, status: string, output: string) {
  const id = `run_shell_command-1759741209000-${n}`;
  const response = status === "success" ? { output } : { error: output };
  return { id, name: "run_shell_command", args: { command, description: "Run" }, status, timestamp: "2026-10-05T12:00:10.000Z", result: [{ functionResponse: { id, name: "run_shell_command", response } }] };
}

describe("Gemini CLI commits and PRs", () => {
  test("from run_shell_command results in both output formats, failed, echoed, throwaway and empty ones give nothing", async () => {
    const root = tempDir();
    writeFileAt(join(geminiDir(root), ".project_root"), "/home/u/my-app\n");
    const wrapped = (command: string, output: string, code: string) =>
      `Command: ${command}\nDirectory: (root)\nOutput: ${output}\nError: (none)\nExit Code: ${code}\nSignal: (none)\nBackground PIDs: (none)\nProcess Group PGID: 4242`;
    writeJsonl(join(geminiDir(root), "chats", "session-2026-10-05T12-00-8f14e45f.jsonl"), [
      { sessionId: GEMINI_SID, projectHash: "h", startTime: "2026-10-05T12:00:00.000Z" },
      { id: "m1", timestamp: "2026-10-05T12:00:05.000Z", type: "user", content: [{ text: "Ship it" }] },
      {
        id: "m2",
        timestamp: "2026-10-05T12:00:09.000Z",
        type: "gemini",
        content: "",
        model: "gemini-3.5-flash",
        toolCalls: [
          shellCall(1, "git commit -m 'Fix the login redirect'", "success", COMMIT_OUT),
          // The older format names the command first: a PR URL in it is not the PR's.
          shellCall(2, "gh pr create --fill --body 'see https://github.com/acme/app/pull/7'", "success", wrapped("gh pr create --fill --body 'see https://github.com/acme/app/pull/7'", PR_OUT.trimEnd(), "0")),
          // A non-zero exit still logs as success, newer versions add the code at the end.
          shellCall(3, "git commit -m x", "success", "[feat/login 9999999] x\nExit Code: 1"),
          shellCall(4, "git commit -m y", "success", wrapped("git commit -m y", "[feat/login 8888888] y", "1")),
          shellCall(5, "git commit -m z", "error", "Command exited with code 1"),
          shellCall(6, "echo git commit", "success", "[feat/login 7777777] not a commit"),
          // None: a throwaway repository with and without a sha, nothing to commit, a PR without a URL.
          shellCall(7, SCRATCH_GIT, "success", ""),
          shellCall(8, SCRATCH_CD, "success", SCRATCH_CD_OUT),
          shellCall(9, NOTHING, "success", wrapped(NOTHING, NOTHING_OUT.trimEnd(), "0")),
          shellCall(10, PR_WEB, "success", PR_WEB_OUT),
        ],
      },
    ]);

    expect((await gitEvents(root)).map((e) => [e.id, e.provider, e.session_id, e.project, e.branch, e.sha, e.subject, e.url])).toEqual([
      ["commit:/home/u/my-app:1a2b3c4", "gemini", `gemini:${GEMINI_SID}`, "/home/u/my-app", "feat/login", "1a2b3c4", "Fix the login redirect", null],
      ["pr:github.com/acme/app#42", "gemini", `gemini:${GEMINI_SID}`, "/home/u/my-app", null, null, null, "https://github.com/acme/app/pull/42"],
    ]);
  });
});
