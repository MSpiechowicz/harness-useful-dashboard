import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { branchDetail, branches, branchId } from "../src/core/branches.ts";
import { lines, linesSeries, sessionLines } from "../src/core/changes.ts";
import { clineEditLines } from "../src/core/ingest/cline.ts";
import { codexParser } from "../src/core/ingest/codex.ts";
import { copilotEditLines } from "../src/core/ingest/copilot.ts";
import { geminiEditLines, geminiParser } from "../src/core/ingest/gemini.ts";
import { scan } from "../src/core/ingest/index.ts";
import { countLines, diffLines, hunkLines, numberedDiffLines, patchLines, searchReplaceLines, unifiedDiffLines } from "../src/core/ingest/lines.ts";
import { ompParser, piEditLines } from "../src/core/ingest/omp.ts";
import { opencodeEditLines } from "../src/core/ingest/opencode.ts";
import type { EditLinesRecord, IngestSink, OutcomeRecord, ToolRecord } from "../src/core/ingest/types.ts";
import { trimDetail } from "../src/core/retention.ts";
import { claudeAssistant, claudeUser, CLAUDE_SESSION, codexMeta, codexTurn, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

describe("line counts", () => {
  test("a final newline ends the last line", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("")).toBe(0);
    expect(countLines(undefined)).toBe(0);
  });

  test("replaced text is diffed line by line, like git", () => {
    expect(diffLines("a\nb\nc\n", "a\nB\nc\n")).toEqual({ added: 1, removed: 1 });
    expect(diffLines("a\nc", "a\nb\nc")).toEqual({ added: 1, removed: 0 });
    expect(diffLines("x\ny\nz", "y")).toEqual({ added: 0, removed: 2 });
    expect(diffLines("", "one\ntwo")).toEqual({ added: 2, removed: 0 });
    // Lines moved around: only those out of order count.
    expect(diffLines("a\nb\nc\nd", "a\nc\nb\nd")).toEqual({ added: 1, removed: 1 });
  });

  test("a unified diff counts its changed lines, not its headers", () => {
    const diff = [
      "Index: src/a.ts",
      "===================================================================",
      "--- src/a.ts",
      "+++ src/a.ts",
      "@@ -1,3 +1,4 @@",
      " keep",
      "--- a removed line that looks like a header",
      "+added one",
      "+added two",
      " keep",
      "\\ No newline at end of file",
    ].join("\n");
    expect(unifiedDiffLines(diff)).toEqual({ added: 2, removed: 1 });
    // Codex's file changes: hunks only, no file headers.
    expect(unifiedDiffLines("@@ -6,3 +6,3 @@\n \n-old\n+new\n ctx\n")).toEqual({ added: 1, removed: 1 });
    expect(unifiedDiffLines(null)).toBeNull();
  });

  test("Claude Code's structured patch", () => {
    const hunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [" a", "-b", "+B", "+C", " d"] }];
    expect(hunkLines(hunks)).toEqual({ added: 2, removed: 1 });
    expect(hunkLines([])).toBeNull();
  });

  test("apply_patch, raw or escaped in a string", () => {
    const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+one\n+two\n*** Update File: src/old.ts\n@@ fn\n ctx\n-gone\n+here\n*** Delete File: src/dead.ts\n*** End Patch";
    expect(patchLines(patch)).toEqual({ added: 3, removed: 1 });
    // Codex's code mode: the patch is a JavaScript string, its line breaks still escaped.
    const js = `text(await tools.exec_command({cmd:"ls"}));\ntext(await tools.apply_patch(${JSON.stringify(patch)}));`;
    expect(patchLines(js)).toEqual({ added: 3, removed: 1 });
    expect(patchLines(JSON.stringify({ input: patch }))).toEqual({ added: 3, removed: 1 });
    expect(patchLines("no patch here")).toBeNull();
  });

  test("SEARCH/REPLACE blocks and numbered diffs", () => {
    const blocks = "------- SEARCH\nconst a = 1;\nconst b = 2;\n=======\nconst a = 1;\nconst b = 3;\nconst c = 4;\n+++++++ REPLACE\n";
    expect(searchReplaceLines(blocks)).toEqual({ added: 2, removed: 1 });
    expect(numberedDiffLines(" 149|keep\n-151|old\n+151|new\n+152|more\n 153|keep")).toEqual({ added: 2, removed: 1 });
  });

  test("each harness's edit tools", () => {
    expect(geminiEditLines("replace", { old_string: "a\nb", new_string: "a\nc\nd" })).toEqual({ added: 2, removed: 1 });
    expect(geminiEditLines("write_file", { content: "x\ny\n" })).toEqual({ added: 2, removed: 0 });
    expect(geminiEditLines("read_file", {})).toBeNull();
    expect(copilotEditLines("str_replace_editor", { command: "create", file_text: "1\n2\n3" })).toEqual({ added: 3, removed: 0 });
    expect(copilotEditLines("edit", { old_str: "a", new_str: "b" })).toEqual({ added: 1, removed: 1 });
    expect(copilotEditLines("view", {})).toBeNull();
    expect(clineEditLines("write_to_file", { content: "a\nb" })).toEqual({ added: 2, removed: 0 });
    expect(clineEditLines("replace_in_file", { diff: "------- SEARCH\nx\n=======\ny\n+++++++ REPLACE" })).toEqual({ added: 1, removed: 1 });
    // OpenCode counts its edits itself in newer versions, older ones carry the diff, the oldest only the input.
    expect(opencodeEditLines("edit", { oldString: "a", newString: "b" }, { filediff: { additions: 7, deletions: 3 } })).toEqual({ added: 7, removed: 3 });
    expect(opencodeEditLines("edit", { oldString: "a", newString: "b" }, { diff: "--- a\n+++ a\n@@ -1 +1,2 @@\n-a\n+b\n+c\n" })).toEqual({ added: 2, removed: 1 });
    expect(opencodeEditLines("edit", { oldString: "a", newString: "b\nc" }, {})).toEqual({ added: 2, removed: 1 });
    expect(opencodeEditLines("apply_patch", { patchText: "*** Begin Patch\n*** Add File: x\n+1\n*** End Patch" }, { files: [{ additions: 4, deletions: 1 }, { additions: 1, deletions: 0 }] })).toEqual({ added: 5, removed: 1 });
    expect(opencodeEditLines("read", {}, {})).toBeNull();
  });
});

/** Collects what a parser emits. */
function collect() {
  const tools: ToolRecord[] = [];
  const outcomes: OutcomeRecord[] = [];
  const edits: EditLinesRecord[] = [];
  const sink: IngestSink = {
    session() {},
    prompt() {},
    usage() {},
    tool: (t) => tools.push(t),
    outcome: (o) => outcomes.push(o),
    editLines: (e) => edits.push(e),
  };
  return { sink, tools, outcomes, edits };
}
const asLines = (records: unknown[]) => records.map((r, i) => ({ text: JSON.stringify(r), offset: i * 1000 }));
const ctx = (path: string) => ({ path, baseOffset: 0, promptTextLimit: 1000 });

describe("Codex edits", () => {
  test("apply_patch in code mode counts on the call's apply_patch row, a failed patch drops them", () => {
    const patch = "*** Begin Patch\n*** Update File: /work/beta/a.ts\n@@\n-old\n+new\n+more\n*** Update File: /work/beta/b.ts\n@@\n+b\n*** End Patch";
    const c = collect();
    const path = "/x/rollout-1.jsonl";
    codexParser.parse(
      asLines([
        codexMeta("t1"),
        codexTurn("gpt-6-sol"),
        {
          timestamp: "2026-09-01T10:00:05.000Z",
          type: "response_item",
          payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: `text(await tools.exec_command({cmd:"ls"}));\ntext(await tools.apply_patch(${JSON.stringify(patch)}));` },
        },
        { timestamp: "2026-09-01T10:00:06.000Z", type: "response_item", payload: { type: "function_call", call_id: "c2", name: "apply_patch", arguments: JSON.stringify({ input: patch }) } },
        { timestamp: "2026-09-01T10:00:07.000Z", type: "event_msg", payload: { type: "patch_apply_end", call_id: "c2", success: false, stderr: "patch did not apply" } },
      ]),
      ctx(path),
      codexParser.initialState(path),
      c.sink,
    );
    const row = (id: string) => c.tools.find((t) => t.id === id)!;
    expect(row("codex:t1:c1:0")).toMatchObject({ tool: "exec_command", linesAdded: null });
    expect(row("codex:t1:c1:1")).toMatchObject({ tool: "apply_patch", filePath: "/work/beta/a.ts", linesAdded: 3, linesRemoved: 1, model: "gpt-6-sol" });
    // The patch's second file is an edit of its own, with its lines on the first row.
    expect(row("codex:t1:c1:f0")).toMatchObject({ filePath: "/work/beta/b.ts", linesAdded: 0, linesRemoved: 0 });
    expect(row("codex:t1:c2:0")).toMatchObject({ linesAdded: 3, linesRemoved: 1 });
    expect(c.edits).toEqual([{ toolId: "codex:t1:c2:0", added: null, removed: null }]);
  });
});

describe("omp and pi edits", () => {
  test("a patch over two files counts its new lines, then the diff of each file it changed", () => {
    const c = collect();
    const path = "/o/sessions/-work-alpha/2026-09-28T14-40-51-100Z_01a0e876-219c-727f-a821-4f01fdcb0f55.jsonl";
    const msg = (id: string, ts: string, message: Record<string, unknown>) => ({ type: "message", id, timestamp: ts, message });
    const patch = "*** Begin Patch\n[src/a.rs#3E20]\nPUT 151.=153:\n+one\n+two\n[src/b.rs#11AA]\nPUT 4.=4:\n+three\n*** End Patch\n";
    ompParser.parse(
      asLines([
        { type: "session", version: 3, id: "01a0e876-219c-727f-a821-4f01fdcb0f55", timestamp: "2026-09-28T14:40:51.100Z", cwd: "/work/alpha" },
        msg("a1", "2026-09-28T14:43:22.000Z", {
          role: "assistant", provider: "openai-codex", model: "gpt-6-sol", usage: { input: 1, output: 1 },
          content: [
            { type: "toolCall", id: "call_e", name: "edit", arguments: { input: patch } },
            { type: "toolCall", id: "call_w", name: "write", arguments: { path: "xd://lsp", content: "{}" } },
          ],
        }),
        msg("t1", "2026-09-28T14:43:23.000Z", {
          role: "toolResult", toolCallId: "call_e", toolName: "edit", isError: false,
          details: { perFileResults: [{ path: "/work/alpha/src/a.rs", diff: " 150|x\n-151|a\n-152|b\n+151|one\n+152|two\n 153|y" }, { path: "/work/alpha/src/b.rs", op: "delete", diff: "", oldText: "1\n2\n" }] },
        }),
      ]),
      ctx(path),
      ompParser.initialState(path),
      c.sink,
    );
    const sid = "omp:01a0e876-219c-727f-a821-4f01fdcb0f55";
    expect(c.tools.find((t) => t.id === `${sid}:call_e`)).toMatchObject({ filePath: "src/a.rs", linesAdded: 3, linesRemoved: 0, model: "gpt-6-sol" });
    expect(c.tools.find((t) => t.id === `${sid}:call_e:f1`)).toMatchObject({ filePath: "src/b.rs", linesAdded: 0 });
    // A write to one of omp's own devices changes no file.
    expect(c.tools.find((t) => t.id === `${sid}:call_w`)).toMatchObject({ linesAdded: null });
    expect(c.edits).toEqual([{ toolId: `${sid}:call_e`, added: 2, removed: 4 }]);
    expect(piEditLines("edit", { path: "a", oldText: "x\ny", newText: "x\nz" })).toEqual({ added: 1, removed: 1 });
  });
});

describe("Gemini CLI edits", () => {
  test("a replace counts its arguments, then its result's diff stat", () => {
    const c = collect();
    const path = "/g/tmp/app/chats/session-1.jsonl";
    const call = (status: string, extra: Record<string, unknown> = {}) => ({
      id: "call-1", name: "replace", status, timestamp: "2026-10-06T09:00:02.000Z",
      args: { file_path: "/app/a.ts", old_string: "a", new_string: "b\nc" }, ...extra,
    });
    geminiParser.parse(
      asLines([
        { sessionId: "s1", projectHash: "h", startTime: "2026-10-06T09:00:00.000Z" },
        { id: "m1", type: "gemini", timestamp: "2026-10-06T09:00:01.000Z", model: "gemini-3-pro", content: "", toolCalls: [call("executing")] },
        {
          id: "m1", type: "gemini", timestamp: "2026-10-06T09:00:01.000Z", model: "gemini-3-pro", content: "",
          toolCalls: [call("success", { resultDisplay: { fileName: "a.ts", fileDiff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n", diffStat: { model_added_lines: 2, model_removed_lines: 1, user_added_lines: 0 } } })],
        },
      ]),
      ctx(path),
      geminiParser.initialState(path),
      c.sink,
    );
    expect(c.tools[0]).toMatchObject({ tool: "replace", linesAdded: 2, linesRemoved: 1, model: "gemini-3-pro" });
    expect(c.edits).toEqual([{ toolId: "gemini:s1:call-1", added: 2, removed: 1 }]);
  });
});

describe("lines changed, end to end", () => {
  const S = CLAUDE_SESSION;
  const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input });
  const result = (uuid: string, ts: string, id: string, extra: { isError?: boolean; toolUseResult?: unknown } = {}) => ({
    type: "user",
    uuid,
    timestamp: ts,
    sessionId: S,
    cwd: "/work/alpha",
    gitBranch: "feature/login",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: extra.isError ? "String to replace not found" : "ok", is_error: extra.isError }] },
    ...(extra.toolUseResult ? { toolUseResult: extra.toolUseResult } : {}),
  });

  async function setup() {
    const root = tempDir();
    const file = join(root, "claude", "projects", "-work-alpha", `${S}.jsonl`);
    const branch = (r: Record<string, unknown>) => ({ ...r, gitBranch: "feature/login" });
    writeJsonl(file, [
      branch(claudeUser("Fix the login bug", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" })),
      branch(claudeAssistant({
        id: "msg_1",
        ts: "2026-09-01T10:00:01.000Z",
        content: [
          // replace_all: the input says one line, the result's patch that it changed three.
          tool("toolu_edit", "Edit", { file_path: "/work/alpha/src/login.ts", old_string: "var", new_string: "let", replace_all: true }),
          tool("toolu_write", "Write", { file_path: "/work/alpha/src/new.ts", content: "a\nb\nc\nd\n" }),
          tool("toolu_bad", "Edit", { file_path: "/work/alpha/src/login.ts", old_string: "nope", new_string: "x\ny" }),
          tool("toolu_multi", "MultiEdit", { file_path: "/work/alpha/src/util.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "c\nd" }] }),
          tool("toolu_read", "Read", { file_path: "/work/alpha/src/login.ts" }),
        ],
      })),
      branch(result("r1", "2026-09-01T10:00:02.000Z", "toolu_edit", {
        toolUseResult: {
          filePath: "/work/alpha/src/login.ts", oldString: "var", newString: "let", replaceAll: true,
          structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: ["-var a", "-var b", "-var c", "+let a", "+let b", "+let c"] }],
        },
      })),
      branch(result("r2", "2026-09-01T10:00:03.000Z", "toolu_write", { toolUseResult: { type: "create", filePath: "/work/alpha/src/new.ts", content: "a\nb\nc\nd\n", structuredPatch: [] } })),
      branch(result("r3", "2026-09-01T10:00:04.000Z", "toolu_bad", { isError: true })),
      branch(result("r4", "2026-09-01T10:00:05.000Z", "toolu_multi")),
      branch(result("r5", "2026-09-01T10:00:06.000Z", "toolu_read")),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    return { db, root };
  }
  const row = (db: ReturnType<typeof memDb>, id: string) =>
    db.query<{ lines_added: number | null; lines_removed: number | null; model: string | null }, [string]>("SELECT lines_added, lines_removed, model FROM tool_calls WHERE id = ?").get(id)!;

  test("an edit's result is exact, a failed edit changed nothing, a read is no edit", async () => {
    const { db } = await setup();
    expect(row(db, "claude:toolu_edit")).toEqual({ lines_added: 3, lines_removed: 3, model: "claude-opus-5-5" });
    expect(row(db, "claude:toolu_write")).toMatchObject({ lines_added: 4, lines_removed: 0 });
    expect(row(db, "claude:toolu_bad")).toMatchObject({ lines_added: null, lines_removed: null });
    expect(row(db, "claude:toolu_multi")).toMatchObject({ lines_added: 2, lines_removed: 1 });
    expect(row(db, "claude:toolu_read")).toMatchObject({ lines_added: null });
  });

  test("reading the logs again keeps the exact counts", async () => {
    const { db, root } = await setup();
    db.exec("DELETE FROM ingest_files");
    await scan(db, testConfig(root), ID);
    expect(row(db, "claude:toolu_edit")).toMatchObject({ lines_added: 3, lines_removed: 3 });
    expect(row(db, "claude:toolu_bad")).toMatchObject({ lines_added: null });
  });

  test("totals, splits, series, branches and the session add up with the cost", async () => {
    const { db } = await setup();
    const cost = db.query<{ c: number }, []>("SELECT SUM(cost_usd) AS c FROM usage").get()!.c;
    const all = lines(db, {}, "model");
    expect(all.total).toMatchObject({ added: 9, removed: 4, changed: 13, edits: 3, files: 3 });
    expect(all.total.costPer100).toBeCloseTo((cost / 13) * 100, 10);
    expect(all.rows).toEqual([expect.objectContaining({ key: "claude-opus-5-5", changed: 13, cost })]);
    expect(lines(db, { model: "gpt-6-sol" }).total).toMatchObject({ changed: 0, costPer100: null });
    expect(lines(db, {}, "project").rows[0]).toMatchObject({ key: "/work/alpha", label: "alpha" });

    const series = linesSeries(db, { from: Date.parse("2026-09-01T00:00:00Z"), to: Date.parse("2026-09-02T00:00:00Z") }, "day");
    expect(series.added.reduce((a, b) => a + b, 0)).toBe(9);
    expect(series.removed.reduce((a, b) => a + b, 0)).toBe(4);

    const b = branches(db, {}).rows.find((r) => r.branch === "feature/login")!;
    expect(b).toMatchObject({ added: 9, removed: 4 });
    const d = branchDetail(db, branchId("feature/login", "/work/alpha"));
    expect(d.lines).toMatchObject({ added: 9, removed: 4, files: 3 });
    expect(d.sessions[0]).toMatchObject({ added: 9, removed: 4 });
    expect(d.models[0]!.costPer100).toBeCloseTo((cost / 13) * 100, 10);

    expect(sessionLines(db, `claude:${S}`, 2.6)).toMatchObject({ added: 9, removed: 4, costPer100: 20 });
  });

  test("trimming old detail keeps the line counts", async () => {
    const { db } = await setup();
    await trimDetail(db, ID.host, 1, { now: Date.parse("2027-06-01T00:00:00Z"), pause: async () => {} });
    const r = db.query<{ file_path: string | null; lines_added: number }, []>("SELECT file_path, lines_added FROM tool_calls WHERE id = 'claude:toolu_write'").get()!;
    expect(r).toEqual({ file_path: null, lines_added: 4 });
  });
});
