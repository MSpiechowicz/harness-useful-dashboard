/**
 * Lines an edit tool call added and removed, worked out from what the harness logged: the call's input (the old and
 * new text, a patch, a file's content) or, better, the diff its result carries. Only the counts are kept, never the
 * text.
 */
export interface LineCount {
  added: number;
  removed: number;
}

/** Above this many cells (old lines × new lines) a replaced block counts whole instead of being diffed line by line. */
const LCS_CELLS = 250_000;

const linesOf = (text: string): string[] => {
  const lines = text.split(/\r?\n/);
  // A final newline ends the last line, it doesn't start another.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Lines in a text: a final newline ends the last line rather than starting another. Not a string: 0. */
export function countLines(text: unknown): number {
  return typeof text === "string" && text ? linesOf(text).length : 0;
}

export const sumLines = (counts: (LineCount | null)[]): LineCount | null => {
  const known = counts.filter((c): c is LineCount => c != null);
  return known.length ? { added: known.reduce((s, c) => s + c.added, 0), removed: known.reduce((s, c) => s + c.removed, 0) } : null;
};

/**
 * What replacing `oldText` with `newText` changed, line by line, as `git diff --numstat` counts it: lines both share at
 * the start and end are left out, the rest is diffed (longest common subsequence) unless it is very long.
 */
export function diffLines(oldText: unknown, newText: unknown): LineCount {
  const a = typeof oldText === "string" && oldText ? linesOf(oldText) : [];
  const b = typeof newText === "string" && newText ? linesOf(newText) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (!n || !m || n * m > LCS_CELLS) return { added: m, removed: n };
  // One row of the LCS table at a time.
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const x = a[start + i - 1];
    for (let j = 1; j <= m; j++) cur[j] = x === b[start + j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    [prev, cur] = [cur, prev];
  }
  const common = prev[m]!;
  return { added: m - common, removed: n - common };
}

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A unified diff's added and removed lines. File headers ("--- a/x", "+++ b/x", "diff --git", "Index:") don't count:
 * a hunk's header says how many lines it has, so a removed line that reads "-- x" is still told from the next file's
 * header. Hunks without counts ("@@" alone) run to the next header.
 */
export function unifiedDiffLines(diff: unknown): LineCount | null {
  if (typeof diff !== "string" || !diff) return null;
  let added = 0;
  let removed = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let open = false; // in a hunk without counts
  for (const line of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        added++;
        newLeft--;
      } else if (line.startsWith("-")) {
        removed++;
        oldLeft--;
      } else if (!line.startsWith("\\")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      open = !m;
      if (m) {
        oldLeft = m[1] != null ? Number(m[1]) : 1;
        newLeft = m[2] != null ? Number(m[2]) : 1;
      }
      continue;
    }
    if (/^(diff --git|Index: |--- |\+\+\+ |===)/.test(line)) {
      open = false;
      continue;
    }
    if (!open) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Claude Code's `structuredPatch`: hunks whose lines start with "+", "-" or " ". Empty or not a list: null. */
export function hunkLines(hunks: unknown): LineCount | null {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of Array.isArray(h?.lines) ? h.lines : []) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

/** A string literal's escapes undone ("\\n" → newline), for a patch written inside JSON or JavaScript. */
function unescape(s: string): string {
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, c: string) =>
    c.length > 1 ? String.fromCharCode(parseInt(c.slice(1), 16)) : (simple[c] ?? c),
  );
}

/**
 * The lines of every `apply_patch` patch in a text ("*** Begin Patch" … "*** End Patch"): a tool's raw input, a JSON
 * argument, a shell heredoc, or a string in Codex's code mode, where it is still escaped. An added file's lines start
 * with "+", an update's with "+", "-" or " ". A deleted file has no lines in the patch, so its removal isn't counted.
 */
export function patchLines(text: unknown): LineCount | null {
  if (typeof text !== "string" || !text.includes(BEGIN)) return null;
  let added = 0;
  let removed = 0;
  let found = false;
  for (let at = text.indexOf(BEGIN); at >= 0; at = text.indexOf(BEGIN, at + BEGIN.length)) {
    const end = text.indexOf(END, at);
    let body = text.slice(at + BEGIN.length, end < 0 ? undefined : end);
    // Escaped inside a string literal: no real line breaks, only "\n".
    if (!body.includes("\n") && body.includes("\\n")) body = unescape(body);
    found = true;
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("***")) continue;
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return found ? { added, removed } : null;
}

const SEARCH_RE = /^-{3,} SEARCH\r?\n([\s\S]*?)^={3,}\r?\n([\s\S]*?)^\+{3,} REPLACE/gm;
const SEARCH_OLD_RE = /^<{3,} SEARCH\r?\n([\s\S]*?)^={3,}\r?\n([\s\S]*?)^>{3,} REPLACE/gm;

/** Cline's and Roo Code's SEARCH/REPLACE blocks: each block's search text replaced by its replacement. */
export function searchReplaceLines(diff: unknown): LineCount | null {
  if (typeof diff !== "string") return null;
  const blocks = [...diff.matchAll(SEARCH_RE), ...diff.matchAll(SEARCH_OLD_RE)];
  // Roo Code's blocks carry a ":start_line:" marker and a "-------" line before the search text.
  const clean = (s: string) => s.replace(/^:start_line:\s*\d+\s*\r?\n(-{3,}\r?\n)?/, "");
  return blocks.length ? sumLines(blocks.map((b) => diffLines(clean(b[1]!), clean(b[2]!)))) : null;
}

/** omp's and pi's edit diff: changed lines are "+12|text" and "-12|text", the context " 12|text". */
export function numberedDiffLines(diff: unknown): LineCount | null {
  if (typeof diff !== "string" || !diff) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
