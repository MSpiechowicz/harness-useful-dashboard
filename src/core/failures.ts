import { redact } from "./redact.ts";
import { truncate, type VcsIntent } from "./ingest/types.ts";

/**
 * Why a tool call failed, in a few classes the friction view groups by. Worked out from the tool's error output while
 * it is read (the full text, not the short part kept), so it is there also when no text is kept.
 */
export type FailureReason =
  | "timeout"
  | "edit_mismatch"
  | "stale_read"
  | "not_found"
  | "permission"
  | "exit_code"
  | "bad_input"
  | "other"
  | "rejected";

/** Most specific first: the first class whose pattern matches wins. */
export const FAILURE_REASONS: readonly FailureReason[] = [
  "timeout",
  "edit_mismatch",
  "stale_read",
  "not_found",
  "permission",
  "exit_code",
  "bad_input",
  "other",
  "rejected",
];

/** The error text kept for a failed call, and the input it was given (a command, a path). */
export const DETAIL_LIMIT = 400;
export const INPUT_LIMIT = 200;

const TIMEOUT_RE = /\btimed? ?out\b|\btimeout (?:after|of|exceeded|expired|reached)\b|\bETIMEDOUT\b|deadline exceeded/i;
const EDIT_RE =
  /string to replace not found|matches of the string to replace|\bold_string\b|could not find (?:the )?(?:text|string|match|old)|no match(?:es)? found for (?:the )?(?:old|search)|anchors to lines|verify the content matches|patch (?:does not|did not|failed to) apply|failed to apply (?:the )?patch|hunk #?\d* ?failed|context mismatch|failed to find expected lines/i;
const STALE_RE = /has not been read yet|modified since (?:it was )?read|read it first|has (?:been )?changed since (?:it was )?read/i;
// Also the messages of a few locales' coreutils: "ls: cannot access 'x': No such file or directory" in Polish, German,
// Spanish and French.
const NOT_FOUND_RE =
  /no such file|\bENOENT\b|\bnot found\b|does not exist|doesn't exist|(?:cannot|can't|couldn't|could not|unable to) (?:find|locate)|no such (?:tool|command|directory)|has no resource|no mcp server has resource|nie ma takiego pliku|nicht gefunden|no existe|introuvable|aucun fichier/i;
const PERMISSION_RE =
  /permission denied|\bEACCES\b|\bEPERM\b|operation not permitted|access (?:is )?denied|\bwas denied\b|denied by|\b40[13] (?:forbidden|unauthori[sz]ed)\b|\bstatus code 40[13]\b|^(?:<tool_use_error>)?Blocked\b|keine berechtigung|permiso denegado|permission non accordée|brak uprawnień/im;
const EXIT_RE = /^Exit code [1-9]\d*|exited with (?:code|status) [1-9]\d*|exit (?:code|status):? [1-9]\d*|^exit [1-9]\d*$|returned non-zero exit/im;
/** Input the harness turned down before the tool ran: also for an edit tool, it is no mismatch with the file. */
const SCHEMA_RE = /InputValidationError|missing required|does not match schema/i;
const BAD_INPUT_RE =
  /InputValidationError|invalid (?:input|argument|parameter|params|value|json|request)|missing required|required (?:parameter|property|field|argument)|is required\b|does not match schema|unknown (?:field|option|argument|parameter|label)|unexpected (?:argument|parameter|keyword)|must be (?:a|an|one of|numeric|positive|at|non-empty)\b|exceeds (?:the )?maximum|too large|validation failed|resubmit with|(?:is|are) not supported|uses unknown/i;
const SCAN_HEAD = 400;
const SCAN_TAIL = 1500;
/** Tools that change a file in place: an error with no other cause is the edit not fitting the file. */
const EDIT_TOOLS = /^(?:edit|multiedit|str_replace|str_replace_editor|replace|apply_patch|patch|edit_file|replace_in_file|ast_edit)$/i;

/**
 * Classifies a failed or rejected tool call from its error output. `text` is the whole output as the tool wrote it
 * (classified before it is cut), `tool` the tool's name.
 */
export function classifyFailure(kind: string, tool: string | null, text: string | null): FailureReason {
  if (kind === "tool_rejected") return "rejected";
  // A command's error is said at the start (stderr) or the end of its output: the middle is mostly what it printed (a
  // file, a test run), whose words would only mislead.
  const all = text ?? "";
  const s = all.length > SCAN_HEAD + SCAN_TAIL ? `${all.slice(0, SCAN_HEAD)}\n${all.slice(-SCAN_TAIL)}` : all;
  if (TIMEOUT_RE.test(s)) return "timeout";
  if (EDIT_RE.test(s)) return "edit_mismatch";
  if (STALE_RE.test(s)) return "stale_read";
  if (NOT_FOUND_RE.test(s)) return "not_found";
  if (PERMISSION_RE.test(s)) return "permission";
  if (EXIT_RE.test(s)) return "exit_code";
  if (SCHEMA_RE.test(s)) return "bad_input";
  if (tool && EDIT_TOOLS.test(tool)) return "edit_mismatch";
  if (BAD_INPUT_RE.test(s)) return "bad_input";
  return "other";
}

/** The class of an outcome stored without one (read before it was classified): by its kind alone. */
export function storedReason(kind: string, reason: string | null): FailureReason {
  if (reason && (FAILURE_REASONS as readonly string[]).includes(reason)) return reason as FailureReason;
  return kind === "tool_rejected" ? "rejected" : "other";
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
/** Lines that only repeat what the class says, or carry no information: the exit code, the time taken, tags. */
const NOISE_RE = /^(?:Exit code -?\d+|Command exited with code -?\d+|Wall time: [\d.]+ ?\w*|\(no output\)|<\/?tool_use_error>|<\/?error>)$/i;
/** A line that looks like where the error is said. */
const ERROR_LINE_RE = /error|fail|fatal|denied|not found|no such|cannot|can't|unable|invalid|exception|traceback|panic|refused|timed out|rejected/i;
/** Longer output is read from its end: errors are said last (a compiler's, a test run's, a traceback's). */
const MAX_SCAN = 20_000;

/**
 * The part of a tool's error output worth showing: escape codes, blank lines and the exit-code line dropped, then the
 * first line that names an error and what follows, or else the end of the output. Secrets are replaced before it is cut.
 * `limit` 0 (no text kept) keeps nothing.
 */
export function errorSnippet(text: string | null | undefined, limit = DETAIL_LIMIT): string | null {
  if (!text || limit <= 0) return null;
  let s = text.length > MAX_SCAN ? text.slice(-MAX_SCAN) : text;
  // A line cut in half at the start could hold half a key, which redaction no longer recognizes.
  if (s !== text) s = s.slice(s.indexOf("\n") + 1);
  s = redact(s.replace(ANSI_RE, "").replace(/<\/?tool_use_error>/g, "\n"));
  const all = s.split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const lines = all.filter((l) => !NOISE_RE.test(l.trim()));
  if (!lines.length) return truncate(all.join("\n"), limit);
  let out = lines.join("\n");
  if (out.length > limit) {
    const at = lines.findIndex((l) => ERROR_LINE_RE.test(l));
    if (at > 0) out = lines.slice(at).join("\n");
    else if (at < 0) out = "…" + out.slice(-limit).replace(/^[^\n]*\n/, "");
  }
  return truncate(out, limit);
}

const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === "string")) return (v as string[]).join(" ");
  }
  return null;
};

/**
 * What a tool call was given, in one line: the command, else the file, pattern, address or query. Null for input that
 * says none of these (a whole file's content is no summary). At most INPUT_LIMIT long, and `textLimit` 0 keeps nothing.
 */
export function inputSummary(input: unknown, textLimit = INPUT_LIMIT): string | null {
  const limit = Math.min(INPUT_LIMIT, textLimit);
  if (limit <= 0 || !input || typeof input !== "object") return typeof input === "string" && limit > 0 ? truncate(input.replace(/\s+/g, " "), limit) : null;
  const o = input as Record<string, unknown>;
  const text = pick(o, ["command", "cmd", "file_path", "filePath", "path", "notebook_path", "pattern", "url", "query", "description"]);
  return text ? truncate(text.replace(/\s+/g, " "), limit) : null;
}

/**
 * The calls still waiting for their results, by id: the tool, what it was given and whether it commits or opens a pull
 * request or both (ingest/vcs.ts vcsIntent, so its output is read for them). Kept in a parser's state between chunks,
 * the last few only (results follow their calls closely). States saved without the third element, or before "both"
 * existed, are still read.
 */
export type PendingCalls = Record<string, [tool: string, input: string | null, vcs?: VcsIntent]>;

export function rememberCall(calls: PendingCalls, id: string, tool: string, input: string | null, vcs: VcsIntent | null = null, keep = 64): void {
  delete calls[id];
  calls[id] = vcs ? [tool, input, vcs] : [tool, input];
  const keys = Object.keys(calls);
  for (const k of keys.slice(0, Math.max(0, keys.length - keep))) delete calls[k];
}

/** Takes the call a result belongs to, once it is in. */
export function takeCall(calls: PendingCalls | undefined, id: string): { tool: string | null; input: string | null; vcs: VcsIntent | null } {
  const c = calls?.[id];
  if (!c) return { tool: null, input: null, vcs: null };
  delete calls![id];
  return { tool: c[0], input: c[1], vcs: c[2] ?? null };
}

/**
 * What an outcome keeps about why a call failed: its class (always), the error text and the input (only when prompt
 * text is kept, `textLimit` > 0, and no longer than it). Nothing for calls that worked.
 */
export function failureOf(
  kind: string,
  tool: string | null,
  errorText: string | null | undefined,
  input: string | null | undefined,
  textLimit: number,
): { reason: FailureReason | null; detail: string | null; input: string | null } {
  if (kind !== "tool_error" && kind !== "tool_rejected") return { reason: null, detail: null, input: null };
  return {
    reason: classifyFailure(kind, tool, errorText ?? null),
    detail: errorSnippet(errorText, Math.min(DETAIL_LIMIT, textLimit)),
    input: textLimit > 0 && input ? truncate(input, Math.min(INPUT_LIMIT, textLimit)) : null,
  };
}
