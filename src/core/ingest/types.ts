import { redact } from "../redact.ts";

export type Provider = "claude" | "codex" | "cursor" | "omp" | "pi" | "opencode" | "zed" | "cline" | "roo" | "kilo" | "gemini" | "copilot";

export interface SessionRecord {
  id: string;
  provider: Provider;
  nativeId: string;
  project?: string | null;
  title?: string | null;
  gitBranch?: string | null;
  client?: string | null;
  clientVersion?: string | null;
  parentSessionId?: string | null;
  agent?: string | null;
  /** A subagent's brief: the first instruction its parent gave it. */
  brief?: string | null;
  startedAt?: number | null;
  endedAt?: number | null;
}

export interface PromptRecord {
  id: string;
  sessionId: string;
  provider: Provider;
  ts: number;
  text: string | null;
  skill: string | null;
  isCommand: boolean;
}

export interface UsageRecord {
  id: string;
  provider: Provider;
  sessionId: string;
  promptId: string | null;
  ts: number;
  project: string | null;
  model: string | null;
  skill: string | null;
  agent: string;
  isSubagent: boolean;
  spawnRef?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  speed?: string | null;
  /** Provider-reported cost; when set it is used instead of the price book. */
  costUsd?: number | null;
  /** The account or plan the call was billed through, when the harness says (e.g. "github-copilot"). */
  billing?: string | null;
  /** GitHub Copilot premium requests the call counted for. */
  premiumRequests?: number;
  /** Overrides the ingesting machine's identity (e.g. team CSV exports). */
  user?: string | null;
}

export interface ToolRecord {
  id: string;
  usageId: string | null;
  sessionId: string;
  promptId: string | null;
  provider: Provider;
  ts: number;
  project: string | null;
  tool: string;
  filePath: string | null;
  skill: string | null;
  agent: string;
  spawnRef?: string | null;
  /** A call that starts a subagent: what it asked of it (its short description, else the start of its prompt). */
  brief?: string | null;
  /** The model that made the call, when the harness says (else the model of its usage row). */
  model?: string | null;
  /**
   * An edit's lines added and removed, worked out from its input (ingest/lines.ts). A call over several files carries
   * them all on its first row. Null for calls that change no file.
   */
  linesAdded?: number | null;
  linesRemoved?: number | null;
}

/**
 * An edit's exact line counts, from the diff its result carries: they replace the count taken from its input. Null
 * for an edit that failed and so changed nothing, when its outcome is not keyed like the call (Codex).
 */
export interface EditLinesRecord {
  toolId: string;
  added: number | null;
  removed: number | null;
}

/** A plan-limit reading a harness logged: how much of a limit window was used and when it resets. */
export interface LimitRecord {
  provider: Provider;
  windowId: string;
  windowMinutes: number | null;
  usedPercent: number;
  /** Epoch ms. */
  resetsAt: number | null;
  plan: string | null;
  /** When it was read, epoch ms. */
  ts: number;
}

/**
 * Timing and settings of one model response, keyed by its usage row. A response streamed over several log lines
 * reports more than once: the earliest start and the latest end are kept.
 */
export interface ResponseMetaRecord {
  usageId: string;
  /** When the model got its input (exact, or the previous logged event), epoch ms. */
  startTs: number | null;
  /** When the response was done, epoch ms. */
  endTs: number | null;
  /** Time to the first token, when the harness measures it. */
  ttftMs?: number | null;
  /** Reasoning effort or thinking level the response ran at ("low", "high", …). */
  effort?: string | null;
  stopReason?: string | null;
}

/** How a tool call ended, a prompt the user interrupted, or a model request that failed (see apiErrors.ts). */
export type OutcomeKind = "tool_ok" | "tool_error" | "tool_rejected" | "interrupt" | "api_error";

export interface OutcomeRecord {
  id: string;
  provider: Provider;
  sessionId: string;
  ts: number;
  project: string | null;
  /** The model whose response led to it. */
  model: string | null;
  agent: string;
  /** Effort the model was running at. */
  effort?: string | null;
  kind: OutcomeKind;
  /** The tool, when the outcome is not keyed like its tool call (Codex): otherwise it is looked up by id. */
  tool?: string | null;
  /** Why a failed or rejected call failed (see failures.ts), its error text and what it was given. */
  reason?: string | null;
  detail?: string | null;
  input?: string | null;
  /** A failed model request's HTTP status, when the harness logged one. Its class is the reason, its message the detail. */
  status?: number | null;
}

export interface IngestSink {
  session(s: SessionRecord): void;
  prompt(p: PromptRecord): void;
  usage(u: UsageRecord): void;
  tool(t: ToolRecord): void;
  limit?(l: LimitRecord): void;
  responseMeta?(m: ResponseMetaRecord): void;
  outcome?(o: OutcomeRecord): void;
  editLines?(e: EditLinesRecord): void;
}

export interface FileContext {
  path: string;
  /** Byte offset of the first byte of the chunk within the file. */
  baseOffset: number;
  promptTextLimit: number;
}

export interface LineParser<S> {
  initialState(path: string): S;
  /** `lines` are complete JSONL lines with their byte offsets within the file. */
  parse(lines: { text: string; offset: number }[], ctx: FileContext, state: S, sink: IngestSink): S;
}

export function parseTs(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Text as it is stored: secrets in it replaced first (so a key cut in half can't slip through), then cut to the limit. */
export function truncate(text: string | null | undefined, limit: number): string | null {
  if (!text || limit <= 0) return null;
  const t = redact(text.trim());
  return t.length > limit ? t.slice(0, limit) + "…" : t;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Merges session fragments seen while parsing a chunk so each session is upserted once. */
export class SessionAccumulator {
  private map = new Map<string, SessionRecord>();

  touch(rec: SessionRecord, ts?: number | null): void {
    const cur = this.map.get(rec.id);
    if (!cur) {
      this.map.set(rec.id, { ...rec, startedAt: rec.startedAt ?? ts ?? null, endedAt: rec.endedAt ?? ts ?? null });
      return;
    }
    for (const [k, v] of Object.entries(rec) as [keyof SessionRecord, unknown][]) {
      if (v === undefined || v === null) continue;
      if (k === "title") cur.title = v as string; // latest title wins
      else if (cur[k] == null) (cur as unknown as Record<string, unknown>)[k] = v;
    }
    if (ts != null) {
      if (cur.startedAt == null || ts < cur.startedAt) cur.startedAt = ts;
      if (cur.endedAt == null || ts > cur.endedAt) cur.endedAt = ts;
    }
  }

  flush(sink: IngestSink): void {
    for (const s of this.map.values()) sink.session(s);
    this.map.clear();
  }
}
