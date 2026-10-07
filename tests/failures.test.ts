import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { friction } from "../src/core/friction.ts";
import { classifyFailure, errorSnippet, failureOf, inputSummary, storedReason } from "../src/core/failures.ts";
import { scan } from "../src/core/ingest/index.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries } from "../src/core/queries.ts";
import { CLAUDE_SESSION, claudeAssistant, claudeUser, codexMeta, codexUserMessage, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

describe("failure classes", () => {
  const cases: [string, string | null, string, string][] = [
    ["tool_error", "Bash", "Exit code 1\nls: cannot access 'x': No such file or directory", "not_found"],
    ["tool_error", "Bash", "Exit code 2\nls: nie ma dostępu do 'x': Nie ma takiego pliku ani katalogu", "not_found"],
    ["tool_error", "Read", "File does not exist. Note: your current working directory is /work.", "not_found"],
    ["tool_error", "read", "Path '/home/u/.omp/agent/extensions' not found", "not_found"],
    ["tool_error", "Edit", "<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>", "edit_mismatch"],
    ["tool_error", "Edit", "<tool_use_error>Found 2 matches of the string to replace, but replace_all is false.</tool_use_error>", "edit_mismatch"],
    ["tool_error", "edit", "`PUT 344.=344:` rejected: a selected boundary row is required", "edit_mismatch"],
    ["tool_error", "Write", "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>", "stale_read"],
    ["tool_error", "Edit", "<tool_use_error>File has been modified since read, either by the user or by a linter.</tool_use_error>", "stale_read"],
    ["tool_error", "Bash", "Exit code 1\nbash: ./deploy.sh: Permission denied", "permission"],
    ["tool_error", "Bash", "Permission for this action was denied by the Claude Code auto mode classifier.", "permission"],
    ["tool_error", "Bash", "<tool_use_error>Blocked: sleep 30 followed by: tail</tool_use_error>", "permission"],
    ["tool_error", "Bash", "Command timed out after 2m 0.0s", "timeout"],
    ["tool_error", "grep", "Grep timed out after 30s, narrow paths or pattern", "timeout"],
    ["tool_error", "Bash", "Exit code 1\nerror: 3 tests failed", "exit_code"],
    ["tool_error", "bash", "running 4 tests\nWall time: 0.4 seconds\n\nCommand exited with code 101", "exit_code"],
    ["tool_error", "Monitor", "<tool_use_error>InputValidationError: Monitor failed due to the following issue: missing required parameter</tool_use_error>", "bad_input"],
    ["tool_error", "yield", 'Section "findings" does not match schema: expected object', "bad_input"],
    ["tool_error", "mcp__chrome", "JavaScript execution error: TypeError: Cannot read properties of null", "other"],
    ["tool_error", null, "", "other"],
    ["tool_rejected", "Bash", "The user doesn't want to proceed with this tool use.", "rejected"],
  ];
  for (const [kind, tool, text, reason] of cases) {
    test(`${reason}: ${text.slice(0, 60)}`, () => expect(classifyFailure(kind, tool, text)).toBe(reason as never));
  }

  test("a command's long output is classified by its start and end, not what it printed in between", () => {
    const filler = Array.from({ length: 100 }, (_, i) => `  const value${i} = compute(${i});`).join("\n");
    const printed = `${filler}\n  if (status === 401) throw new Unauthorized("not found")\n${filler}`;
    expect(classifyFailure("tool_error", "Bash", `Exit code 1\n${printed}\nsed: -e expression #1: unterminated s command`)).toBe("exit_code");
    expect(classifyFailure("tool_error", "Bash", `Exit code 1\n${printed}\ncat: GOAL.md: No such file or directory`)).toBe("not_found");
  });

  test("outcomes read before classes existed get one from their kind", () => {
    expect(storedReason("tool_rejected", null)).toBe("rejected");
    expect(storedReason("tool_error", null)).toBe("other");
    expect(storedReason("tool_error", "not_found")).toBe("not_found");
    expect(storedReason("tool_error", "made-up")).toBe("other");
  });
});

describe("error snippets", () => {
  test("drops escape codes, blank lines and the exit-code line", () => {
    expect(errorSnippet("Exit code 1\n\n\x1b[31merror\x1b[0m: no such crate\r\n\n")).toBe("error: no such crate");
    expect(errorSnippet("Exit code 1")).toBe("Exit code 1");
    expect(errorSnippet("out\n\nWall time: 0.03 seconds\n\nCommand exited with code 1")).toBe("out");
  });

  test("long output starts at the first line that names an error, or else keeps its end", () => {
    const build = Array.from({ length: 80 }, (_, i) => `   Compiling crate-${i} v1.0.0`).join("\n");
    const failed = errorSnippet(`${build}\nerror[E0425]: cannot find value \`x\` in this scope\n --> src/main.rs:3:5`, 200)!;
    expect(failed.startsWith("error[E0425]: cannot find value")).toBe(true);
    const tail = errorSnippet(`${build}\nthe end`, 100)!;
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("the end")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(102);
  });

  test("secrets are replaced, and no text is kept when prompt text is not", () => {
    const key = ["sk", "ant", "api03", "x".repeat(40)].join("-");
    expect(errorSnippet(`Exit code 1\ncurl: 401 for key ${key}`)).toBe("curl: 401 for key [redacted]");
    expect(errorSnippet("boom", 0)).toBeNull();
    expect(failureOf("tool_error", "Bash", "Exit code 1\nls: x: No such file or directory", "ls x", 0)).toEqual({ reason: "not_found", detail: null, input: null });
    expect(failureOf("tool_ok", "Bash", "", "ls", 2000)).toEqual({ reason: null, detail: null, input: null });
  });

  test("an input summary is the command, else the file, pattern or address", () => {
    expect(inputSummary({ command: "bun   test\n --watch", description: "Run tests" })).toBe("bun test --watch");
    expect(inputSummary({ file_path: "/work/a.ts", old_string: "x", new_string: "y" })).toBe("/work/a.ts");
    expect(inputSummary({ content: "a whole file" })).toBeNull();
    expect(inputSummary({ command: "ls" }, 0)).toBeNull();
  });
});

const failures = (db: ReturnType<typeof memDb>) =>
  db.query<any, []>("SELECT id, kind, tool, reason, detail, input FROM outcomes WHERE kind <> 'tool_ok' ORDER BY id").all();

describe("failure details from the logs", () => {
  test("Claude Code: the error a tool result returned, with the command it ran", async () => {
    const root = tempDir();
    const result = (uuid: string, ts: string, id: string, text: string) => ({
      type: "user",
      uuid,
      timestamp: ts,
      sessionId: CLAUDE_SESSION,
      cwd: "/work/alpha",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: [{ type: "text", text }] }] },
    });
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({
        id: "msg_1",
        ts: "2026-09-01T10:00:05.000Z",
        content: [
          { type: "tool_use", id: "t_bash", name: "Bash", input: { command: "cat GOAL.md", description: "Read the goal" } },
          { type: "tool_use", id: "t_edit", name: "Edit", input: { file_path: "/work/alpha/a.ts", old_string: "x", new_string: "y" } },
        ],
      }),
      result("r1", "2026-09-01T10:00:06.000Z", "t_bash", "Exit code 1\ncat: GOAL.md: No such file or directory"),
      result("r2", "2026-09-01T10:00:07.000Z", "t_edit", "<tool_use_error>String to replace not found in file.\nString: x</tool_use_error>"),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(failures(db)).toEqual([
      { id: "claude:t_bash", kind: "tool_error", tool: "Bash", reason: "not_found", detail: "cat: GOAL.md: No such file or directory", input: "cat GOAL.md" },
      { id: "claude:t_edit", kind: "tool_error", tool: "Edit", reason: "edit_mismatch", detail: "String to replace not found in file.\nString: x", input: "/work/alpha/a.ts" },
    ]);

    // Shown in the friction view's reasons and recent failures, and in the Live view's activity.
    const fr = friction(db, {}, "day");
    expect(fr.reasons.map((r) => [r.reason, r.count, r.tools])).toEqual([
      ["edit_mismatch", 1, [{ tool: "Edit", count: 1 }]],
      ["not_found", 1, [{ tool: "Bash", count: 1 }]],
    ]);
    expect(fr.recent.map((r) => [r.tool, r.reason, r.input, r.sessionId])).toEqual([
      ["Edit", "edit_mismatch", "/work/alpha/a.ts", `claude:${CLAUDE_SESSION}`],
      ["Bash", "not_found", "cat GOAL.md", `claude:${CLAUDE_SESSION}`],
    ]);
    expect(fr.tools.find((t) => t.key === "Bash")?.topReason).toBe("not_found");
    const live = new Queries(db, () => new PriceBook()).live({}, 60, Date.parse("2026-09-01T10:05:00.000Z"));
    expect(live.feed.filter((e) => e.kind === "tool_error").map((e) => [e.tool, e.reason, e.detail])).toEqual([
      ["Edit", "edit_mismatch", "String to replace not found in file.\nString: x"],
      ["Bash", "not_found", "cat: GOAL.md: No such file or directory"],
    ]);
  });

  test("no error text or input when prompt text is not kept, the class still", async () => {
    const root = tempDir();
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:05.000Z", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] }),
      {
        type: "user",
        uuid: "r1",
        timestamp: "2026-09-01T10:00:06.000Z",
        sessionId: CLAUDE_SESSION,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Command timed out after 2m 0.0s" }] },
      },
    ]);
    const db = memDb();
    await scan(db, testConfig(root, { promptTextLimit: 0 }), ID);
    expect(failures(db)).toEqual([{ id: "claude:t1", kind: "tool_error", tool: "Bash", reason: "timeout", detail: null, input: null }]);
  });

  test("Codex: a failed command's exit code and output, a patch's and an MCP tool's error, and their tools", async () => {
    const root = tempDir();
    const ev = (ts: string, payload: Record<string, unknown>) => ({ timestamp: ts, type: "event_msg", payload });
    writeJsonl(join(root, "codex", "sessions", "2026", "09", "01", "rollout-f.jsonl"), [
      codexMeta("thread-f"),
      codexUserMessage("go", "item-1", "2026-09-01T10:00:02.000Z"),
      ev("2026-09-01T10:00:03.000Z", {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: "exec-1",
          status: "failed",
          command: ["/usr/bin/bash", "-lc", "pnpm add left-pad"],
          parsed_cmd: [{ type: "unknown", cmd: "pnpm add left-pad" }],
          stdout: "[ERR_SQLITE_ERROR] unable to open database file\n",
          stderr: "",
          aggregated_output: "[ERR_SQLITE_ERROR] unable to open database file\n",
          exit_code: 1,
        },
      }),
      ev("2026-09-01T10:00:04.000Z", {
        type: "item_completed",
        item: { type: "FileChange", id: "exec-2", status: "failed", changes: { "/work/b/x.ts": { type: "add" } }, stdout: "", stderr: "Failed to find expected lines in /work/b/x.ts:\nfoo\n" },
      }),
      ev("2026-09-01T10:00:05.000Z", {
        type: "item_completed",
        item: {
          type: "McpToolCall",
          id: "exec-3",
          status: "failed",
          server: "playwright",
          tool: "browser_navigate",
          arguments: { url: "http://localhost:5173" },
          result: { content: [{ type: "text", text: "### Error\nnet::ERR_CONNECTION_REFUSED" }], isError: true },
        },
      }),
      ev("2026-09-01T10:00:06.000Z", { type: "item_completed", item: { type: "CommandExecution", id: "exec-4", status: "completed", command: ["bash", "-lc", "ls"], exit_code: 0 } }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(failures(db)).toEqual([
      { id: "codex:thread-f:exec-1", kind: "tool_error", tool: "exec_command", reason: "exit_code", detail: "[ERR_SQLITE_ERROR] unable to open database file", input: "pnpm add left-pad" },
      { id: "codex:thread-f:exec-2", kind: "tool_error", tool: "apply_patch", reason: "edit_mismatch", detail: "Failed to find expected lines in /work/b/x.ts:\nfoo", input: "/work/b/x.ts" },
      { id: "codex:thread-f:exec-3", kind: "tool_error", tool: "mcp__playwright__browser_navigate", reason: "other", detail: "### Error\nnet::ERR_CONNECTION_REFUSED", input: "http://localhost:5173" },
    ]);
    // Calls that worked carry their tool too, so the friction view can put them to one.
    expect(db.query<{ tool: string }, []>("SELECT tool FROM outcomes WHERE id = 'codex:thread-f:exec-4'").get()?.tool).toBe("exec_command");
  });
});
