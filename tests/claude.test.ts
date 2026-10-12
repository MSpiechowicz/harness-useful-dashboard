import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentSkill, parseClaudePrompt } from "../src/core/ingest/claude.ts";
import { scan } from "../src/core/ingest/index.ts";
import { claudeAssistant, claudeToolResult, claudeUser, CLAUDE_SESSION, ID, memDb, tempDir, testConfig, writeJsonl } from "./helpers.ts";

describe("parseClaudePrompt", () => {
  test("plain text prompt", () => {
    expect(parseClaudePrompt("Fix the bug")).toEqual({ text: "Fix the bug", command: null });
  });
  test("text blocks are joined", () => {
    expect(parseClaudePrompt([{ type: "text", text: "a" }, { type: "text", text: "b" }])?.text).toBe("a\nb");
  });
  test("tool results are not prompts", () => {
    expect(parseClaudePrompt([{ type: "tool_result", content: "x" }])).toBeNull();
  });
  test("local command output and caveats are not prompts", () => {
    expect(parseClaudePrompt("<local-command-stdout>ok</local-command-stdout>")).toBeNull();
    expect(parseClaudePrompt("<local-command-caveat>x</local-command-caveat>")).toBeNull();
    expect(parseClaudePrompt("[Request interrupted by user]")).toBeNull();
  });
  test("slash commands are parsed with args", () => {
    const p = parseClaudePrompt("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 12</command-args>");
    expect(p).toEqual({ text: "/review PR 12", command: "review" });
  });
});

describe("agentSkill", () => {
  test("names the skill folder an agent's instructions point into, with its plugin", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "useful-skills" }));
    const brief = `${root}/claude/skills/us-check-security/references/brief.md`;
    expect(agentSkill([`Follow the brief from \`${brief}\` and its scope.`, "/other/skills/no/x"])).toBe("useful-skills:us-check-security");
  });
  test("a folder outside a plugin goes by its own name", () => {
    expect(agentSkill(["Read /nowhere/skills/lone/SKILL.md first."])).toBe("lone");
    expect(agentSkill(["Read C:\\nowhere\\skills\\lone\\SKILL.md first."])).toBe("lone");
  });
  test("only the agent's own instructions count, and none without a skill folder", () => {
    expect(agentSkill(["Search the code.", "/work/skills/x/a.md"])).toBeNull();
    expect(agentSkill(undefined)).toBeNull();
  });
});

describe("Claude Code ingest", () => {
  function setup() {
    const root = tempDir();
    const projDir = join(root, "claude", "projects", "-work-alpha");
    const file = join(projDir, `${CLAUDE_SESSION}.jsonl`);
    writeJsonl(file, [
      { type: "ai-title", sessionId: CLAUDE_SESSION, aiTitle: "Fix login" },
      claudeUser("Fix the login bug", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      // Same message id written once per content block, with growing output counts.
      claudeAssistant({ id: "msg_1", ts: "2026-09-01T10:00:01.000Z", usage: { output_tokens: 50, e5m: 500 }, content: [{ type: "thinking", thinking: "" }] }),
      claudeAssistant({
        id: "msg_1",
        ts: "2026-09-01T10:00:02.000Z",
        usage: { output_tokens: 120, e5m: 500 },
        content: [
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/alpha/src/login.ts" } },
          { type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "debugging" } },
        ],
      }),
      claudeToolResult({ uuid: "r1", ts: "2026-09-01T10:00:03.000Z" }),
      claudeAssistant({
        id: "msg_2",
        ts: "2026-09-01T10:00:04.000Z",
        usage: { output_tokens: 30, e1h: 2000 },
        content: [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { subagent_type: "Explore", prompt: "look" } }],
      }),
      claudeUser("<command-name>/clear</command-name>\n<command-args></command-args>", { uuid: "u2", ts: "2026-09-01T11:00:00.000Z" }),
      claudeUser("<command-name>/ship-it</command-name>\n<command-args>now</command-args>", { uuid: "u3", ts: "2026-09-01T11:01:00.000Z" }),
      claudeAssistant({ id: "msg_3", ts: "2026-09-01T11:01:05.000Z", model: "claude-sonnet-5-5", usage: { speed: "fast" } }),
      claudeUser("caveat", { uuid: "u4", ts: "2026-09-01T11:02:00.000Z", isMeta: true }),
    ]);
    // Subagent transcript + meta linking back to the Agent tool call.
    const subDir = join(projDir, CLAUDE_SESSION, "subagents");
    writeJsonl(join(subDir, "agent-abc.jsonl"), [
      claudeUser("look", { uuid: "s1", ts: "2026-09-01T10:00:05.000Z", sidechain: true }),
      claudeAssistant({ id: "msg_sub", ts: "2026-09-01T10:00:06.000Z", sidechain: true, model: "claude-haiku-4-5-20251001", content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } }] }),
    ]);
    writeFileSync(join(subDir, "agent-abc.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_agent" }));
    return { root, file };
  }

  test("dedupes streamed messages, attributes prompts, skills and subagents", async () => {
    const { root } = setup();
    const db = memDb();
    const res = await scan(db, testConfig(root), ID);
    expect(res.errors).toEqual([]);

    const usage = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    expect(usage.map((u) => u.id)).toEqual(["claude:msg_1", "claude:msg_2", "claude:msg_sub", "claude:msg_3"]);

    const m1 = usage[0];
    expect(m1.output_tokens).toBe(120); // max of the streamed copies
    expect(m1.cache_write_tokens).toBe(500);
    expect(m1.prompt_id).toBe(`claude:${CLAUDE_SESSION}:p-u1`);
    expect(m1.skill).toBeNull(); // skill applies after the Skill call

    const m2 = usage[1];
    expect(m2.skill).toBe("debugging");
    expect(m2.cache_write_1h_tokens).toBe(2000);
    expect(m2.cache_write_tokens).toBe(0);

    const sub = usage[2];
    expect(sub.is_subagent).toBe(1);
    expect(sub.agent).toBe("Explore");
    expect(sub.prompt_id).toBe(m1.prompt_id); // resolved via the spawning Agent tool call
    expect(sub.skill).toBe("debugging");

    const m3 = usage[3];
    expect(m3.skill).toBe("ship-it");
    expect(m3.speed).toBe("fast");

    const prompts = db.query<any, []>("SELECT * FROM prompts ORDER BY ts").all();
    expect(prompts.map((p) => p.text)).toEqual(["Fix the login bug", "/clear", "/ship-it now"]);
    expect(prompts[1].skill).toBeNull(); // built-in command
    expect(prompts[1].is_command).toBe(1);
    expect(prompts[2].skill).toBe("ship-it");

    const session = db.query<any, []>("SELECT * FROM sessions").get();
    expect(session.title).toBe("Fix login");
    expect(session.project).toBe("/work/alpha");
    expect(session.git_branch).toBe("main");
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM sessions").get().n).toBe(1);

    const tools = db.query<any, []>("SELECT tool, file_path, agent FROM tool_calls ORDER BY tool").all();
    expect(tools.map((t) => t.tool)).toEqual(["Agent", "Grep", "Read", "Skill"]);
    expect(tools.find((t) => t.tool === "Read").file_path).toBe("/work/alpha/src/login.ts");
    expect(tools.find((t) => t.tool === "Grep").agent).toBe("Explore");
  });

  test("a subagent's skill is the one its agent is built from, not its parent's", async () => {
    const { root } = setup();
    const plugin = join(root, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
    const subDir = join(root, "claude", "projects", "-work-alpha", CLAUDE_SESSION, "subagents");
    writeJsonl(join(subDir, "agent-abc.jsonl"), [
      { type: "attachment", sessionId: CLAUDE_SESSION, timestamp: "2026-09-01T10:00:05.000Z", isSidechain: true,
        attachment: { type: "prompt_snapshot", systemPrompt: [`Follow ${plugin}/skills/reviewing/brief.md.`, "Notes"] } },
      claudeUser("look", { uuid: "s1", ts: "2026-09-01T10:00:05.000Z", sidechain: true }),
      claudeAssistant({ id: "msg_sub", ts: "2026-09-01T10:00:06.000Z", sidechain: true, content: [{ type: "tool_use", id: "toolu_grep", name: "Grep", input: { pattern: "x" } }] }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT skill FROM usage WHERE id = 'claude:msg_sub'").get().skill).toBe("kit:reviewing");
    expect(db.query<any, []>("SELECT skill FROM tool_calls WHERE tool = 'Grep'").get().skill).toBe("kit:reviewing");
  });

  test("keeps fast mode when only a later streamed copy of a message reports it", async () => {
    const root = tempDir();
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Go", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "msg_f", ts: "2026-09-01T10:00:01.000Z", usage: { output_tokens: 100 } }),
      claudeAssistant({ id: "msg_f", ts: "2026-09-01T10:00:02.000Z", usage: { output_tokens: 100, speed: "fast" } }),
    ]);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    expect(db.query<any, []>("SELECT speed FROM usage").get().speed).toBe("fast");
  });

  test("rescanning is idempotent", async () => {
    const { root } = setup();
    const db = memDb();
    await scan(db, testConfig(root), ID);
    const before = db.query<any, []>("SELECT COUNT(*) AS n, SUM(cost_usd) AS c FROM usage").get();
    const again = await scan(db, testConfig(root), ID);
    expect(again.filesParsed).toBe(0);
    const full = await scan(db, testConfig(root), ID, { full: true });
    expect(full.filesParsed).toBeGreaterThan(0);
    const after = db.query<any, []>("SELECT COUNT(*) AS n, SUM(cost_usd) AS c FROM usage").get();
    expect(after).toEqual(before);
  });
});

describe("Claude Code time to first token", () => {
  const thinking = [{ type: "thinking", thinking: "", signature: "sig" }];
  const text = [{ type: "text", text: "Done" }];
  const toolUse = [{ type: "tool_use", id: "toolu_ls", name: "Bash", input: { command: "ls" } }];
  /** A line of a response as Claude Code logs it, with how long its thinking took when it reports that. */
  const line = (id: string, ts: string, content: unknown[], thinkingDurationMs?: number, sidechain = false) => ({
    ...claudeAssistant({ id, ts, content, sidechain }),
    ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
  });

  function setup() {
    const root = tempDir();
    const projDir = join(root, "claude", "projects", "-work-alpha");
    writeJsonl(join(projDir, `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      // Thinking first: 2.5 s to the thinking block's end, 1.3 s of it thinking.
      line("msg_think", "2026-09-01T10:00:02.500Z", thinking, 1300),
      line("msg_think", "2026-09-01T10:00:03.000Z", toolUse),
      claudeToolResult({ uuid: "r1", ts: "2026-09-01T10:00:10.000Z" }),
      line("msg_text", "2026-09-01T10:00:12.000Z", text),
      claudeToolResult({ uuid: "r2", ts: "2026-09-01T10:00:20.000Z" }),
      line("msg_tool", "2026-09-01T10:00:21.000Z", toolUse),
      claudeToolResult({ uuid: "r3", ts: "2026-09-01T10:00:30.000Z" }),
      // Thinking that took longer than the whole wait: no estimate.
      line("msg_negative", "2026-09-01T10:00:30.500Z", thinking, 900),
      claudeToolResult({ uuid: "r4", ts: "2026-09-01T10:00:40.000Z" }),
      line("msg_unmeasured", "2026-09-01T10:00:41.000Z", thinking),
      claudeToolResult({ uuid: "r5", ts: "2026-09-01T10:00:50.000Z" }),
      // Only a response's first line counts: a thinking line after its text gives nothing.
      line("msg_late", "2026-09-01T10:00:51.000Z", text),
      line("msg_late", "2026-09-01T10:00:52.000Z", thinking, 100),
    ]);
    writeJsonl(join(projDir, CLAUDE_SESSION, "subagents", "agent-ttft.jsonl"), [
      claudeUser("look", { uuid: "s1", ts: "2026-09-01T10:01:00.000Z", sidechain: true }),
      line("msg_sub", "2026-09-01T10:01:03.000Z", thinking, 2000, true),
      line("msg_sub", "2026-09-01T10:01:04.000Z", text, undefined, true),
    ]);
    return root;
  }

  const ttfts = (db: ReturnType<typeof memDb>) =>
    Object.fromEntries(db.query<{ usage_id: string; ttft_ms: number | null }, []>("SELECT usage_id, ttft_ms FROM response_meta").all().map((r) => [r.usage_id, r.ttft_ms]));

  test("is estimated only for a response whose first line is thinking with its duration", async () => {
    const db = memDb();
    const res = await scan(db, testConfig(setup()), ID);
    expect(res.errors).toEqual([]);
    expect(ttfts(db)).toEqual({
      "claude:msg_think": 1200,
      "claude:msg_text": null,
      "claude:msg_tool": null,
      "claude:msg_negative": null,
      "claude:msg_unmeasured": null,
      "claude:msg_late": null,
      "claude:msg_sub": 1000,
    });
  });

  test("a response split across two scans keeps its first line's estimate", async () => {
    const root = tempDir();
    const file = join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`);
    const first = [claudeUser("Fix it", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }), line("msg_think", "2026-09-01T10:00:02.500Z", thinking, 1300)];
    writeJsonl(file, first);
    const db = memDb();
    await scan(db, testConfig(root), ID);
    writeJsonl(file, [...first, line("msg_think", "2026-09-01T10:00:03.000Z", text)]);
    await scan(db, testConfig(root), ID);
    expect(ttfts(db)["claude:msg_think"]).toBe(1200);
  });

  test("a full rescan fills the estimate in on responses stored without one", async () => {
    const root = setup();
    const db = memDb();
    await scan(db, testConfig(root), ID);
    db.exec("UPDATE response_meta SET ttft_ms = NULL");
    await scan(db, testConfig(root), ID, { full: true });
    expect(ttfts(db)["claude:msg_think"]).toBe(1200);
    expect(ttfts(db)["claude:msg_sub"]).toBe(1000);
  });

  test("an update fills the estimate in on its first ordinary scan, once", async () => {
    const root = setup();
    const db = memDb();
    await scan(db, testConfig(root), ID);
    // The database as an earlier version left it: logs read to the end, no estimates, no record of the reread.
    db.exec("UPDATE response_meta SET ttft_ms = NULL");
    db.exec("DELETE FROM meta WHERE key LIKE 'reread.%'");

    const first = await scan(db, testConfig(root), ID);
    expect(first.filesParsed).toBeGreaterThan(0);
    expect(ttfts(db)["claude:msg_think"]).toBe(1200);
    expect(ttfts(db)["claude:msg_sub"]).toBe(1000);

    const second = await scan(db, testConfig(root), ID);
    expect(second.filesParsed).toBe(0);
  });
});
