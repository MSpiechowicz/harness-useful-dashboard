export type Provider = "claude" | "codex" | "cursor" | "omp";

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
}

export interface IngestSink {
  session(s: SessionRecord): void;
  prompt(p: PromptRecord): void;
  usage(u: UsageRecord): void;
  tool(t: ToolRecord): void;
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

export function truncate(text: string | null | undefined, limit: number): string | null {
  if (!text || limit <= 0) return null;
  const t = text.trim();
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
