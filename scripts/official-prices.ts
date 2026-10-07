/**
 * The makers' own pricing pages, read as Markdown. scripts/update-prices.ts trusts these over LiteLLM and OpenRouter.
 *
 * Every parser is strict: a table it does not recognise, a price it cannot read or a model listed twice with two
 * prices throws, and the caller then ignores that maker's page for the run (never half of it). Prices are USD per 1M
 * tokens. Cache rates a page doesn't list follow what the maker does: no cache-read discount means cached input costs
 * what input costs, and no cache-write charge means written tokens cost what input does.
 */
import { normalizeModel } from "../src/core/models.ts";

/** Every rate in USD per 1M tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export type FieldName = "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h";
export const FIELD_ORDER: FieldName[] = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

/** Six significant digits: enough for every list price, and it removes float noise like 0.30000000000000004. */
export function round6(n: number): number {
  return Number(n.toPrecision(6));
}

/** A price change the page announces for a later date. */
export interface Scheduled {
  /** YYYY-MM-DD from which the new price applies. */
  from: string;
  to: Partial<Record<FieldName, number>>;
}

export interface OfficialEntry extends Rates {
  /** The model's name on the page. */
  key: string;
  /** Normalized id. */
  id: string;
  provider: "official";
  scheduled?: Scheduled[];
  /** Rates the page doesn't list (a cached-input price shown as "-"): the value above is a placeholder, a rule keeps its own. */
  unlisted?: FieldName[];
}

export interface ParseResult {
  entries: OfficialEntry[];
  /** Facts worth showing in the report. */
  notes: string[];
  /** Things a human should look at. */
  warnings: string[];
}

export interface OfficialSource {
  /** File name in --official-dir and the name in the report. */
  key: string;
  maker: string;
  /** Markdown URL. */
  url: string;
  parse: (text: string, today: string) => ParseResult;
}

function fail(msg: string): never {
  throw new Error(msg);
}

// --- Markdown helpers ---------------------------------------------------------------------------------------------

interface MdTable {
  heading: string;
  /** Title of the enclosing <Tab>, if any. */
  tab?: string;
  header: string[];
  rows: string[][];
}

const SEPARATOR = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

function cells(line: string): string[] {
  const parts = line.trim().split(/(?<!\\)\|/).map((c) => c.trim());
  if (parts[0] === "") parts.shift();
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function mdTables(text: string): MdTable[] {
  const lines = text.split(/\r?\n/);
  const out: MdTable[] = [];
  let heading = "";
  let tab: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    if (h) heading = h[1]!;
    const tabStart = /^<Tab title="([^"]*)"/.exec(t);
    if (tabStart) tab = tabStart[1];
    else if (t.startsWith("</Tab>")) tab = undefined;
    if (t.startsWith("|") && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!.trim())) {
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.trim().startsWith("|")) rows.push(cells(lines[j++]!));
      out.push({ heading, tab, header: cells(t), rows });
      i = j - 1;
    }
  }
  return out;
}

/** A table cell without footnote marks, strike-through (an old price), escapes, bold and line breaks. */
function clean(cell: string): string {
  return cell
    .replace(/<sup>.*?<\/sup>/g, "")
    .replace(/~~.*?~~/g, "")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\\/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "$4 / MTok", "$0.30 / M tokens", "$12.50": a dollar price. "-", "Free" and an empty cell are no price. */
function price(cell: string, what: string): number | undefined {
  const c = clean(cell);
  if (/^(-|—|free|n\/a)?$/i.test(c)) return undefined;
  const m = /^\$\s*(\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s*\/\s*(?:MTok|M tokens|1M tokens))?$/i.exec(c);
  if (!m) fail(`${what}: cannot read the price "${c}"`);
  return Number(m[1]!.replace(/,/g, ""));
}

function column(header: string[], test: RegExp): number {
  return header.findIndex((h) => test.test(clean(h)));
}

function entry(name: string, id: string, r: Rates, scheduled?: Scheduled[], unlisted?: FieldName[]): OfficialEntry {
  return { key: name, id, provider: "official", ...r, ...(scheduled?.length ? { scheduled } : {}), ...(unlisted?.length ? { unlisted } : {}) };
}

const noRead = (cached: number | undefined): FieldName[] => (cached === undefined ? ["cacheRead"] : []);

/** Collects entries by id: the same model twice with the same prices is fine, with two prices it is an error. */
class Collector {
  private byId = new Map<string, OfficialEntry>();
  add(e: OfficialEntry): void {
    const old = this.byId.get(e.id);
    if (old) {
      const same = (["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const).every((f) => round6(old[f]) === round6(e[f]));
      if (!same) fail(`${e.id} is listed twice with different prices`);
      return;
    }
    this.byId.set(e.id, e);
  }
  all(min: number, what: string): OfficialEntry[] {
    if (this.byId.size < min) fail(`only ${this.byId.size} models found in ${what}, the page format may have changed`);
    return [...this.byId.values()];
  }
}

const withoutParens = (s: string) => clean(s).replace(/\s*\(.*$/, "").trim();

/** A maker that charges nothing extra for cache writes and lists "-" for a model without a cached-input price. */
function plainRates(input: number, output: number, cached: number | undefined, write?: number): Rates {
  const w = write ?? input;
  return { input, output, cacheRead: cached ?? input, cacheWrite5m: w, cacheWrite1h: w };
}

// --- Anthropic ----------------------------------------------------------------------------------------------------

/** "Claude Opus 5.5" is claude-opus-5-5, "Claude Haiku 3.5" is claude-3-5-haiku: 3.x models put the version first. */
export function anthropicId(name: string): string {
  const m = /^Claude ([A-Za-z]+) (\d+(?:\.\d+)?)$/.exec(name);
  if (!m) fail(`unrecognised Claude model name "${name}"`);
  const family = m[1]!.toLowerCase();
  const version = m[2]!.replace(".", "-");
  return Number(m[2]!.split(".")[0]) < 4 ? `claude-${version}-${family}` : `claude-${family}-${version}`;
}

export function parseAnthropic(text: string): ParseResult {
  const tables = mdTables(text);
  const main = tables.find((t) => column(t.header, /^Model$/) === 0 && column(t.header, /Base input/i) > 0 && column(t.header, /5m cache/i) > 0);
  if (!main) fail("the model pricing table was not found");
  const [iName, iIn, iW5, iW1, iRead, iOut] = [
    column(main.header, /^Model$/),
    column(main.header, /Base input/i),
    column(main.header, /5m cache/i),
    column(main.header, /1h cache/i),
    column(main.header, /Cache hits/i),
    column(main.header, /^Output/i),
  ];
  if ([iW1, iRead, iOut].some((i) => i < 0)) fail("the model pricing table has no cache or output column");
  const col = new Collector();
  for (const row of main.rows) {
    const name = withoutParens(row[iName] ?? "");
    const need = (i: number, what: string) => price(row[i] ?? "", `${name} ${what}`) ?? fail(`${name} has no ${what}`);
    const rates: Rates = {
      input: need(iIn, "input price"),
      output: need(iOut, "output price"),
      cacheRead: need(iRead, "cache read price"),
      cacheWrite5m: need(iW5, "5m cache write price"),
      cacheWrite1h: need(iW1, "1h cache write price"),
    };
    col.add(entry(name, anthropicId(name), rates));
  }
  const entries = col.all(5, "the Anthropic pricing table");

  // Fast mode is priced at 2x in PriceBook.cost(): check the page still says so.
  const warnings: string[] = [];
  const notes: string[] = [];
  const fast = tables.find((t) => /fast mode/i.test(t.heading) && column(t.header, /^Input/i) > 0);
  if (!fast) warnings.push("The fast mode price table was not found, so the 2x fast mode multiplier could not be checked");
  else {
    const [fi, fo] = [column(fast.header, /^Input/i), column(fast.header, /^Output/i)];
    let checked = 0;
    for (const row of fast.rows) {
      const input = price(row[fi] ?? "", "fast mode input");
      const output = price(row[fo] ?? "", "fast mode output");
      for (const part of withoutParens(row[0] ?? "").split(/\s*\/\s*/)) {
        const std = entries.find((e) => e.id === anthropicId(part));
        if (!std || input === undefined || output === undefined) {
          warnings.push(`Fast mode lists ${part}, which the standard table does not, or its price could not be read`);
          continue;
        }
        checked++;
        if (round6(input) !== round6(std.input * 2) || round6(output) !== round6(std.output * 2)) {
          warnings.push(`Fast mode for ${part} is $${input} in and $${output} out, not 2x the standard $${std.input} and $${std.output}, so the 2x multiplier in pricing.ts is out of date`);
        }
      }
    }
    if (checked > 0 && warnings.length === 0) notes.push(`Fast mode is still 2x the standard price (${checked} models checked).`);
  }
  return { entries, notes, warnings };
}

// --- OpenAI -------------------------------------------------------------------------------------------------------

/** Standard tier, short context. The batch, flex, fast and ultrafast tables have the same columns and are not read. */
export function parseOpenAI(text: string): ParseResult {
  const col = new Collector();
  for (const t of mdTables(text)) {
    const iIn = column(t.header, /^Short context input$/i);
    if (column(t.header, /^Model$/) !== 0 || iIn < 0) continue;
    if (!/^(Standard pricing data|Grouped Pricing Table data)$/.test(t.heading)) continue;
    const [iRead, iWrite, iOut] = [column(t.header, /^Short context cached input$/i), column(t.header, /^Short context cache writes$/i), column(t.header, /^Short context output$/i)];
    if (iRead < 0 || iWrite < 0 || iOut < 0) fail("the standard pricing table lost a column");
    for (const row of t.rows) {
      const name = withoutParens(row[0] ?? "");
      if (!/^[a-z][a-z0-9.-]*$/.test(name)) fail(`unrecognised OpenAI model name "${name}"`);
      const input = price(row[iIn] ?? "", `${name} input`);
      const output = price(row[iOut] ?? "", `${name} output`);
      if (input === undefined || output === undefined) fail(`${name} has no input or output price`);
      const cached = price(row[iRead] ?? "", `${name} cached input`);
      col.add(entry(name, normalizeModel(name), plainRates(input, output, cached, price(row[iWrite] ?? "", `${name} cache write`)), undefined, noRead(cached)));
    }
  }
  return { entries: col.all(5, "the OpenAI standard pricing table"), notes: [], warnings: [] };
}

// --- Google -------------------------------------------------------------------------------------------------------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function isoDate(text: string): string {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  if (!m || month < 0) fail(`cannot read the date "${text}"`);
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}

/**
 * A paid-tier cell: "$2.00, prompts <= 200k tokens $4.00, prompts > 200k tokens", "$0.30 (text) $1.00 (audio)",
 * "$0.03 $1.00 / 1,000,000 tokens per hour (storage price)" or an introductory price "$0.75 through December 31, 2026.
 * $1.50 starting January 1, 2027." The first price is the one for short prompts and text. Returns the price valid
 * today and the later one, if the cell announces one.
 */
function googleCell(raw: string, today: string, what: string): { now: number; later?: { from: string; value: number } } | undefined {
  const c = clean(raw).replace(/\^[^^]*\^/g, "").replace(/\$\s*[\d.]+\s*\/\s*1,000,000 tokens per hour.*$/, "").trim();
  if (!c.includes("$")) return undefined;
  const dated = /^\$([\d.]+) through ([A-Za-z]+ \d{1,2}, \d{4})\.\s*\$([\d.]+) starting ([A-Za-z]+ \d{1,2}, \d{4})\.?$/.exec(c);
  if (dated) {
    const from = isoDate(dated[4]!);
    const [a, b] = [Number(dated[1]), Number(dated[3])];
    return today >= from ? { now: b } : { now: a, later: { from, value: b } };
  }
  if (/through|starting/i.test(c)) fail(`${what}: cannot read the dated price "${c}"`);
  const m = /^\$(\d+(?:\.\d+)?)(?=\s|$|,)/.exec(c);
  if (!m) fail(`${what}: cannot read the price "${c}"`);
  return { now: Number(m[1]) };
}

const GOOGLE_SKIPPED_SECTION = /image|tts|live|transcribe|translate|omni|embedding|robotics|veo|lyria|nano banana|audio/i;

/** Paid tier, Standard, prompts up to 200k, text input. Context caching is the cache READ price, the hourly storage fee is not read. */
export function parseGoogle(text: string, today: string): ParseResult {
  const col = new Collector();
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    const title = lines[0]!;
    if (GOOGLE_SKIPPED_SECTION.test(title)) continue;
    const idLine = lines.slice(1, 6).find((l) => l.trim().startsWith("*["));
    const ids = idLine ? [...idLine.matchAll(/`([^`]+)`/g)].map((m) => m[1]!) : [];
    if (ids.length === 0) continue; // Gemma and other pages without a model id line
    const start = lines.findIndex((l) => /^### Standard\s*$/.test(l));
    if (start < 0) continue;
    const rows: Record<"input" | "output" | "cache", string | undefined> = { input: undefined, output: undefined, cache: undefined };
    for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("###"); i++) {
      const l = lines[i]!;
      if (!l.startsWith("|")) continue;
      const c = cells(l);
      const paid = c[c.length - 1];
      if (/^Input price/i.test(c[0] ?? "")) rows.input = paid;
      else if (/^Output price/i.test(c[0] ?? "")) rows.output = paid;
      else if (/^Context caching price/i.test(c[0] ?? "")) rows.cache = paid;
    }
    const what = ids[0]!;
    const input = rows.input === undefined ? undefined : googleCell(rows.input, today, `${what} input`);
    const output = rows.output === undefined ? undefined : googleCell(rows.output, today, `${what} output`);
    if (!input || !output) continue; // not offered on the paid tier, or not a per-token model
    const cache = rows.cache === undefined ? undefined : googleCell(rows.cache, today, `${what} context caching`);
    const rates = plainRates(input.now, output.now, cache?.now);
    const later: Record<string, Partial<Record<FieldName, number>>> = {};
    for (const [field, cell] of [["input", input], ["output", output], ["cacheRead", cache]] as const) {
      if (cell?.later) (later[cell.later.from] ??= {})[field] = cell.later.value;
    }
    const scheduled = Object.entries(later).map(([from, to]): Scheduled => ({ from, to }));
    for (const id of ids) col.add(entry(id, normalizeModel(id), rates, scheduled, noRead(cache?.now)));
  }
  return { entries: col.all(5, "the Gemini pricing page"), notes: [], warnings: [] };
}

// --- Z.ai ---------------------------------------------------------------------------------------------------------

export function parseZai(text: string): ParseResult {
  const col = new Collector();
  for (const t of mdTables(text)) {
    const [iIn, iRead, iOut] = [column(t.header, /^Input$/i), column(t.header, /^Cached Input$/i), column(t.header, /^Output$/i)];
    if (column(t.header, /^Model$/) !== 0 || iIn < 0 || iOut < 0) continue;
    for (const row of t.rows) {
      const name = clean(row[0] ?? "");
      if (!/^GLM-[A-Za-z0-9.-]+$/.test(name)) fail(`unrecognised Z.ai model name "${name}"`);
      const input = price(row[iIn] ?? "", `${name} input`);
      const output = price(row[iOut] ?? "", `${name} output`);
      if (input === undefined || output === undefined) continue; // free models
      const cached = iRead < 0 ? undefined : price(row[iRead] ?? "", `${name} cached input`);
      col.add(entry(name, normalizeModel(name), plainRates(input, output, cached), undefined, noRead(cached)));
    }
  }
  return { entries: col.all(5, "the Z.ai pricing page"), notes: [], warnings: [] };
}

// --- xAI ----------------------------------------------------------------------------------------------------------

/** Prompts under 200k tokens. The ids on the page carry a release date ("grok-4.20-0309-reasoning"), the rules don't. */
export function parseXai(text: string): ParseResult {
  const col = new Collector();
  const t = mdTables(text).find((x) => /text api pricing/i.test(x.heading) && column(x.header, /^Model$/) === 0);
  if (!t) fail("the text API pricing table was not found");
  const [iIn, iRead, iOut] = [column(t.header, /^Input/i), column(t.header, /^Cached input/i), column(t.header, /^Output/i)];
  if (iIn < 0 || iRead < 0 || iOut < 0) fail("the text API pricing table lost a column");
  for (const row of t.rows) {
    const label = clean(row[0] ?? "");
    if (/[≥>]\s*\d+k/i.test(label)) continue; // the long-context tier
    const name = label.replace(/\s*\(.*$/, "");
    if (!/^grok-[a-z0-9.-]+$/.test(name)) fail(`unrecognised xAI model name "${label}"`);
    const input = price(row[iIn] ?? "", `${name} input`);
    const output = price(row[iOut] ?? "", `${name} output`);
    if (input === undefined || output === undefined) fail(`${name} has no input or output price`);
    col.add(entry(name, normalizeModel(name).replace(/-\d{4}(?=-|$)/, ""), plainRates(input, output, price(row[iRead] ?? "", `${name} cached input`))));
  }
  return { entries: col.all(3, "the xAI pricing table"), notes: [], warnings: [] };
}

// --- Moonshot (Kimi) ----------------------------------------------------------------------------------------------

/** The page is MDX: <DocTable columns={[{ title: "…" }]} rows={[["kimi-k3", "1M tokens", <>{"$"}3.00</>, …]]} />. */
export function parseMoonshot(text: string): ParseResult {
  const col = new Collector();
  for (const block of text.split(/<DocTable\b/).slice(1)) {
    const end = block.search(/^\/>/m); // the tag's own closing line, not a "</>" fragment
    const body = end < 0 ? block : block.slice(0, end);
    const columnsAt = body.indexOf("columns={[");
    const rowsAt = body.indexOf("rows={[");
    if (columnsAt < 0 || rowsAt < 0 || rowsAt < columnsAt) continue;
    const titles = [...body.slice(columnsAt, rowsAt).matchAll(/title:\s*"([^"]*)"/g)].map((m) => m[1]!);
    const find = (re: RegExp) => titles.findIndex((x) => re.test(x));
    const [iName, iIn, iRead, iOut, iW5, iW1] = [find(/^Model$/i), find(/^Input Price( \(Cache Miss\))?$/i), find(/Cached Input Price|Cache Hit/i), find(/^Output Price$/i), find(/Cache Write.*5\s*min/i), find(/Cache Write.*1\s*h/i)];
    if (iName < 0 || iIn < 0 || iRead < 0 || iOut < 0) continue;
    for (const line of body.slice(rowsAt).split(/\r?\n/)) {
      if (!line.trim().startsWith('["')) continue;
      const row = [...line.matchAll(/"([^"]*)"|<>\{"\$"\}(\d+(?:\.\d+)?)<\/>/g)].map((m) => m[1] ?? `$${m[2]}`);
      const name = row[iName] ?? "";
      if (!/^kimi-[a-z0-9.-]+$/.test(name)) fail(`unrecognised Kimi model name "${name}"`);
      const num = (i: number, what: string) => (i < 0 ? undefined : price(row[i] ?? "", `${name} ${what}`));
      const input = num(iIn, "input");
      const output = num(iOut, "output");
      if (input === undefined || output === undefined) fail(`${name} has no input or output price`);
      const w5 = num(iW5, "cache write 5m");
      const w1 = num(iW1, "cache write 1h");
      const r = plainRates(input, output, num(iRead, "cached input"), w5);
      col.add(entry(name, normalizeModel(name), { ...r, cacheWrite1h: w1 ?? r.cacheWrite5m }));
    }
  }
  return { entries: col.all(2, "the Moonshot pricing page"), notes: [], warnings: [] };
}

// --- MiniMax ------------------------------------------------------------------------------------------------------

/** The Standard tier ("Priority" is 1.5x), prompts up to 512k tokens, and the price after any strike-through discount. */
export function parseMiniMax(text: string): ParseResult {
  const col = new Collector();
  for (const t of mdTables(text)) {
    if (t.tab !== undefined && t.tab !== "Standard") continue;
    const [iIn, iOut, iRead, iWrite] = [column(t.header, /^Input$/i), column(t.header, /^Output$/i), column(t.header, /Prompt caching Read/i), column(t.header, /Prompt caching Write/i)];
    if (column(t.header, /^Model$/) !== 0 || iIn < 0 || iOut < 0 || iRead < 0) continue;
    for (const row of t.rows) {
      const [head, ...rest] = (row[0] ?? "").replace(/\*\*/g, "").split(/<br\s*\/?>/);
      const name = clean(head ?? "");
      if (!/^MiniMax-[A-Za-z0-9.-]+$/.test(name)) fail(`unrecognised MiniMax model name "${name}"`);
      if (/^\s*>\s*\d/.test(clean(rest.join(" ")))) continue; // the long-context tier
      const input = price(row[iIn] ?? "", `${name} input`);
      const output = price(row[iOut] ?? "", `${name} output`);
      if (input === undefined || output === undefined) fail(`${name} has no input or output price`);
      const write = iWrite < 0 ? undefined : price(row[iWrite] ?? "", `${name} cache write`);
      col.add(entry(name, normalizeModel(name), plainRates(input, output, price(row[iRead] ?? "", `${name} cache read`), write)));
    }
  }
  return { entries: col.all(2, "the MiniMax pricing page"), notes: [], warnings: [] };
}

// --- registry -----------------------------------------------------------------------------------------------------

export const OFFICIAL_SOURCES: OfficialSource[] = [
  { key: "anthropic", maker: "Anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing.md", parse: (t) => parseAnthropic(t) },
  { key: "openai", maker: "OpenAI", url: "https://developers.openai.com/api/docs/pricing.md", parse: (t) => parseOpenAI(t) },
  { key: "google", maker: "Google Gemini", url: "https://ai.google.dev/gemini-api/docs/pricing.md.txt", parse: parseGoogle },
  { key: "zai", maker: "Z.ai (GLM)", url: "https://docs.z.ai/guides/overview/pricing.md", parse: (t) => parseZai(t) },
  { key: "xai", maker: "xAI", url: "https://docs.x.ai/developers/models.md", parse: (t) => parseXai(t) },
  { key: "moonshot", maker: "Moonshot (Kimi)", url: "https://platform.kimi.ai/docs/pricing/chat.md", parse: (t) => parseMoonshot(t) },
  { key: "minimax", maker: "MiniMax", url: "https://platform.minimax.io/docs/guides/pricing-paygo.md", parse: (t) => parseMiniMax(t) },
];

/** Makers whose official page has no stable, machine-readable price. They stay on LiteLLM and OpenRouter. */
export const OFFICIAL_UNAVAILABLE: Record<string, string> = {
  DeepSeek: "the page is HTML only, and lists peak and off-peak prices per model",
  "Alibaba Qwen": "the page is a huge HTML table that differs by region, tier and thinking mode",
  Mistral: "the price list is not published as text, only on a script-rendered page",
};

export interface OfficialOutcome {
  maker: string;
  entries?: OfficialEntry[];
  notes?: string[];
  warnings?: string[];
  /** The page could not be fetched or read: nothing from it is used. */
  error?: string;
  /** No machine-readable official page exists. */
  unavailable?: string;
}

/** Fetches and parses every official page. One page failing never affects the others. */
export async function loadOfficial(today: string, read: (source: OfficialSource) => Promise<string>): Promise<OfficialOutcome[]> {
  const out: OfficialOutcome[] = [];
  for (const source of OFFICIAL_SOURCES) {
    try {
      const r = source.parse(await read(source), today);
      out.push({ maker: source.maker, ...r });
    } catch (e) {
      out.push({ maker: source.maker, error: (e as Error).message });
    }
  }
  for (const [maker, unavailable] of Object.entries(OFFICIAL_UNAVAILABLE)) out.push({ maker, unavailable });
  return out;
}

export async function fetchOfficial(source: OfficialSource): Promise<string> {
  // No Accept header: docs.x.ai answers 404 to one that lists text/plain.
  const res = await fetch(source.url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail(`HTTP ${res.status} from ${source.url}`);
  const type = res.headers.get("content-type") ?? "";
  if (/html/i.test(type)) fail(`${source.url} answered with HTML, not Markdown`);
  return res.text();
}
