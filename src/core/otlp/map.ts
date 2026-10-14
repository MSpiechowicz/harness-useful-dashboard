import { createHash } from "node:crypto";
import {
  type OutcomeKind,
  type OutcomeRecord,
  type PromptRecord,
  type ResponseMetaRecord,
  SessionAccumulator,
  type SessionRecord,
  type ToolRecord,
  truncate,
  type UsageRecord,
} from "../ingest/types.ts";
import type { AttrValue, Attrs, OtlpBatch, OtlpLog, OtlpSpan } from "./model.ts";

/**
 * What remote agents export over OTLP, as the records a scan writes:
 * - Hermes (hermes-otel): each `api.<model>` span is one model call, `tool.<name>` a tool call, `subagent.<role>` a
 *   child session. Its `llm.<model>` spans total a turn's calls again, so they are never usage.
 * - Claude Code: its `api_request`, `tool_result` and `user_prompt` log events. Its spans (a beta) repeat the same calls
 *   and are skipped, and so are the logs of this machine, whose transcripts are read already.
 * - Any other GenAI span (gen_ai.* semantic conventions) of a chat or completion with token counts.
 * Text (prompts, briefs, paths) is kept only when the user lets it be, cut to the prompt text limit; message content
 * is never read. Every id is prefixed with `otlp:` and the credential it came with (`otlp:<credential>:`), so it never
 * meets one read from a transcript, and one sender can't overwrite another's rows by sending the same ids. Names are
 * cut to MAX_NAME characters, ids longer than MAX_ID hashed, and records with a time before 2015 or more than a day
 * ahead are left out. Token counts are whole numbers from 0 to MAX_TOKENS, and a reported cost outside 0 to MAX_COST
 * is not taken (the price book prices the call), so no sum of remote rows can overflow or go below zero.
 */

export interface MapContext {
  storeText: boolean;
  textLimit: number;
  /** The credential's label: the host and user of records whose resource names neither. */
  label: string;
  /** The credential's key (ingestAuth.ts): every id is namespaced with it. */
  credKey: string;
  /** This machine's host name. */
  localHost: string;
  /** Hosts that write rows of their own (scans, imports): a remote host named like one is told apart from it. */
  takenHosts?: string[];
  /** Hosts the credential sent records of before: records of further ones are skipped past MAX_HOSTS. */
  knownHosts?: ReadonlySet<string>;
  /** Now, epoch ms: records more than a day past it are left out. */
  now?: number;
}

/** The records of one remote machine and user, written by one DbWriter. */
export interface MappedGroup {
  host: string;
  user: string;
  sessions: SessionAccumulator;
  sessionIds: Set<string>;
  prompts: PromptRecord[];
  usage: UsageRecord[];
  tools: ToolRecord[];
  outcomes: OutcomeRecord[];
  meta: ResponseMetaRecord[];
}

/**
 * Why records were left out: of new hosts past MAX_HOSTS, of identities past MAX_IDENTITIES, with no time or one out
 * of range, or none to take (Claude Code spans, Claude Code logs from this machine, calls with no session).
 */
export type SkipReason = "hosts" | "identities" | "time" | "other";

export interface Mapped {
  groups: MappedGroup[];
  /** Records left out, and how many of them for each reason. */
  skipped: number;
  skippedFor: Partial<Record<SkipReason, number>>;
}

/** The most machines and users one request may carry records of: the records of further ones are skipped. */
export const MAX_IDENTITIES = 50;

/**
 * The most hosts one credential may send records of, over all its requests: the records of further ones are skipped.
 * This machine's jobs (trim, rollup) and the host lists go over every remote host.
 */
export const MAX_HOSTS = 200;

/** The most tokens of a kind one call may count: a real call has far fewer, and sums of rows this large fit SQLite's integers. */
export const MAX_TOKENS = 1_000_000_000;

/** The most a call's reported cost may be, in USD. */
export const MAX_COST = 1_000_000;

/** Names as stored (a model, tool, agent, project) are cut to this many characters. */
export const MAX_NAME = 512;

/** Ids longer than this are stored as a hash of themselves: the same on every replay. */
export const MAX_ID = 256;

/** Records before this time (epoch ms) or more than FUTURE_MS ahead are no real records. */
const MIN_TS = Date.UTC(2015, 0, 1);
const FUTURE_MS = 86_400_000;

// ---- Attribute values --------------------------------------------------------------------------------------------

const str = (v: AttrValue | undefined): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
};

/** A number, also when sent as a string (Claude Code sends its counts as strings). */
function num(v: AttrValue | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A token count: a whole number from 0 to MAX_TOKENS, 0 when it is none. */
const tokens = (v: AttrValue | undefined) => Math.min(MAX_TOKENS, Math.max(0, Math.round(num(v) ?? 0)));

/** A reported cost in USD, or null (the price book prices the call) when there is none or it is below 0 or past MAX_COST. */
function cost(v: AttrValue | undefined): number | null {
  const usd = num(v);
  return usd != null && usd >= 0 && usd <= MAX_COST ? usd : null;
}

const bool = (v: AttrValue | undefined): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

/** The first of the keys the attributes have. */
function first(a: Attrs, ...keys: string[]): AttrValue | undefined {
  for (const k of keys) if (a[k] != null) return a[k];
  return undefined;
}

/** The first `max` characters of a string, counted by code point, so a character like an emoji is never cut in half. */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;

  let end = 0;
  for (let n = 0; n < max && end < s.length; n++) end += s.codePointAt(end)! > 0xffff ? 2 : 1;
  return s.slice(0, end);
}

const sha = (...parts: unknown[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);

/** A model, tool, agent or project name as stored: at most MAX_NAME characters. */
const name = (v: AttrValue | undefined): string | null => {
  const s = str(v);
  return s == null ? null : cut(s, MAX_NAME);
};

/** An id as stored: one longer than MAX_ID is hashed. */
const idOf = (v: string): string => (v.length > MAX_ID ? `sha256:${sha(v)}` : v);

/** An attribute that is an id (a session, request or tool call), as stored. */
const ident = (v: AttrValue | undefined): string | null => {
  const s = str(v);
  return s == null ? null : idOf(s);
};

/** Attributes as text with their keys sorted: the same attributes give the same text, whatever order they came in. */
function canonical(v: AttrValue | undefined): string {
  if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString("base64")}`;
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// ---- Identity ----------------------------------------------------------------------------------------------------

/**
 * The characters of a name looked at: the rest is cut before NFKC, which can make one character eighteen (U+FDFA), so a
 * name of megabytes never takes long.
 */
const RAW_NAME = 1024;

/** Characters left out of a name: control, format (zero-width), line and paragraph separators, and any other invisible one. */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;

/** The most characters of a host or user name as stored. */
const CLEAN_NAME = 200;

/**
 * The start of a name with at most CLEAN_NAME characters that aren't whitespace, and the whitespace around them: all of
 * it that may be stored, however long NFKC made the name.
 */
const STORED_START = new RegExp(`^\\s*(?:\\S\\s*){0,${CLEAN_NAME}}`, "u");

/**
 * A host or user name as stored: its first RAW_NAME characters without control, format or line and paragraph separator
 * characters or others that are default-ignorable (variation selectors, Hangul fillers), in NFKC form, runs of
 * whitespace as one space, at most CLEAN_NAME characters, trimmed. The invisible characters go before NFKC, so what
 * they kept apart is composed ("e", a zero-width space, a combining acute: "é"). Cleaning a cleaned name again changes
 * nothing.
 */
export function cleanName(v: string | null | undefined): string {
  const normalized = cut(v ?? "", RAW_NAME).replace(UNSEEN, "").normalize("NFKC");
  const name = STORED_START.exec(normalized)![0].replace(/\s+/g, " ").trim();
  return cut(name, CLEAN_NAME).trim();
}

/** A cleaned host name as compared: lowercase, and its short name ("box" of "box.lan"). */
interface HostName {
  full: string;
  short: string;
}

function hostName(cleaned: string): HostName {
  const full = cleaned.toLowerCase();
  return { full, short: full.split(".")[0]! };
}

/** Whether two cleaned host names are the same machine: whatever their case, and also by their short names. */
function sameName(x: HostName, y: HostName): boolean {
  if (!x.full || !y.full) return false;
  if (x.full === y.full) return true;

  // An address (10.0.0.5) has no short name: its first number says nothing.
  if (/^\d+$/.test(x.short)) return false;
  return x.short === y.short;
}

/** Whether two host names are the same machine: cleaned, whatever their case, and also by their short names ("box" and "box.lan"). */
export function sameHost(a: string, b: string): boolean {
  return sameName(hostName(cleanName(a)), hostName(cleanName(b)));
}

const NON_ASCII = /[^\x00-\x7f]/g;

/**
 * Whether the name `x` only looks like `y` (both cleaned and lowercase): it has characters outside ASCII and is `y`
 * without them ("devbox⠀"), or with each of them in place of one of `y`'s and more of its characters as they are
 * ("devbоx", a Cyrillic о). Not every lookalike: Unicode's confusables are many more, this takes the common tricks.
 */
function looksLike(x: string, y: string): boolean {
  if (!y || !/[^\x00-\x7f]/.test(x)) return false;
  if (x.replace(NON_ASCII, "") === y) return true;

  const xs = [...x];
  const ys = [...y];
  if (xs.length !== ys.length) return false;

  let swapped = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === ys[i]) continue;
    if (xs[i]!.codePointAt(0)! <= 0x7f) return false;
    swapped++;
  }
  return swapped < xs.length - swapped;
}

/** Whether a remote host is to be told apart from host `y`: named like it (sameName), or only looking like it, whole or by short name. */
function resembles(x: HostName, y: HostName): boolean {
  return sameName(x, y) || looksLike(x.full, y.full) || looksLike(x.short, y.short);
}

type Identity = { host: string; user: string; local: boolean };

/**
 * The identities of one batch's resources (identityOf): this machine's and the taken hosts' names are cleaned once, and
 * each name a resource sends once however many resources send it.
 */
function identities(label: string, localHost: string, taken: string[] = []): (resource: Attrs) => Identity {
  const cleaned = new Map<string, string>();
  const clean = (v: string | null) => {
    if (v == null) return "";

    let name = cleaned.get(v);
    if (name === undefined) {
      name = cleanName(v);
      cleaned.set(v, name);
    }
    return name;
  };

  const fallback = cleanName(label) || "remote";
  const local = hostName(cleanName(localHost));
  const others = [local, ...taken.map((t) => hostName(cleanName(t)))];

  return (resource) => {
    const host = clean(str(resource["host.name"])) || fallback;
    const user = clean(str(resource["harness.user"])) || fallback;
    const name = hostName(host);
    const isLocal = sameName(name, local);
    const clash = isLocal || others.some((t) => resembles(name, t));
    return { host: clash ? `${host} (remote)` : host, user, local: isLocal };
  };
}

/**
 * The machine and user a resource's records are stamped with: its host.name and harness.user, else the credential's
 * label. A remote host named like this machine, or like a host that writes rows of its own (`taken`), or only looking
 * like one, is told apart from it ("<host> (remote)"), so neither this machine's jobs nor the one reading the
 * dashboard take that host's rows for the other's. `local` says it was named like this machine.
 */
export function identityOf(resource: Attrs, label: string, localHost: string, taken: string[] = []): Identity {
  return identities(label, localHost, taken)(resource);
}

// ---- Token counts ------------------------------------------------------------------------------------------------

/**
 * A call's tokens from gen_ai.usage.* (or OpenInference's llm.token_count.*). The input count includes the cache reads
 * and writes, which are counted apart here.
 */
function genAiTokens(a: Attrs) {
  const cacheRead = tokens(first(a, "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_read_input_tokens", "llm.token_count.prompt_details.cache_read"));
  const cacheWrite = tokens(
    first(a, "gen_ai.usage.cache_creation.input_tokens", "gen_ai.usage.cache_creation_input_tokens", "llm.token_count.prompt_details.cache_write"),
  );
  const prompt = tokens(first(a, "gen_ai.usage.input_tokens", "llm.token_count.prompt"));
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output: tokens(first(a, "gen_ai.usage.output_tokens", "llm.token_count.completion")),
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    reasoning: tokens(first(a, "gen_ai.usage.reasoning.output_tokens", "llm.token_count.completion_details.reasoning")),
  };
}

const hasTokens = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite > 0;

// ---- Mapping -----------------------------------------------------------------------------------------------------

/** GenAI operations that are a model call. */
const CALL_OPERATIONS = new Set(["chat", "text_completion", "generate_content"]);

/** Claude Code's log events this reads, with or without their `claude_code.` prefix. */
const CLAUDE_EVENTS = new Set(["api_request", "tool_result", "user_prompt"]);

function isHermes(s: OtlpSpan): boolean {
  if ((str(s.resource["service.name"]) ?? "").startsWith("hermes")) return true;
  if ((s.scope ?? "").startsWith("hermes")) return true;
  return Object.keys(s.attrs).some((k) => k.startsWith("hermes."));
}

function claudeEvent(l: OtlpLog): string | null {
  const raw = l.eventName ?? str(l.attrs["event.name"]) ?? str(l.body);
  const name = raw?.startsWith("claude_code.") ? raw.slice("claude_code.".length) : raw;
  return name && CLAUDE_EVENTS.has(name) ? name : null;
}

function toolOutcome(v: AttrValue | undefined): OutcomeKind | null {
  const s = str(v)?.toLowerCase();
  if (s === "ok" || s === "success" || s === "completed") return "tool_ok";
  if (s === "error" || s === "failed") return "tool_error";
  return null;
}

/** A resource's group, and whether it was named like this machine. */
type Hit = { group: MappedGroup; local: boolean };

export function mapBatch(batch: OtlpBatch, ctx: MapContext): Mapped {
  const groups = new Map<string, MappedGroup>();
  const byResource = new Map<Attrs, Hit | SkipReason>();
  const identityOfResource = identities(ctx.label, ctx.localHost, ctx.takenHosts);
  const ns = `otlp:${ctx.credKey}:`;
  const latest = (ctx.now ?? Date.now()) + FUTURE_MS;

  let skipped = 0;
  const skippedFor: Mapped["skippedFor"] = {};
  const skip = (reason: SkipReason) => {
    skipped++;
    skippedFor[reason] = (skippedFor[reason] ?? 0) + 1;
  };

  // The credential's hosts so far, and this request's new ones: a new one past MAX_HOSTS is no host of its own.
  const hosts = new Set(ctx.knownHosts);
  const hostTaken = (host: string) => {
    if (hosts.has(host)) return true;
    if (hosts.size >= MAX_HOSTS) return false;
    hosts.add(host);
    return true;
  };

  const refuse = (resource: Attrs, reason: SkipReason) => {
    byResource.set(resource, reason);
    return reason;
  };

  /** The group of a resource's records, made on first use, or why there is none: past MAX_IDENTITIES, or a new host past MAX_HOSTS. */
  const groupOf = (resource: Attrs): Hit | SkipReason => {
    const known = byResource.get(resource);
    if (known) return known;

    const id = identityOfResource(resource);
    const key = `${id.host}\u0000${id.user}`;
    let group = groups.get(key);
    if (!group && groups.size >= MAX_IDENTITIES) return refuse(resource, "identities");
    if (!group && !hostTaken(id.host)) return refuse(resource, "hosts");

    if (!group) {
      group = { host: id.host, user: id.user, sessions: new SessionAccumulator(), sessionIds: new Set(), prompts: [], usage: [], tools: [], outcomes: [], meta: [] };
      groups.set(key, group);
    }
    const hit = { group, local: id.local };
    byResource.set(resource, hit);
    return hit;
  };

  /** Whether each time a record has is a real one: none before 2015, none more than a day ahead. */
  const sane = (...times: (number | null)[]) => times.every((t) => t == null || (t >= MIN_TS && t <= latest));

  const touch = (g: MappedGroup, rec: SessionRecord, ...times: (number | null)[]) => {
    g.sessionIds.add(rec.id);
    const known = times.filter((t) => t != null);
    if (!known.length) g.sessions.touch(rec);
    for (const t of known) g.sessions.touch(rec, t);
  };

  const text = (v: AttrValue | undefined) => (ctx.storeText ? truncate(str(v), ctx.textLimit) : null);

  // ---- Spans ----

  const spanKey = (traceId: string, spanId: string) => `${idOf(traceId)}:${idOf(spanId)}`;

  // Hermes model calls in this batch, by trace and span: the tool calls under them belong to them.
  const apiSpans = new Set(batch.spans.filter((s) => s.name.startsWith("api.") && isHermes(s)).map((s) => spanKey(s.traceId, s.spanId)));

  for (const s of batch.spans) {
    if (str(s.resource["service.name"]) === "claude-code") {
      skip("other");
      continue;
    }

    const hit = groupOf(s.resource);
    if (typeof hit === "string") {
      skip(hit);
      continue;
    }
    if (!sane(s.startMs, s.endMs)) {
      skip("time");
      continue;
    }

    const g = hit.group;
    const project = name(s.resource["harness.project"]);
    const ts = s.endMs ?? s.startMs;
    const a = s.attrs;
    const traceId = idOf(s.traceId);

    if (isHermes(s)) {
      const named = ident(a["hermes.session_id"]) ?? ident(a["session.id"]);
      const native = named ?? traceId;
      const session: SessionRecord = { id: `${ns}hermes:${native}`, provider: "hermes", nativeId: native, project, clientVersion: name(s.resource["service.version"]) };
      const id = `${ns}hermes:${spanKey(s.traceId, s.spanId)}`;

      // A child session's own root span names its parent.
      const parent = ident(a["hermes.subagent.parent_session_id"]);
      if (a["hermes.session.is_subagent"] === true && parent) {
        session.parentSessionId = `${ns}hermes:${parent}`;
        session.agent = name(a["hermes.subagent.role"]) ?? "subagent";
      }

      // A turn's totals (llm.*) and failed requests are no call of their own. Spans that are neither a call, a tool
      // nor a subagent (the session root, skills) only tell when their session ran.
      if (s.name.startsWith("llm.") || s.name === "api.error") {
        if (named) touch(g, session, s.startMs, s.endMs);
        continue;
      }

      if (s.name.startsWith("api.")) {
        const t = genAiTokens(a);
        if (!hasTokens(t)) {
          if (named) touch(g, session, s.startMs, s.endMs);
          continue;
        }
        if (ts == null) {
          skip("time");
          continue;
        }

        touch(g, session, s.startMs, s.endMs);
        g.usage.push({
          id,
          provider: "hermes",
          sessionId: session.id,
          promptId: null,
          ts,
          project,
          model: name(a["gen_ai.response.model"]) ?? name(a["gen_ai.request.model"]) ?? name(a["llm.model_name"]) ?? name(s.name.slice("api.".length)),
          skill: null,
          agent: "main",
          isSubagent: false,
          ...t,
          costUsd: cost(a["hermes.cost.usage"]),
        });
        g.meta.push({ usageId: id, startTs: s.startMs, endTs: s.endMs, stopReason: name(a["llm.response.finish_reason"]) });
        continue;
      }

      if (s.name.startsWith("tool.")) {
        const start = s.startMs ?? s.endMs;
        if (start == null) {
          skip("time");
          continue;
        }

        touch(g, session, s.startMs, s.endMs);
        const parentCall = s.parentSpanId && apiSpans.has(spanKey(s.traceId, s.parentSpanId)) ? `${ns}hermes:${spanKey(s.traceId, s.parentSpanId)}` : null;
        g.tools.push({
          id,
          usageId: parentCall,
          sessionId: session.id,
          promptId: null,
          provider: "hermes",
          ts: start,
          project,
          tool: name(a["gen_ai.tool.name"]) ?? name(s.name.slice("tool.".length)) ?? "unknown",
          filePath: text(a["hermes.tool.target"]),
          skill: null,
          agent: "main",
        });
        const kind = toolOutcome(a["hermes.tool.outcome"]);
        if (kind) g.outcomes.push({ id, provider: "hermes", sessionId: session.id, ts: start, project, model: null, agent: "main", kind });
        continue;
      }

      if (s.name === "subagent" || s.name.startsWith("subagent.")) {
        touch(g, session, s.startMs, s.endMs);
        const child = ident(a["hermes.subagent.child_session_id"]);
        if (!child) continue;

        const role = name(a["hermes.subagent.role"]) ?? name(s.name.slice("subagent.".length));
        const childSession: SessionRecord = {
          id: `${ns}hermes:${child}`,
          provider: "hermes",
          nativeId: child,
          project,
          clientVersion: session.clientVersion,
          parentSessionId: `${ns}hermes:${parent ?? native}`,
          agent: role ?? "subagent",
          brief: text(a["hermes.subagent.goal"]),
        };
        touch(g, childSession, s.startMs);
        continue;
      }

      if (named) touch(g, session, s.startMs, s.endMs);
      continue;
    }

    // Any other agent's GenAI spans: a chat or completion with its token counts.
    const operation = str(a["gen_ai.operation.name"]);
    if (!operation || !CALL_OPERATIONS.has(operation)) continue;
    if (a["gen_ai.usage.input_tokens"] == null && a["gen_ai.usage.output_tokens"] == null) continue;

    const t = genAiTokens(a);
    if (!hasTokens(t)) continue;
    if (ts == null) {
      skip("time");
      continue;
    }

    const native = ident(a["gen_ai.conversation.id"]) ?? ident(a["session.id"]) ?? traceId;
    const session: SessionRecord = { id: `${ns}otel:${native}`, provider: "otel", nativeId: native, project, clientVersion: name(s.resource["service.version"]) };
    const id = `${ns}otel:${spanKey(s.traceId, s.spanId)}`;
    touch(g, session, s.startMs, s.endMs);
    g.usage.push({
      id,
      provider: "otel",
      sessionId: session.id,
      promptId: null,
      ts,
      project,
      model: name(a["gen_ai.response.model"]) ?? name(a["gen_ai.request.model"]),
      skill: null,
      agent: "main",
      isSubagent: false,
      ...t,
    });
    g.meta.push({ usageId: id, startTs: s.startMs, endTs: s.endMs });
  }

  // ---- Claude Code logs ----

  for (const l of batch.logs) {
    const event = claudeEvent(l);
    if (!event) continue;

    const hit = groupOf(l.resource);
    if (typeof hit === "string") {
      skip(hit);
      continue;
    }

    const a = l.attrs;
    const native = ident(a["session.id"]);
    if (hit.local || !native) {
      skip("other");
      continue;
    }

    const ts = l.timeMs ?? l.observedMs;
    if (ts == null || !sane(ts)) {
      skip("time");
      continue;
    }

    const g = hit.group;
    const project = name(l.resource["harness.project"]);
    const session: SessionRecord = {
      id: `${ns}claude:${native}`,
      provider: "claude",
      nativeId: native,
      project,
      clientVersion: name(l.resource["service.version"]) ?? name(a["app.version"]),
    };
    const promptRef = ident(a["prompt.id"]);
    const promptId = promptRef ? `${ns}claude:${native}:${promptRef}` : null;
    const agent = name(a["agent.name"]) ?? "main";
    // Without an id of its own, a record is keyed by where it is in its session, when it was seen and all it says.
    const fallbackId = () => `${ns}claude:${sha(native, str(a["event.sequence"]), ts, str(a.model), l.observedMs, l.spanId, canonical(a))}`;

    if (event === "api_request") {
      const t = {
        input: tokens(a.input_tokens),
        output: tokens(a.output_tokens),
        cacheRead: tokens(a.cache_read_tokens),
        cacheWrite: tokens(a.cache_creation_tokens),
        cacheWrite1h: 0,
        reasoning: 0,
      };
      if (!hasTokens(t)) continue;

      touch(g, session, ts);
      const requestId = ident(a.request_id);
      const id = requestId ? `${ns}claude:${requestId}` : fallbackId();
      // cost_usd is not read: Claude Code's own estimate, where the price book prices every Claude call alike.
      g.usage.push({
        id,
        provider: "claude",
        sessionId: session.id,
        promptId,
        ts,
        project,
        model: name(a.model),
        skill: name(a["skill.name"]),
        agent,
        isSubagent: agent !== "main",
        ...t,
        speed: name(a.speed),
      });
      // A call takes less than a day: a longer one is no real time.
      const duration = num(a.duration_ms);
      if (duration != null && duration >= 0 && duration <= FUTURE_MS) g.meta.push({ usageId: id, startTs: ts - Math.round(duration), endTs: ts });
      continue;
    }

    if (event === "tool_result") {
      touch(g, session, ts);
      const toolUse = ident(a.tool_use_id);
      const id = toolUse ? `${ns}claude:${toolUse}` : fallbackId();
      g.tools.push({
        id,
        usageId: null,
        sessionId: session.id,
        promptId,
        provider: "claude",
        ts,
        project,
        tool: name(a.tool_name) ?? "unknown",
        filePath: null,
        skill: name(a["skill.name"]),
        agent,
      });
      const ok = bool(a.success);
      if (ok != null) g.outcomes.push({ id, provider: "claude", sessionId: session.id, ts, project, model: null, agent, kind: ok ? "tool_ok" : "tool_error" });
      continue;
    }

    touch(g, session, ts);
    // A command is told by its command_name. The prompt's own text is looked at only when it is kept anyway.
    const raw = ctx.storeText ? (str(a.prompt) ?? str(a.prompt_text)) : null;
    g.prompts.push({
      id: promptId ?? fallbackId(),
      sessionId: session.id,
      provider: "claude",
      ts,
      text: text(raw),
      skill: null,
      isCommand: a.command_name != null || (raw?.startsWith("/") ?? false),
    });
  }

  return { groups: [...groups.values()].filter((g) => g.sessionIds.size > 0), skipped, skippedFor };
}
