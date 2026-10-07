import { DETAIL_LIMIT } from "./failures.ts";
import { truncate } from "./ingest/types.ts";

/**
 * Why a model request failed, from the error a harness logged for it (Claude Code's API error messages, Codex's error
 * events, pi's and omp's errored responses, OpenCode's message errors). Kept on an `api_error` outcome as its reason.
 */
export type ApiErrorClass =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "timeout"
  | "network"
  | "auth"
  | "billing"
  | "context_length"
  | "other";

export const API_ERROR_CLASSES: readonly ApiErrorClass[] = [
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "network",
  "auth",
  "billing",
  "context_length",
  "other",
];

/** Error codes the harnesses and the providers name, to their class. */
const CODES: Record<string, ApiErrorClass> = {
  rate_limit: "rate_limit",
  rate_limit_error: "rate_limit",
  rate_limit_exceeded: "rate_limit",
  usage_limit_reached: "rate_limit",
  usage_limit_exceeded: "rate_limit",
  too_many_requests: "rate_limit",
  overloaded: "overloaded",
  overloaded_error: "overloaded",
  server_overloaded: "overloaded",
  service_unavailable_error: "server_error",
  internal_server_error: "server_error",
  api_error: "server_error",
  server_error: "server_error",
  authentication_failed: "auth",
  authentication_error: "auth",
  permission_error: "auth",
  unauthorized: "auth",
  invalid_api_key: "auth",
  oauth_org_not_allowed: "auth",
  providerautherror: "auth",
  billing_error: "billing",
  insufficient_quota: "billing",
  credit_balance_too_low: "billing",
  context_window_exceeded: "context_length",
  context_length_exceeded: "context_length",
  contextoverflowerror: "context_length",
  request_too_large: "context_length",
  http_connection_failed: "network",
  response_stream_disconnected: "network",
  response_stream_connection_failed: "network",
  timeout: "timeout",
  timeout_error: "timeout",
};

const CONTEXT_RE = /prompt is too long|context (?:length|window)|maximum context|too many tokens|input is too long|request too large|exceeds the (?:model's )?(?:context|token limit)/i;
const BILLING_RE = /credit balance|insufficient[_ ](?:quota|credits?|funds|balance)|billing|payment required|out of credits|exceeded your current quota/i;
const AUTH_RE =
  /\b(?:invalid|incorrect|expired|missing) (?:api[ _-]?key|token|credentials?|x-api-key)|api key (?:is )?(?:invalid|not valid)|login expired|please run \/login|unauthori[sz]ed|authentication|not authenticated|oauth|forbidden|access denied|permission denied|has disabled/i;
const RATE_RE = /rate[ _-]?limit|too many requests|usage limit|quota exceeded|request limit|limit (?:has been )?reached|slow down/i;
const OVERLOADED_RE = /overloaded|over capacity|at capacity|high demand/i;
const NETWORK_RE =
  /getaddrinfo|\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|NOTFOUND|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)\b|socket (?:hang up|connection was closed|closed)|connection (?:error|reset|refused|closed|was closed|failed)|websocket (?:closed|transport error|error)|stream disconnected|network (?:error|is unreachable)|fetch failed|unable to connect|dns/i;
const TIMEOUT_RE = /\btimed? ?out\b|\btimeout\b|\bETIMEDOUT\b|deadline exceeded/i;
const SERVER_RE = /internal server error|server error|service unavailable|bad gateway|an error occurred while processing|please (?:try again|retry)/i;
/** A status code the text says: "API Error: 529 …", "status 503", "last status: 429 Too Many Requests", "502 Bad Gateway". */
const STATUS_RES = [
  /\bAPI Error:? \(?(\d{3})\b/i,
  /\b(?:status(?: code)?|statusCode|http_status_code|last status)["']?\s*[:=]?\s*(\d{3})\b/i,
  /^(\d{3})\s+(?:[A-Z{]|status)/,
];

/** A code the message names itself: "… (code=usage_limit_reached)", "\"type\":\"overloaded_error\"". */
const CODE_IN_TEXT_RE = /\(code=(\w+)\)|"type"\s*:\s*"(?!error")(\w+_error)"/;

/** The HTTP status in an error's text, when it names one. */
export function statusFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  for (const re of STATUS_RES) {
    const m = re.exec(text);
    const n = m ? Number(m[1]) : NaN;
    if (n >= 400 && n <= 599) return n;
  }
  return null;
}

/**
 * Classifies a failed model request. `code` is the error's name or type when the harness logs one ("rate_limit_error",
 * "authentication_failed", "usage_limit_reached"), `status` its HTTP status, `text` its message. The message decides
 * over a bare status (a 429 for lack of credit is billing, a 400 for a long prompt is the context length), and the
 * status over loose words.
 */
export function classifyApiError(code: string | null | undefined, status: number | null | undefined, text: string | null | undefined): ApiErrorClass {
  const s = text ?? "";
  const named = code ? CODES[code.toLowerCase()] : undefined;
  if (CONTEXT_RE.test(s) || named === "context_length" || status === 413) return "context_length";
  if (BILLING_RE.test(s) || named === "billing" || status === 402) return "billing";
  if (named) return named;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status === 408 || status === 504) return "timeout";
  if (status != null && status >= 500) return OVERLOADED_RE.test(s) ? "overloaded" : "server_error";
  if (AUTH_RE.test(s)) return "auth";
  if (RATE_RE.test(s)) return "rate_limit";
  if (OVERLOADED_RE.test(s)) return "overloaded";
  if (NETWORK_RE.test(s)) return "network";
  if (TIMEOUT_RE.test(s)) return "timeout";
  if (SERVER_RE.test(s)) return "server_error";
  return "other";
}

/** The class of a stored API error: its reason when it is one, else "other". */
export function storedApiClass(reason: string | null): ApiErrorClass {
  return reason && (API_ERROR_CLASSES as readonly string[]).includes(reason) ? (reason as ApiErrorClass) : "other";
}

/**
 * What an `api_error` outcome keeps: the class (always), the status (when known) and the message on one line (only when
 * prompt text is kept, `textLimit` > 0, secrets replaced, and no longer than DETAIL_LIMIT).
 */
export function apiErrorOf(
  code: string | null | undefined,
  status: number | null | undefined,
  text: string | null | undefined,
  textLimit: number,
): { kind: "api_error"; reason: ApiErrorClass; status: number | null; detail: string | null } {
  const st = status != null && status >= 100 && status <= 599 ? status : statusFromText(text);
  const named = CODE_IN_TEXT_RE.exec(text ?? "");
  return {
    kind: "api_error",
    reason: classifyApiError(code ?? named?.[1] ?? named?.[2], st, text),
    status: st,
    detail: truncate(text?.replace(/\s+/g, " "), Math.min(DETAIL_LIMIT, textLimit)),
  };
}
