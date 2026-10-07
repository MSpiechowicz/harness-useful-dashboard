/**
 * Matching and ranking for the command palette (Ctrl+K), and which key opens what. Pure functions, no DOM: the
 * palette component renders what these decide.
 *
 * Not to be confused with palette.ts, the data colors.
 */

/** Letters that don't decompose into a base letter and a mark (NFD), spelled the way people type them. */
const SPECIAL: Record<string, string> = { ł: "l", đ: "d", ø: "o", ß: "ss", æ: "ae", œ: "oe", ı: "i" };

/** One character folded: lowercase, without accents. May be longer than one (ß → ss) or empty (a lone mark). */
function foldChar(c: string): string {
  const lower = c.toLowerCase();
  return SPECIAL[lower] ?? lower.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Lowercase and without accents, so "zrodlo" finds "Źródło" and "uber" finds "Über". */
export function fold(s: string): string {
  let out = "";
  for (const c of s) out += foldChar(c);
  return out;
}

/** The folded text, and for each of its characters where it came from in the original (for highlighting). */
function foldMapped(s: string): { text: string; from: number[] } {
  let text = "";
  const from: number[] = [];
  let i = 0;
  for (const c of s) {
    const f = foldChar(c);
    for (let k = 0; k < f.length; k++) from.push(i);
    text += f;
    i += c.length;
  }
  return { text, from };
}

const terms = (query: string) => fold(query).split(/\s+/).filter(Boolean);
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** How well one term matches the folded text: 0 for no match. */
function termScore(text: string, term: string, fuzzy: boolean): number {
  if (text === term) return 100;
  if (text.startsWith(term)) return 80;
  let i = text.indexOf(term);
  if (i >= 0) {
    // A word starting with the term ("drift" in "Model drift") beats one containing it.
    for (; i >= 0; i = text.indexOf(term, i + 1)) if (!isWordChar(text[i - 1])) return 60;
    return 40;
  }
  // Fuzzy-ish: the letters in order with gaps ("mdr" → "Model drift"). Only for short lists of names.
  return fuzzy && subsequence(text, term) ? 10 : 0;
}

/**
 * The letters of `term` in order, starting at the start of a word and not spread too far ("mdr" in "Model drift", not
 * "auth" across "Language: Deutsch"). Their positions, or null.
 */
function subsequence(text: string, term: string): number[] | null {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== term[0] || isWordChar(text[start - 1])) continue;
    const at = [start];
    for (let i = start + 1; i < text.length && at.length < term.length; i++) if (text[i] === term[at.length]) at.push(i);
    if (at.length === term.length && at[at.length - 1]! - start < term.length * 3) return at;
  }
  return null;
}

export interface MatchOptions {
  /** Other words the item is found by (e.g. the group it belongs to), matched less strongly than its name. */
  keywords?: string[];
  /** Letters in order with gaps match too. For pages and actions, not for data. */
  fuzzy?: boolean;
}

/**
 * How well `text` matches `query`: 0 for no match, higher for a better one. Every word of the query must match, in
 * the text or its keywords. An empty query matches everything (1).
 */
export function score(text: string, query: string, opts: MatchOptions = {}): number {
  const ts = terms(query);
  if (!ts.length) return 1;
  const folded = fold(text);
  const keys = (opts.keywords ?? []).map(fold);
  let total = 0;
  for (const term of ts) {
    const own = termScore(folded, term, opts.fuzzy ?? false);
    const other = Math.max(0, ...keys.map((k) => termScore(k, term, false))) / 2;
    const best = Math.max(own, other);
    if (!best) return 0;
    total += best;
  }
  return total;
}

export interface Rankable {
  id: string;
  label: string;
  keywords?: string[];
}

/**
 * The items that match, best first. Equal ones keep their order, recently used ones first. With an empty query, the
 * recent ones come first, then the rest as they are.
 */
export function rank<T extends Rankable>(items: T[], query: string, recent: string[] = [], fuzzy = true): T[] {
  const recency = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? recent.length : i;
  };
  return items
    .map((item, order) => ({ item, order, s: score(item.label, query, { keywords: item.keywords, fuzzy }) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || recency(a.item.id) - recency(b.item.id) || a.order - b.order)
    .map((r) => r.item);
}

/** `id` moved to the front of the recently used list, at most `max` long. */
export function pushRecent(recent: string[], id: string, max = 5): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

/** The parts of `text` that match `query`, as [start, end) ranges in the original text, merged and in order. */
export function matchRanges(text: string, query: string): [number, number][] {
  const { text: folded, from } = foldMapped(text);
  const ranges: [number, number][] = [];
  const end = (k: number) => {
    const i = from[k]!;
    // The whole original character, also when it is a surrogate pair.
    return i + (text.codePointAt(i)! > 0xffff ? 2 : 1);
  };
  for (const term of terms(query)) {
    const i = folded.indexOf(term);
    if (i >= 0) ranges.push([from[i]!, end(i + term.length - 1)]);
    else for (const k of subsequence(folded, term) ?? []) ranges.push([from[k]!, end(k)]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** `text` cut into the parts that match `query` (`hit`) and the ones between them, for highlighting. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of matchRanges(text, query)) {
    if (a > at) parts.push({ text: text.slice(at, a), hit: false });
    parts.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/** Where a key press is going: typing there must not open anything (except Ctrl+K). */
export interface KeyTarget {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

/** Inputs that take no typed text: a shortcut pressed on one of them still works. */
const NO_TEXT = new Set(["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"]);

/** Whether the element takes typed text (a text field, a text area, a list, an editable element). */
export function isEditable(el: KeyTarget | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NO_TEXT.has((el.type ?? "text").toLowerCase());
}

export type Shortcut = "palette" | "search" | "help";

/**
 * What a key press asks for: the palette (Ctrl+K or Cmd+K, anywhere), the table search (/) or the list of shortcuts
 * (?), these two only when not typing. Null for every other key.
 */
export function shortcutOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, typing: boolean): Shortcut | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") return "palette";
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key === "/") return "search";
  if (e.key === "?") return "help";
  return null;
}

/**
 * A long text (a prompt) cut so the first match shows: from a little before it, with "…" where it was cut. One line,
 * whitespace collapsed.
 */
export function snippet(text: string, query: string, before = 24): string {
  const line = text.replace(/\s+/g, " ").trim();
  const start = matchRanges(line, query)[0]?.[0] ?? 0;
  if (start <= before) return line;
  // Start at a word, not in the middle of one.
  const cut = line.lastIndexOf(" ", start - before) + 1 || start - before;
  return `…${line.slice(cut)}`;
}

/** The modifier key the shortcut hints name: ⌘ on Apple systems, Ctrl elsewhere. */
export function modKey(platform: string): string {
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘" : "Ctrl";
}
