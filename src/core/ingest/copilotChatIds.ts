import { createHash } from "node:crypto";

/**
 * Record ids of GitHub Copilot Chat in VS Code. Its two sources, the chat session files and the OpenTelemetry spans,
 * describe the same requests: a session shares its id between them, a usage row's id says which source wrote it.
 * Remote (non-local) telemetry gets the usual "otlp:<credential>:" prefix in front of these.
 */

export const COPILOT_CHAT = "copilot-chat";

/** ":f:" marks a row read from a chat session file, ":o:" one from telemetry. */
const FILE = ":f:";

const SAFE_PART = /^[A-Za-z0-9_-]{1,128}$/;

/** What a hashed part looks like: a plain part that looks so is hashed too, so no part can pose as another's hash. */
const HASHED = /^h[0-9a-f]{32}$/;

/**
 * An id part (a session, request, tool call or span id) as it goes into an id. Ids come from files and senders and may
 * hold ":" or be of any length, so one part could pose as several (a session "A:f:B"). A part that is not plain
 * (letters, digits, "_" and "-", at most 128 of them), or looks like a hash already, is replaced by a hash of the whole
 * of it: "h" and 32 hex digits, the same for the same part wherever it is read, so both sources still meet.
 */
export function safePart(part: string): string {
  if (SAFE_PART.test(part) && !HASHED.test(part)) return part;
  return `h${createHash("sha256").update(part).digest("hex").slice(0, 32)}`;
}

/** A span as it goes into an id: `traceId:spanId`, each part safe. */
export const spanKey = (traceId: string, spanId: string): string => `${safePart(traceId)}:${safePart(spanId)}`;

export const sessionId = (sid: string): string => `${COPILOT_CHAT}:${safePart(sid)}`;

/** The session of helper calls with no conversation (titles, progress messages), one per local day (YYYY-MM-DD). */
export const backgroundSessionId = (localDay: string): string => `${COPILOT_CHAT}:background:${safePart(localDay)}`;

/** A request of a chat session file: its partial usage row. */
export const fileUsageId = (sid: string, requestId: string): string => `${sessionId(sid)}${FILE}${safePart(requestId)}`;

/** A request of a chat session file: its prompt. */
export const filePromptId = (sid: string, requestId: string): string => `${sessionId(sid)}:${safePart(requestId)}`;

/** A model call of the telemetry in a session (its full id, see `sessionId`): its span (`spanKey`). */
export const otelUsageIdIn = (session: string, key: string): string => `${session}:o:${key}`;

/** A model call of the telemetry: its span (`spanKey`). */
export const otelUsageId = (sid: string, key: string): string => otelUsageIdIn(sessionId(sid), key);

/** A tool call in a session (its full id): its call id, else (the id may be empty) the span (`spanKey`). */
export const toolIdIn = (session: string, callId: string | null, key: string): string =>
  callId ? `${session}:t:${safePart(callId)}` : `${session}:t:s:${key}`;

/** A tool call: its call id, else (the id may be empty) the span (`spanKey`). */
export const toolId = (sid: string, callId: string | null, key: string): string => toolIdIn(sessionId(sid), callId, key);

/** A tool call of a chat session file that has no id: its place in the request. */
export const fileToolId = (sid: string, requestId: string, round: number, index: number): string =>
  `${sessionId(sid)}:t:f:${safePart(requestId)}:${round}:${index}`;

/** Whether a usage id is a row read from a chat session file (with or without a remote prefix). */
export function isFileUsageId(id: string): boolean {
  const start = id.indexOf(`${COPILOT_CHAT}:`);
  if (start < 0) return false;

  // After the session id (a UUID, no colon) comes the source marker.
  const rest = id.slice(start + COPILOT_CHAT.length + 1);
  const colon = rest.indexOf(":");
  return colon > 0 && rest.startsWith(FILE, colon);
}
