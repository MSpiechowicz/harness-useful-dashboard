import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AppConfig, defaultConfig } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";

export const ID = { user: "tester", host: "test-host" };

export function tempDir(prefix = "hd-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function memDb() {
  return openDb(":memory:");
}

export function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function testConfig(root: string, patch: Partial<AppConfig> = {}): AppConfig {
  const base = defaultConfig();
  return {
    ...base,
    sources: {
      claudeDirs: [join(root, "claude", "projects")],
      codexDirs: [join(root, "codex")],
      ompDirs: [join(root, "omp", "sessions")],
      piDirs: [join(root, "pi", "sessions")],
      opencodeDirs: [join(root, "opencode")],
      zedDirs: [join(root, "zed")],
      clineDirs: [join(root, "vscode", "globalStorage"), join(root, "cline")],
      rooDirs: [join(root, "vscode", "globalStorage")],
      kiloDirs: [join(root, "vscode", "globalStorage"), join(root, "kilo")],
      geminiDirs: [join(root, "gemini")],
      copilotDirs: [join(root, "copilot")],
      enabled: { claude: true, codex: true, omp: true, pi: true, opencode: true, zed: true, cline: true, roo: true, kilo: true, gemini: true, copilot: true },
    },
    ...patch,
  };
}

// ---- Claude Code transcript builders --------------------------------------

const SESSION = "11111111-2222-3333-4444-555555555555";

export function claudeUser(text: string, opts: { uuid: string; ts: string; promptId?: string; session?: string; sidechain?: boolean; isMeta?: boolean } ) {
  return {
    type: "user",
    uuid: opts.uuid,
    promptId: opts.promptId ?? `p-${opts.uuid}`,
    timestamp: opts.ts,
    sessionId: opts.session ?? SESSION,
    cwd: "/work/alpha",
    gitBranch: "main",
    version: "2.1.0",
    entrypoint: "cli",
    isSidechain: opts.sidechain ?? false,
    isMeta: opts.isMeta,
    message: { role: "user", content: text },
  };
}

export function claudeToolResult(opts: { uuid: string; ts: string; session?: string }) {
  return {
    type: "user",
    uuid: opts.uuid,
    timestamp: opts.ts,
    sessionId: opts.session ?? SESSION,
    cwd: "/work/alpha",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
  };
}

export function claudeAssistant(opts: {
  id: string;
  ts: string;
  model?: string;
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; e5m: number; e1h: number; speed: string }>;
  content?: unknown[];
  session?: string;
  sidechain?: boolean;
  uuid?: string;
}) {
  const u = opts.usage ?? {};
  return {
    type: "assistant",
    uuid: opts.uuid ?? `a-${opts.id}-${Math.random()}`,
    timestamp: opts.ts,
    sessionId: opts.session ?? SESSION,
    cwd: "/work/alpha",
    isSidechain: opts.sidechain ?? false,
    requestId: `req-${opts.id}`,
    message: {
      id: opts.id,
      model: opts.model ?? "claude-opus-5-5",
      content: opts.content ?? [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: u.input_tokens ?? 10,
        output_tokens: u.output_tokens ?? 100,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 1000,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? (u.e5m ?? 0) + (u.e1h ?? 0),
        ...(u.e5m !== undefined || u.e1h !== undefined ? { cache_creation: { ephemeral_5m_input_tokens: u.e5m ?? 0, ephemeral_1h_input_tokens: u.e1h ?? 0 } } : {}),
        ...(u.speed ? { speed: u.speed } : {}),
      },
    },
  };
}

export const CLAUDE_SESSION = SESSION;

// ---- Codex rollout builders ------------------------------------------------

export function codexMeta(id: string, opts: { cwd?: string; source?: unknown; ts?: string } = {}) {
  return {
    timestamp: opts.ts ?? "2026-09-01T10:00:00.000Z",
    type: "session_meta",
    payload: { id, timestamp: opts.ts ?? "2026-09-01T10:00:00.000Z", cwd: opts.cwd ?? "/work/beta", originator: "codex-tui", cli_version: "0.150.0", source: opts.source ?? "cli", git: { branch: "dev" } },
  };
}

export function codexTurn(model: string, ts = "2026-09-01T10:00:01.000Z") {
  return { timestamp: ts, type: "turn_context", payload: { model, cwd: "/work/beta" } };
}

export function codexUserMessage(text: string, id: string, ts = "2026-09-01T10:00:02.000Z", skill?: string) {
  return {
    timestamp: ts,
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "UserMessage", id, content: [{ type: "text", text }, ...(skill ? [{ type: "skill", name: skill, path: `/h/.codex/skills/${skill}/SKILL.md` }] : [])] } },
  };
}

export function codexTokenCount(total: number, last: { input: number; cached: number; output: number; reasoning?: number }, ordinal: number, ts = "2026-09-01T10:00:03.000Z") {
  const usage = (x: typeof last, t: number) => ({ input_tokens: x.input, cached_input_tokens: x.cached, output_tokens: x.output, reasoning_output_tokens: x.reasoning ?? 0, total_tokens: t });
  return {
    timestamp: ts,
    ordinal,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage(last, total), last_token_usage: usage(last, last.input + last.output) } },
  };
}

export function codexRecord(responseId: string, u: { input: number; cached: number; output: number }, ts = "2026-09-01T10:00:04.000Z") {
  return {
    timestamp: ts,
    type: "token_usage_record",
    payload: { response_id: responseId, usage: { input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: 0, output_tokens: u.output, reasoning_output_tokens: 0, total_tokens: u.input + u.output } },
  };
}

export function writeFileAt(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
