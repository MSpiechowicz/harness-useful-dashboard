import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findCopilotChatFiles, ingestCopilotChatFile, MAX_CHAT_FILE_BYTES, REPLACE_SLACK_MS, replayChatSession, workspaceProject } from "../src/core/ingest/copilotChat.ts";
import { fileUsageId, isFileUsageId, otelUsageId, otelUsageIdIn, safePart, sessionId as chatSessionId, spanKey, toolId } from "../src/core/ingest/copilotChatIds.ts";
import { scan } from "../src/core/ingest/index.ts";
import type { IngestSink, PromptRecord, ResponseMetaRecord, ToolRecord, UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { ID, memDb, tempDir, testConfig } from "./helpers.ts";

const USER = join(import.meta.dir, "fixtures", "copilot-chat", "User");
const MAIN = "a3dd1178-eb84-45ab-8531-9af4c983e955";
const EMPTY_WINDOW = "9b2c4d6e-0000-4000-8000-0000000000a2";

const line = (o: unknown) => JSON.stringify(o);
const snapshot = (requests: unknown[] = [], extra: Record<string, unknown> = {}) => line({ kind: 0, v: { sessionId: "s1", requests, ...extra } });

describe("Copilot Chat session replay", () => {
  test("items are appended to a list, and created when it is missing", () => {
    const state = replayChatSession(
      [snapshot([{ requestId: "a" }]), line({ kind: 2, k: ["requests"], v: [{ requestId: "b" }, { requestId: "c" }] }), line({ kind: 2, k: ["extra"], v: [1] })].join("\n"),
    )!;
    expect(state.requests.map((r: any) => r.requestId)).toEqual(["a", "b", "c"]);
    expect(state.extra).toEqual([1]);
  });

  test("an append can cut the list back first: a message sent again replaces the last request, no items is a plain cut", () => {
    const requests = [{ requestId: "a" }, { requestId: "b" }, { requestId: "c" }];
    const edited = replayChatSession([snapshot(requests), line({ kind: 2, k: ["requests"], i: 2, v: [{ requestId: "c2" }, { requestId: "d" }] })].join("\n"))!;
    expect(edited.requests.map((r: any) => r.requestId)).toEqual(["a", "b", "c2", "d"]);

    const cut = replayChatSession([snapshot(requests), line({ kind: 2, k: ["requests"], i: 1 })].join("\n"))!;
    expect(cut.requests.map((r: any) => r.requestId)).toEqual(["a"]);

    // A cut past the end changes nothing, and one of a list that is not there creates nothing.
    const past = replayChatSession([snapshot(requests), line({ kind: 2, k: ["requests"], i: 9 }), line({ kind: 2, k: ["nothing"], i: 0 })].join("\n"))!;
    expect(past.requests).toHaveLength(3);
    expect(past.nothing).toBeUndefined();

    const bad = replayChatSession([snapshot(requests), line({ kind: 2, k: ["requests"], i: -1, v: [{ requestId: "x" }] }), line({ kind: 2, k: ["requests"], i: 1.5 })].join("\n"))!;
    expect(bad.requests.map((r: any) => r.requestId)).toEqual(["a", "b", "c", "x"]);
  });

  test("a value can be deleted: an object's key goes, a list's element is left undefined", () => {
    const state = replayChatSession(
      [
        snapshot([{ requestId: "a", result: { x: 1 } }, { requestId: "b" }], { customTitle: "T" }),
        line({ kind: 3, k: ["customTitle"] }),
        line({ kind: 3, k: ["requests", 0, "result"] }),
        line({ kind: 3, k: ["requests", 1] }),
        line({ kind: 3, k: ["requests", 9] }),
        line({ kind: 3, k: ["missing", "deeper"] }),
        line({ kind: 3, k: ["__proto__"] }),
      ].join("\n"),
    )!;
    expect("customTitle" in state).toBe(false);
    expect("result" in state.requests[0]).toBe(false);
    expect(state.requests).toHaveLength(2);
    expect(state.requests[1]).toBeUndefined();
  });

  test("a value is set at a path with numbers in it", () => {
    const state = replayChatSession(
      [
        snapshot([{ requestId: "a", result: null }, { requestId: "b" }]),
        line({ kind: 1, k: ["requests", 1, "completionTokens"], v: 95 }),
        line({ kind: 1, k: ["requests", 0, "result"], v: { metadata: { resolvedModel: "m" } } }),
        line({ kind: 1, k: ["customTitle"], v: "Title" }),
      ].join("\n"),
    )!;
    expect(state.requests[1].completionTokens).toBe(95);
    expect(state.requests[0].result.metadata.resolvedModel).toBe("m");
    expect(state.customTitle).toBe("Title");
  });

  test("a second snapshot replaces the state", () => {
    const state = replayChatSession([snapshot([{ requestId: "a" }]), line({ kind: 1, k: ["customTitle"], v: "Old" }), snapshot([{ requestId: "z" }])].join("\n"))!;
    expect(state.requests.map((r: any) => r.requestId)).toEqual(["z"]);
    expect(state.customTitle).toBeUndefined();
  });

  test("unknown kinds, a truncated last line and paths that do not fit are skipped", () => {
    const state = replayChatSession(
      [
        snapshot([{ requestId: "a" }]),
        line({ kind: 9, k: ["requests"], v: [{ requestId: "no" }] }),
        line({ kind: 1, k: ["requests", 7, "x", "y"], v: 1 }),
        line({ kind: 1, k: ["requests", "a", "x"], v: 1 }),
        line({ kind: 1, k: ["__proto__", "polluted"], v: 1 }),
        line({ kind: 1, k: [], v: 1 }),
        line({ kind: 1, k: [{ a: 1 }], v: 1 }),
        line({ kind: 2, k: ["requests"], v: "not a list" }),
        "not json at all",
        '{"kind":1,"k":["customTitle"],"v":"cut o',
      ].join("\n"),
    )!;
    expect(state.requests).toEqual([{ requestId: "a" }]);
    expect(state.customTitle).toBeUndefined();
    expect(({} as any).polluted).toBeUndefined();
  });

  test("a file without a snapshot has no state", () => {
    expect(replayChatSession(line({ kind: 1, k: ["customTitle"], v: "x" }))).toBeNull();
    expect(replayChatSession("")).toBeNull();
  });

  test("the empty-window fixture ends as its last whole line leaves it", () => {
    const text = readFileSync(join(USER, "globalStorage", "emptyWindowChatSessions", `${EMPTY_WINDOW}.jsonl`), "utf8");
    const state = replayChatSession(text)!;
    expect(state.customTitle).toBe("Final title");
    expect(state.requests.map((r: any) => [r.promptTokens, r.completionTokens])).toEqual([
      [2100, 310],
      [3300, 420],
      [4200, 95],
    ]);
  });
});

describe("Copilot Chat project of a window", () => {
  test("a local folder, a workspace file's folder, and no project for remote or missing", () => {
    expect(workspaceProject({ folder: "file:///home/dev/projects/demo" })).toBe("/home/dev/projects/demo");
    expect(workspaceProject({ folder: "file:///home/dev/my%20app" })).toBe("/home/dev/my app");
    expect(workspaceProject({ workspace: "file:///home/dev/w.code-workspace" })).toBe("/home/dev");
    expect(workspaceProject({ folder: "file:///c%3A/Users/me/app" })).toBe("C:\\Users\\me\\app");
    expect(workspaceProject({ folder: "vscode-remote://ssh-remote+box/home/dev/x" })).toBeNull();
    expect(workspaceProject({ workspace: "vscode-remote://ssh-remote+box/home/dev/w.code-workspace" })).toBeNull();
    expect(workspaceProject({})).toBeNull();
    expect(workspaceProject(null)).toBeNull();
  });

  test("files are found per folder, with the project of the window and none for the empty window", () => {
    const found = findCopilotChatFiles(USER).map((f) => [f.path.split("/").pop()!.replace(".jsonl", ""), f.project]);
    expect(found.sort()).toEqual(
      [
        [MAIN, "/home/dev/projects/demo"],
        ["5c3d7e8f-0000-4000-8000-0000000000b3", "/home/dev"],
        ["6d4e8f90-0000-4000-8000-0000000000c4", null],
        [EMPTY_WINDOW, null],
      ].sort(),
    );
  });

  test("a workspace.json that is no regular file, or is too big, gives no project and never blocks", () => {
    const user = join(tempDir(), "User");
    const window = (hash: string) => {
      const dir = join(user, "workspaceStorage", hash);
      mkdirSync(join(dir, "chatSessions"), { recursive: true });
      writeFileSync(join(dir, "chatSessions", `${hash}.jsonl`), snapshot() + "\n");
      return join(dir, "workspace.json");
    };
    writeFileSync(window("big"), `{"folder":"file:///work/p","pad":"${"x".repeat(70_000)}"}`);
    writeFileSync(window("ok"), '{"folder":"file:///work/p"}');
    mkdirSync(window("dir"), { recursive: true });

    if (process.platform !== "win32") {
      const fifo = window("fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    }

    const found = Object.fromEntries(findCopilotChatFiles(user).map((f) => [basename(f.path, ".jsonl"), f.project]));
    expect(found.ok).toBe("/work/p");
    expect(found.big).toBeNull();
    expect(found.dir).toBeNull();
    if (process.platform !== "win32") expect(found.fifo).toBeNull();
  });

  test("a missing or empty user folder has no files", () => {
    expect(findCopilotChatFiles(join(tempDir(), "nope"))).toEqual([]);
    expect(findCopilotChatFiles(tempDir())).toEqual([]);
  });
});

/** Collects what a reader writes. */
function recorder(covered?: IngestSink["covered"]) {
  const out = { usage: [] as UsageRecord[], tools: [] as ToolRecord[], prompts: [] as PromptRecord[], sessions: [] as any[], meta: [] as ResponseMetaRecord[], filled: [] as [string, string][], linked: [] as [string, string, number, number][], dropped: [] as string[], kept: [] as ReadonlySet<string>[] };
  const sink = {
    usage: (u: UsageRecord) => void out.usage.push(u),
    tool: (t: ToolRecord) => void out.tools.push(t),
    prompt: (p: PromptRecord) => void out.prompts.push(p),
    session: (s: any) => void out.sessions.push(s),
    responseMeta: (m: ResponseMetaRecord) => void out.meta.push(m),
    fillProject: (sessionId: string, project: string) => void out.filled.push([sessionId, project]),
    linkPrompt: (sessionId: string, promptId: string, from: number, to: number) => void out.linked.push([sessionId, promptId, from, to]),
    dropPartial: (usageId: string) => void out.dropped.push(usageId),
    dropRequests: (_sessionId: string, keep: ReadonlySet<string>) => void out.kept.push(keep),
    covered,
  } as unknown as IngestSink;
  return { out, sink };
}

const mainFile = () => findCopilotChatFiles(USER).find((f) => f.path.includes(MAIN))!;

describe("Copilot Chat ingest", () => {
  test("a request is one partial row with the last call's input, the whole output, and the model that answered", () => {
    const { out, sink } = recorder();
    expect(ingestCopilotChatFile(mainFile(), sink, { promptTextLimit: 2000 })).toBe(1);

    expect(out.usage).toHaveLength(1);
    expect(out.usage[0]).toMatchObject({
      id: `copilot-chat:${MAIN}:f:request_11111111-1111-4111-8111-111111111111`,
      provider: "copilot-chat",
      sessionId: `copilot-chat:${MAIN}`,
      ts: 1792745056581,
      input: 47570,
      output: 1148,
      cacheRead: 0,
      model: "gpt-6-luna",
      credits: 0.82134855,
      costUsd: null,
      billing: "github-copilot",
      partial: true,
      agent: "main",
      project: "/home/dev/projects/demo",
    });
    expect(out.sessions[0]).toMatchObject({ id: `copilot-chat:${MAIN}`, nativeId: MAIN, title: "Demo session", project: "/home/dev/projects/demo" });
  });

  test("a partial row has the interval of its request: its start and how long it took", () => {
    const { out, sink } = recorder();
    ingestCopilotChatFile(mainFile(), sink, { promptTextLimit: 2000 });
    expect(out.meta).toEqual([{ usageId: out.usage[0]!.id, startTs: 1792745056581, endTs: 1792745056581 + 31830 }]);
  });

  test("without a total time the interval ends at the last date the request has, else it has no end", () => {
    const dir = tempDir();
    const path = join(dir, "s.jsonl");
    const base = { promptTokens: 5, completionTokens: 1 };
    const requests = [
      { requestId: "r1", timestamp: 1000, ...base, result: { timings: { totalElapsed: -5 }, metadata: { toolCallRounds: [{ timestamp: 1500, toolCalls: [] }, { timestamp: 1800, toolCalls: [] }] } } },
      { requestId: "r2", timestamp: 2000, ...base, modelState: { completedAt: 2600 }, result: { metadata: { toolCallRounds: [{ timestamp: 2300, toolCalls: [] }] } } },
      { requestId: "r3", timestamp: 3000, ...base },
      { requestId: "r4", timestamp: 4000, ...base, result: { timings: { totalElapsed: 0 } } },
    ];
    writeFileSync(path, snapshot(requests) + "\n");
    const { out, sink } = recorder();
    ingestCopilotChatFile({ path, project: null }, sink, { promptTextLimit: 100 });
    expect(out.meta.map((m) => [m.startTs, m.endTs])).toEqual([
      [1000, 1800],
      [2000, 2600],
      [3000, null],
      [4000, 4000],
    ]);
  });

  test("a request already covered keeps its interval and prompt link, has no usage row, and loses any partial row left from before", () => {
    const { out, sink } = recorder(() => true);
    ingestCopilotChatFile(mainFile(), sink, { promptTextLimit: 2000 });

    const usageId = fileUsageId(MAIN, "request_11111111-1111-4111-8111-111111111111");
    expect(out.usage).toEqual([]);
    expect(out.tools).toEqual([]);
    expect(out.meta).toEqual([{ usageId, startTs: 1792745056581, endTs: 1792745056581 + 31830 }]);
    expect(out.dropped).toEqual([usageId]);
    expect(out.linked).toEqual([[`copilot-chat:${MAIN}`, `copilot-chat:${MAIN}:request_11111111-1111-4111-8111-111111111111`, 1792745056581, 1792745056581 + 31830 + REPLACE_SLACK_MS + 1]]);
  });

  test("the requests the file holds are told to the sink: what it read of others goes", () => {
    const { out, sink } = recorder();
    ingestCopilotChatFile(mainFile(), sink, { promptTextLimit: 2000 });
    expect([...out.kept[0]!]).toEqual(["request_11111111-1111-4111-8111-111111111111"]);
  });

  test("the session's project is filled into rows telemetry wrote before, none for a window without folder", () => {
    const main = recorder();
    ingestCopilotChatFile(mainFile(), main.sink, { promptTextLimit: 2000 });
    expect(main.out.filled).toEqual([[`copilot-chat:${MAIN}`, "/home/dev/projects/demo"]]);

    const empty = recorder();
    ingestCopilotChatFile(findCopilotChatFiles(USER).find((f) => f.path.includes(EMPTY_WINDOW))!, empty.sink, { promptTextLimit: 2000 });
    expect(empty.out.filled).toEqual([]);
  });

  test("tool calls come from the rounds, with the telemetry's call id and the file they touch", () => {
    const { out, sink } = recorder();
    ingestCopilotChatFile(mainFile(), sink, { promptTextLimit: 2000 });

    expect(out.tools).toHaveLength(7);
    for (const t of out.tools) {
      expect(t.id).toMatch(new RegExp(`^copilot-chat:${MAIN}:t:call_[A-Za-z0-9]+$`));
      expect(t.id).not.toContain("__vscode");
      expect(t).toMatchObject({ provider: "copilot-chat", usageId: out.usage[0]!.id });
    }
    expect(out.tools.map((t) => [t.tool, t.filePath])).toEqual([
      ...Array(5).fill(["read_file", "/home/dev/projects/demo/src/index.ts"]),
      ["apply_patch", null],
      ["run_in_terminal", null],
    ]);
    expect(out.tools[0]!.ts).toBe(1792745060510);
    expect(out.tools[0]!.id).toBe(`copilot-chat:${MAIN}:t:call_KfkfSL1XR4KygK1dBPCjktYK`);
  });

  test("an edit's file and lines are worked out from its arguments", () => {
    const dir = tempDir();
    const path = join(dir, "s.jsonl");
    const patch = "*** Begin Patch\n*** Update File: /w/a.ts\n@@\n-old\n+new\n+more\n*** End Patch";
    const calls = [
      { id: "c1", name: "apply_patch", arguments: JSON.stringify({ input: patch }) },
      { id: "c2", name: "replace_string_in_file", arguments: JSON.stringify({ filePath: "/w/b.ts", oldString: "a\nb", newString: "a\nc\nd" }) },
      { id: "c3", name: "create_file", arguments: JSON.stringify({ filePath: "/w/c.ts", content: "x\ny\n" }) },
      { id: "c4", name: "run_in_terminal", arguments: "not json" },
    ];
    writeFileSync(path, snapshot([{ requestId: "r1", timestamp: 1000, result: { metadata: { toolCallRounds: [{ timestamp: 1100, toolCalls: calls }] } } }]) + "\n");
    const { out, sink } = recorder();
    ingestCopilotChatFile({ path, project: null }, sink, { promptTextLimit: 100 });
    expect(out.tools.map((t) => [t.tool, t.filePath, t.linesAdded, t.linesRemoved])).toEqual([
      ["apply_patch", "/w/a.ts", 2, 1],
      ["replace_string_in_file", "/w/b.ts", 2, 1],
      ["create_file", "/w/c.ts", 2, 0],
      ["run_in_terminal", null, null, null],
    ]);
    expect(out.usage).toEqual([]);
  });

  test("a tool call without an id is keyed by its place in the request", () => {
    const dir = tempDir();
    const path = join(dir, "s.jsonl");
    const request = {
      requestId: "r1",
      timestamp: 1000,
      promptTokens: 5,
      result: { metadata: { toolCallRounds: [{ id: "x", timestamp: 1500, toolCalls: [{ id: "", name: "manage_todo_list", arguments: "{}" }] }] } },
    };
    writeFileSync(path, snapshot([request]) + "\n");
    const { out, sink } = recorder();
    ingestCopilotChatFile({ path, project: null }, sink, { promptTextLimit: 100 });
    expect(out.tools.map((t) => t.id)).toEqual(["copilot-chat:s1:t:f:r1:0:0"]);
  });

  test("the model falls back to the last round's, never the auto picker, and a request without tokens has no row", () => {
    const dir = tempDir();
    const path = join(dir, "s.jsonl");
    const requests = [
      { requestId: "r1", timestamp: 1000, modelId: "copilot/auto", promptTokens: 5, completionTokens: 1, result: { metadata: { toolCallRounds: [{ modelId: "copilot/auto", toolCalls: [] }, { modelId: "gpt-6-luna", toolCalls: [] }] } } },
      { requestId: "r2", timestamp: 2000, modelId: "copilot/auto", promptTokens: 5, completionTokens: 1, copilotCredits: -1 },
      { requestId: "r3", timestamp: 3000, promptTokens: 0, completionTokens: 0 },
    ];
    writeFileSync(path, snapshot(requests) + "\n");
    const { out, sink } = recorder();
    ingestCopilotChatFile({ path, project: null }, sink, { promptTextLimit: 100 });
    expect(out.usage.map((u) => [u.model, u.credits])).toEqual([
      ["gpt-6-luna", 0],
      [null, 0],
    ]);
  });

  test("prompt text follows the text limit, and is not stored at 0", () => {
    const stored = recorder();
    ingestCopilotChatFile(mainFile(), stored.sink, { promptTextLimit: 4 });
    expect(stored.out.prompts[0]!.text).toBe("Prom…");

    const none = recorder();
    ingestCopilotChatFile(mainFile(), none.sink, { promptTextLimit: 0 });
    expect(none.out.prompts).toHaveLength(1);
    expect(none.out.prompts[0]!.text).toBeNull();
    expect(none.out.sessions[0]!.title).toBeNull();
    expect(none.out.usage[0]!.promptId).toBe(none.out.prompts[0]!.id);
  });

  test("a request whose model calls are already read completely keeps its prompt but loses its partial row and tools", () => {
    const asked: [string, number, number][] = [];
    const { out, sink } = recorder((sessionId, from, to) => {
      asked.push([sessionId, from, to]);
      return from === 1792700200000;
    });
    const file = findCopilotChatFiles(USER).find((f) => f.path.includes(EMPTY_WINDOW))!;
    ingestCopilotChatFile(file, sink, { promptTextLimit: 2000 });

    // The window of each request ends at its own end (start plus total time, and what the telemetry runs over).
    const end = (start: number, elapsed: number) => start + elapsed + REPLACE_SLACK_MS + 1;
    expect(asked).toEqual([
      [`copilot-chat:${EMPTY_WINDOW}`, 1792700100000, end(1792700100000, 3000)],
      [`copilot-chat:${EMPTY_WINDOW}`, 1792700200000, end(1792700200000, 4000)],
      [`copilot-chat:${EMPTY_WINDOW}`, 1792700300000, end(1792700300000, 3000)],
    ]);
    expect(out.usage.map((u) => u.input)).toEqual([2100, 4200]);
    expect(out.tools).toEqual([]);
    expect(out.prompts).toHaveLength(3);
    expect(out.sessions).toHaveLength(1);
  });

  test("a session file over the size limit is an error", () => {
    // The limit is on size, so a sparse file stands in for a big one.
    const dir = tempDir();
    const path = join(dir, "big.jsonl");
    writeFileSync(path, "");
    truncateSync(path, MAX_CHAT_FILE_BYTES + 1);
    const { sink } = recorder();
    expect(() => ingestCopilotChatFile({ path, project: null }, sink, { promptTextLimit: 100 })).toThrow("too large");
  });
});

/** A scan over a copy of the fixtures' user folder. */
function scanSetup() {
  const root = tempDir();
  const user = join(root, "User");
  for (const f of findCopilotChatFiles(USER)) {
    const rel = f.path.slice(USER.length);
    mkdirSync(dirname(join(user, rel)), { recursive: true });
    copyFileSync(f.path, join(user, rel));
  }
  for (const hash of ["aaaa1111", "bbbb2222", "cccc3333"]) {
    copyFileSync(join(USER, "workspaceStorage", hash, "workspace.json"), join(user, "workspaceStorage", hash, "workspace.json"));
  }
  const cfg = (patch: { promptTextLimit?: number; enabled?: boolean; dirs?: string[] } = {}) => {
    const base = testConfig(root, { promptTextLimit: patch.promptTextLimit ?? 2000 });
    return { ...base, sources: { ...base.sources, copilotChatDirs: patch.dirs ?? [user], enabled: { ...base.sources.enabled, "copilot-chat": patch.enabled ?? true } } };
  };
  return { root, user, cfg };
}

describe("Copilot Chat scan", () => {
  test("the main session is read with its totals, tools and project", async () => {
    const { cfg } = scanSetup();
    const db = memDb();
    const res = await scan(db, cfg(), ID);
    expect(res.errors).toEqual([]);

    const rows = db.query<any, [string]>("SELECT * FROM usage WHERE session_id = ? AND provider = 'copilot-chat'").all(`copilot-chat:${MAIN}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input_tokens: 47570, output_tokens: 1148, cache_read_tokens: 0, model: "gpt-6-luna", credits: 0.82134855, partial: 1, project: "/home/dev/projects/demo", billing: "github-copilot", agent: "main" });
    expect(rows[0].cost_usd).toBeGreaterThanOrEqual(0);

    expect(db.query<any, [string]>("SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?").get(`copilot-chat:${MAIN}`)).toEqual({ n: 7 });
    const titles = db.query<any, []>("SELECT title FROM sessions WHERE provider = 'copilot-chat'").all().map((s) => s.title);
    expect(titles.sort()).toEqual(["Demo session", "Final title", "Remote session", "Workspace session"]);
  });

  test("an unchanged file is not read again, a changed one is", async () => {
    const { cfg, user } = scanSetup();
    const db = memDb();
    await scan(db, cfg(), ID);
    const count = () => db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get()!.n;
    const before = count();
    expect(before).toBeGreaterThan(0);

    const again = await scan(db, cfg(), ID);
    expect(again.filesParsed).toBe(0);
    expect(again.usageRows).toBe(0);
    expect(count()).toBe(before);

    const path = join(user, "workspaceStorage", "aaaa1111", "chatSessions", `${MAIN}.jsonl`);
    writeFileSync(path, readFileSync(path, "utf8") + line({ kind: 1, k: ["customTitle"], v: "Renamed" }) + "\n");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const changed = await scan(db, cfg(), ID);
    expect(changed.filesParsed).toBe(1);
    expect(count()).toBe(before);
    expect(db.query<any, [string]>("SELECT title FROM sessions WHERE id = ?").get(`copilot-chat:${MAIN}`)).toEqual({ title: "Renamed" });
  });

  test("a source that is off, or has no folder, reads nothing and reports no error", async () => {
    const { cfg, root } = scanSetup();
    const off = memDb();
    expect((await scan(off, cfg({ enabled: false }), ID)).errors).toEqual([]);
    expect(off.query<any, []>("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 0 });

    const missing = memDb();
    const res = await scan(missing, cfg({ dirs: [join(root, "nowhere", "User"), join(tempDir(), "User")] }), ID);
    expect(res.errors).toEqual([]);
    expect(missing.query<any, []>("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 0 });
  });

  test("prompt text is not stored when the limit is 0", async () => {
    const { cfg } = scanSetup();
    const db = memDb();
    await scan(db, cfg({ promptTextLimit: 0 }), ID);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM prompts WHERE provider = 'copilot-chat' AND text IS NOT NULL").get()).toEqual({ n: 0 });
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM prompts WHERE provider = 'copilot-chat'").get()!.n).toBeGreaterThan(0);
  });

  test("with the real writer, a request covered by a complete row loses its partial row and tools", () => {
    const db = memDb();
    const writer = new DbWriter(db, new PriceBook(), ID);
    const sessionId = `copilot-chat:${EMPTY_WINDOW}`;

    // A complete row inside the second request (it ran from 200000.. for 4 s).
    writer.usage({
      id: `${sessionId}:o:resp1`, provider: "copilot-chat", sessionId, promptId: null, ts: 1792700202000, project: null, model: "gpt-6-luna", skill: null, agent: "main", isSubagent: false,
      input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: null,
    });
    const file = findCopilotChatFiles(USER).find((f) => f.path.includes(EMPTY_WINDOW))!;
    ingestCopilotChatFile(file, writer, { promptTextLimit: 2000 });

    const ids = db.query<any, []>("SELECT id, partial FROM usage ORDER BY ts").all();
    expect(ids).toEqual([
      { id: `${sessionId}:f:request_e1000000-0000-4000-8000-000000000001`, partial: 1 },
      { id: `${sessionId}:o:resp1`, partial: 0 },
      { id: `${sessionId}:f:request_e3000000-0000-4000-8000-000000000003`, partial: 1 },
    ]);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 0 });
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM prompts").get()).toEqual({ n: 3 });
  });

  test("with the real writer, rows telemetry wrote before the file was read take the session's project", () => {
    const db = memDb();
    const writer = new DbWriter(db, new PriceBook(), ID);
    const sessionId = `copilot-chat:${MAIN}`;
    writer.session({ id: sessionId, provider: "copilot-chat", nativeId: MAIN, project: null });
    writer.usage({
      id: `${sessionId}:o:t:s`, provider: "copilot-chat", sessionId, promptId: null, ts: 1792745060500, project: null, model: "gpt-6-luna", skill: null, agent: "main", isSubagent: false,
      input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: null,
    });
    writer.tool({ id: `${sessionId}:t:x`, usageId: null, sessionId, promptId: null, provider: "copilot-chat", ts: 1792745060500, project: null, tool: "read_file", filePath: null, skill: null, agent: "main" });
    writer.usage({
      id: "copilot-chat:background:2026-10-23:o:t:s", provider: "copilot-chat", sessionId: "copilot-chat:background:2026-10-23", promptId: null, ts: 1792745060500, project: null, model: "gpt-4o-mini", skill: null,
      agent: "title", isSubagent: false, input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: null,
    });

    ingestCopilotChatFile(mainFile(), writer, { promptTextLimit: 2000 });

    const project = db.query<{ project: string }, []>("SELECT project FROM sessions WHERE id LIKE 'copilot-chat:a3dd%'").get()!.project;
    expect(project).toBeTruthy();
    expect(db.query("SELECT id, project FROM usage WHERE id LIKE '%:o:%' ORDER BY id").all()).toEqual([
      { id: `${sessionId}:o:t:s`, project },
      { id: "copilot-chat:background:2026-10-23:o:t:s", project: null },
    ]);
    expect(db.query("SELECT project FROM tool_calls WHERE id = ?").get(`${sessionId}:t:x`)).toEqual({ project });
  });
});

describe("Copilot Chat reader and its database", () => {
  const SID = "s1";
  const SESSION = chatSessionId(SID);
  const request = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
    requestId: id,
    timestamp: ts,
    promptTokens: 1000,
    completionTokens: 100,
    message: { text: `prompt ${id}` },
    result: { timings: { totalElapsed: 10_000 } },
    ...extra,
  });
  const setup = () => {
    const db = memDb();
    const writer = new DbWriter(db, new PriceBook(), ID);
    const path = join(tempDir(), `${SID}.jsonl`);
    const read = (lines: unknown[]) => {
      writeFileSync(path, lines.map((l) => line(l)).join("\n") + "\n");
      return ingestCopilotChatFile({ path, project: "/work/p" }, writer, { promptTextLimit: 2000 });
    };
    return { db, writer, read };
  };
  const snap = (requests: unknown[]) => ({ kind: 0, v: { sessionId: SID, requests } });
  const complete = (db: ReturnType<typeof memDb>, id: string, ts: number) =>
    new DbWriter(db, new PriceBook(), ID).usage({
      id, provider: "copilot-chat", sessionId: SESSION, promptId: null, ts, project: null, model: "gpt-6-luna", skill: null, agent: "main", isSubagent: false,
      input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, costUsd: null,
    });

  test("a request that is no longer in the file loses its partial row, interval, tool calls and unused prompt", () => {
    const { db, read } = setup();
    const call = (name: string, id: string) => ({ id, name, arguments: "{}" });
    read([
      snap([
        request("r1", 1_000_000, { result: { timings: { totalElapsed: 10_000 }, metadata: { toolCallRounds: [{ timestamp: 1_001_000, toolCalls: [call("a", "c1__vscode-1")] }] } } }),
        request("r2", 2_000_000, { result: { timings: { totalElapsed: 10_000 }, metadata: { toolCallRounds: [{ timestamp: 2_001_000, toolCalls: [call("b", "")] }] } } }),
      ]),
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM tool_calls").get()).toEqual({ n: 2 });

    // The last message is sent again: the list is cut back to one request and a new one added.
    read([snap([request("r1", 1_000_000), request("r2", 2_000_000)]), { kind: 2, k: ["requests"], i: 1, v: [request("r3", 3_000_000)] }]);

    expect(db.query("SELECT id FROM usage ORDER BY ts").all()).toEqual([{ id: fileUsageId(SID, "r1") }, { id: fileUsageId(SID, "r3") }]);
    expect(db.query("SELECT usage_id FROM response_meta ORDER BY start_ts").all()).toEqual([{ usage_id: fileUsageId(SID, "r1") }, { usage_id: fileUsageId(SID, "r3") }]);
    expect(db.query("SELECT id FROM prompts ORDER BY ts").all()).toEqual([{ id: `${SESSION}:r1` }, { id: `${SESSION}:r3` }]);
    // The call without an id, keyed by its place in r2, goes. Calls with an id are shared with the telemetry's: they stay.
    expect(db.query("SELECT id FROM tool_calls ORDER BY id").all()).toEqual([{ id: `${SESSION}:t:c1` }]);
  });

  test("a request the telemetry covers loses its tool calls without an id, and their outcomes: the telemetry has them by span", () => {
    const { db, read } = setup();
    const withTools = (id: string, ts: number) =>
      request(id, ts, { result: { timings: { totalElapsed: 10_000 }, metadata: { toolCallRounds: [{ timestamp: ts + 1_000, toolCalls: [{ id: "", name: "a", arguments: "{}" }, { id: "c1__vscode-1", name: "b", arguments: "{}" }] }] } } });
    read([snap([withTools("r1", 1_000_000), withTools("r2", 2_000_000)])]);
    // Both requests call "c1": one shared row.
    expect(db.query("SELECT id FROM tool_calls ORDER BY id").all()).toEqual([{ id: `${SESSION}:t:c1` }, { id: `${SESSION}:t:f:r1:0:0` }, { id: `${SESSION}:t:f:r2:0:0` }]);
    new DbWriter(db, new PriceBook(), ID).outcome({ id: `${SESSION}:t:f:r1:0:0`, provider: "copilot-chat", sessionId: SESSION, ts: 1_001_000, project: null, model: null, agent: "main", kind: "tool_ok" });

    // The telemetry covers r1 only.
    complete(db, `${SESSION}:o:a`, 1_004_000);
    read([snap([withTools("r1", 1_000_000), withTools("r2", 2_000_000)])]);

    expect(db.query("SELECT id FROM tool_calls ORDER BY id").all()).toEqual([{ id: `${SESSION}:t:c1` }, { id: `${SESSION}:t:f:r2:0:0` }]);
    expect(db.query("SELECT COUNT(*) AS n FROM outcomes").get()).toEqual({ n: 0 });
  });

  test("dropping a partial row removes only that request's tool calls without an id: not a longer request id, another session, call ids or span ids", () => {
    const { db } = setup();
    const w = new DbWriter(db, new PriceBook(), ID);
    const other = chatSessionId("s2");
    const tool = (sessionId: string, id: string) => {
      w.tool({ id, usageId: null, sessionId, promptId: null, provider: "copilot-chat", ts: 1_000, project: null, tool: "read_file", filePath: null, skill: null, agent: "main" });
      w.outcome({ id, provider: "copilot-chat", sessionId, ts: 1_000, project: null, model: null, agent: "main", kind: "tool_ok" });
    };

    const gone = [`${SESSION}:t:f:a:0:0`, `${SESSION}:t:f:a:1:3`];
    const stay = [`${SESSION}:t:f:ab:0:0`, `${SESSION}:t:f:b:0:0`, `${other}:t:f:a:0:0`, `${SESSION}:t:call_1`, `${SESSION}:t:s:${"a".repeat(32)}:${"b".repeat(16)}`];
    for (const id of gone) tool(SESSION, id);
    for (const id of stay) tool(id.startsWith(other) ? other : SESSION, id);
    expect(db.query("SELECT COUNT(*) AS n FROM outcomes").get()).toEqual({ n: 7 });

    w.dropPartial(fileUsageId(SID, "a"));

    const ids = (table: string) => db.query<{ id: string }, []>(`SELECT id FROM ${table} ORDER BY id`).all().map((r) => r.id);
    expect(ids("tool_calls")).toEqual([...stay].sort());
    expect(ids("outcomes")).toEqual([...stay].sort());
  });

  test("a vanished request's prompt stays when a row of the telemetry points to it", () => {
    const { db, read } = setup();
    read([snap([request("r1", 1_000_000), request("r2", 2_000_000)])]);
    complete(db, `${SESSION}:o:x`, 2_003_000);
    new DbWriter(db, new PriceBook(), ID).linkPrompt(SESSION, `${SESSION}:r2`, 2_000_000, 2_010_000);

    read([snap([request("r1", 1_000_000)])]);
    expect(db.query("SELECT id FROM prompts ORDER BY ts").all()).toEqual([{ id: `${SESSION}:r1` }, { id: `${SESSION}:r2` }]);
    expect(db.query("SELECT id FROM usage WHERE partial = 0").all()).toEqual([{ id: `${SESSION}:o:x` }]);
    expect(db.query("SELECT id FROM usage WHERE partial = 1").all()).toEqual([{ id: fileUsageId(SID, "r1") }]);
  });

  test("a cut to no request at all leaves no partial row", () => {
    const { db, read } = setup();
    read([snap([request("r1", 1_000_000)])]);
    read([snap([request("r1", 1_000_000)]), { kind: 2, k: ["requests"], i: 0 }]);
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM prompts").get()).toEqual({ n: 0 });
  });

  test("a request just begun does not mark the last finished one as read by the telemetry", () => {
    const { db, read } = setup();
    // The telemetry of a new request (not in the file yet), well after r1 ended at 1_010_000.
    complete(db, `${SESSION}:o:new`, 1_500_000);

    read([snap([request("r1", 1_000_000)])]);
    expect(db.query("SELECT id FROM usage WHERE partial = 1").all()).toEqual([{ id: fileUsageId(SID, "r1") }]);

    // One that ran over the end by less than the slack still counts.
    complete(db, `${SESSION}:o:last`, 1_010_000 + REPLACE_SLACK_MS - 1);
    read([snap([request("r1", 1_000_000)])]);
    expect(db.query("SELECT COUNT(*) AS n FROM usage WHERE partial = 1").get()).toEqual({ n: 0 });
  });

  test("a stale partial row next to the telemetry's rows goes at the next reading, its interval stays", () => {
    const { db, read } = setup();
    read([snap([request("r1", 1_000_000)])]);
    complete(db, `${SESSION}:o:a`, 1_004_000);
    expect(db.query("SELECT COUNT(*) AS n FROM usage").get()).toEqual({ n: 2 });

    read([snap([request("r1", 1_000_000)])]);
    expect(db.query("SELECT id FROM usage").all()).toEqual([{ id: `${SESSION}:o:a` }]);
    expect(db.query("SELECT usage_id, start_ts, end_ts FROM response_meta").all()).toEqual([{ usage_id: fileUsageId(SID, "r1"), start_ts: 1_000_000, end_ts: 1_010_000 }]);
  });

  test("the prompt of a request is linked to the telemetry's rows and tool calls in its window, not to another request's", () => {
    const { db, read } = setup();
    complete(db, `${SESSION}:o:a`, 1_004_000);
    complete(db, `${SESSION}:o:b`, 2_004_000);
    complete(db, `${SESSION}:o:late`, 1_600_000);
    new DbWriter(db, new PriceBook(), ID).tool({ id: `${SESSION}:t:x`, usageId: null, sessionId: SESSION, promptId: null, provider: "copilot-chat", ts: 1_003_000, project: null, tool: "read_file", filePath: null, skill: null, agent: "main" });

    read([snap([request("r1", 1_000_000), request("r2", 2_000_000)])]);
    expect(db.query("SELECT id, prompt_id FROM usage WHERE partial = 0 ORDER BY ts").all()).toEqual([
      { id: `${SESSION}:o:a`, prompt_id: `${SESSION}:r1` },
      { id: `${SESSION}:o:late`, prompt_id: null },
      { id: `${SESSION}:o:b`, prompt_id: `${SESSION}:r2` },
    ]);
    expect(db.query("SELECT prompt_id FROM tool_calls").all()).toEqual([{ prompt_id: `${SESSION}:r1` }]);
  });

  test("ids from files and senders that hold colons or are long can't pose as other ids", () => {
    // A conversation "A:f:B" has a request "B:o:t:s": made of plain parts they would be the same id as one of the session "A".
    const odd = safePart("A:f:B");
    expect(odd).toMatch(/^h[0-9a-f]{32}$/);
    expect(safePart("A:f:B")).toBe(odd);
    expect(safePart("a3dd1178-eb84-45ab-8531-9af4c983e955")).toBe("a3dd1178-eb84-45ab-8531-9af4c983e955");
    expect(safePart("request_1-b")).toBe("request_1-b");
    expect(safePart("x".repeat(129))).toMatch(/^h[0-9a-f]{32}$/);
    expect(safePart("")).toMatch(/^h[0-9a-f]{32}$/);

    const fromFile = fileUsageId("A:f:B", "B:o:t:s");
    const fromTelemetry = otelUsageId("A", spanKey("B", "o:t:s"));
    const plainFile = fileUsageId("A", "B");
    expect(new Set([fromFile, fromTelemetry, plainFile, otelUsageId("A:f:B", spanKey("t", "s"))]).size).toBe(4);
    for (const id of [fromFile, plainFile]) expect(isFileUsageId(id)).toBe(true);
    expect(isFileUsageId(fromTelemetry)).toBe(false);
    expect(isFileUsageId(otelUsageId("A:f:B", spanKey("t", "s")))).toBe(false);

    // Both sources name the same session the same way, whatever the id holds.
    expect(chatSessionId("A:f:B")).toBe(`copilot-chat:${odd}`);
    expect(fileUsageId("A:f:B", "r")).toBe(`${chatSessionId("A:f:B")}:f:r`);
    expect(toolId("A:f:B", "c:1", "x")).toBe(`${chatSessionId("A:f:B")}:t:${safePart("c:1")}`);
    expect(otelUsageIdIn(chatSessionId("A:f:B"), spanKey("t", "s"))).toBe(otelUsageId("A:f:B", spanKey("t", "s")));
  });

  test("two long parts that share their start and length stay apart, and no part poses as another's hash", () => {
    const a = `${"x".repeat(5_000)}a${"y".repeat(100)}`;
    const b = `${"x".repeat(5_000)}b${"y".repeat(100)}`;
    expect(a.length).toBe(b.length);
    expect(safePart(a)).not.toBe(safePart(b));
    expect(safePart(a)).toBe(safePart(a));

    // A part that looks like a hash is hashed itself, so it can't be the hash of another part.
    const hashOfOdd = safePart("A:f:B");
    expect(hashOfOdd).toMatch(/^h[0-9a-f]{32}$/);
    expect(safePart(hashOfOdd)).not.toBe(hashOfOdd);
    expect(fileUsageId(hashOfOdd, "r")).not.toBe(fileUsageId("A:f:B", "r"));
    expect(chatSessionId(hashOfOdd)).not.toBe(chatSessionId("A:f:B"));
    expect(safePart("hello")).toBe("hello");
  });

  test("a session file with a colon in its ids is read to the same ids the telemetry will have", () => {
    const { db } = setup();
    const path = join(tempDir(), "x.jsonl");
    writeFileSync(path, line({ kind: 0, v: { sessionId: "A:f:B", requests: [request("B:o:t:s", 5_000)] } }) + "\n");
    new DbWriter(db, new PriceBook(), ID).session({ id: chatSessionId("A:f:B"), provider: "copilot-chat", nativeId: "A:f:B", project: null });
    ingestCopilotChatFile({ path, project: null }, new DbWriter(db, new PriceBook(), ID), { promptTextLimit: 100 });

    expect(db.query("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(db.query("SELECT id, session_id FROM usage").all()).toEqual([{ id: fileUsageId("A:f:B", "B:o:t:s"), session_id: chatSessionId("A:f:B") }]);
    expect(isFileUsageId(fileUsageId("A:f:B", "B:o:t:s"))).toBe(true);
  });
});

