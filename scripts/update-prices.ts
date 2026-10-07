/**
 * Weekly price check: compares the built-in prices in src/core/pricing.ts with the makers' own pricing pages, LiteLLM's
 * community-maintained list and OpenRouter's model list, then updates the numbers that changed and adds the models
 * that are missing. The app never fetches prices itself. This script runs in .github/workflows/prices.yml, which
 * opens a pull request for a human to review.
 *
 * The order is always: 1st the maker's official pricing page (scripts/official-prices.ts), 2nd the rest.
 *   - the official page lists the model: its price wins outright, even when an aggregator says less. Every rate where
 *     LiteLLM or OpenRouter differs by more than 1% is listed in the report for review.
 *   - the official page has no price for the model, or could not be read (that maker then falls back for this run):
 *     per rate (input, output, cache read, each cache write) LiteLLM and OpenRouter are compared:
 *       - they agree within 1%: LiteLLM's value is used
 *       - they disagree: the HIGHER value is used (overestimating is safer than underestimating for a cost dashboard)
 *         and the disagreement is listed in the report with both values and the maker's official pricing page
 *       - only one source has the model: an existing price is never changed. A new model is added only when the single
 *         source is LiteLLM's entry from the maker's own provider. Reseller-only and OpenRouter-only prices are never added.
 *   - a model on an official page that no rule prices is added with its exact id.
 *
 *   bun scripts/update-prices.ts [--dry-run] [--report report.md] [--source litellm.json] [--openrouter models.json]
 *                                [--official-dir dir | --no-official] [--pricing path]
 *
 * Exit 0: nothing to do, or changes written (`changed=true` goes to $GITHUB_OUTPUT). Exit 1: error or a change
 * that needs a human (a price moving more than 10x, dropping to 0, or more than half of the existing rules at once).
 */
import { appendFileSync } from "node:fs";
import { normalizeModel } from "../src/core/models.ts";
import { FIELD_ORDER, fetchOfficial, loadOfficial, round6, type FieldName, type OfficialEntry, type OfficialOutcome, type Rates } from "./official-prices.ts";

export { round6 };
export type { Rates };

export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

export interface SourceEntry {
  key: string;
  id: string; // normalized
  provider: string; // LiteLLM's provider key, or "openrouter"
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  /** Image, audio or video output: not a text model. */
  nonText?: boolean;
  /** YYYY-MM-DD from which the model is gone. */
  endOfLife?: string;
}

export interface Rule {
  pattern: string;
  line: number;
  fields: Partial<Record<FieldName, number>>;
}

const FIELD_LABEL: Record<FieldName, string> = {
  input: "input",
  output: "output",
  cacheRead: "cache read",
  cacheWrite5m: "cache write 5m",
  cacheWrite1h: "cache write 1h",
};
type Fields = Partial<Record<FieldName, number>>;

/** Where a final price came from. */
export type SourceKind = "official" | "aggregators agree" | "higher of aggregators" | "single source";

export interface Change {
  rule: Rule;
  kind: SourceKind;
  source: string; // LiteLLM key
  orSource: string; // OpenRouter id
  official: string; // the model's name on the official page
  before: Rates;
  after: Rates;
  /** The fields to write on the rule line. */
  write: Fields;
}

export interface Disagreement {
  target: string; // rule pattern or new model id
  kind: "update" | "new";
  maker: string;
  litellm: string;
  openrouter: string;
  fields: { field: FieldName; litellm: number; openrouter: number; used: number }[];
}

/** An aggregator that says something other than the official page, which wins. */
export interface OfficialDiff {
  target: string;
  kind: "update" | "new";
  maker: string;
  official: string;
  litellm: string;
  openrouter: string;
  fields: { field: FieldName; official: number; litellm?: number; openrouter?: number }[];
}

export interface Addition {
  id: string;
  makerIndex: number;
  kind: SourceKind;
  official: string; // the model's name on the official page, or ""
  litellm: string; // "" when there is no first-party LiteLLM entry
  openrouter?: string;
  rates: Rates;
  write: Fields;
}

export interface OfficialStatus {
  maker: string;
  state: "read" | "failed" | "unavailable";
  models: number;
  /** The failure, or why the maker has no machine-readable official price. */
  detail: string;
  notes: string[];
  warnings: string[];
}

export interface ScheduledChange {
  target: string;
  from: string;
  changes: { field: FieldName; now: number; then: number }[];
}

export interface Plan {
  rules: Rule[];
  changes: Change[];
  additions: Addition[];
  disagreements: Disagreement[];
  officialDiffs: OfficialDiff[];
  official: OfficialStatus[];
  scheduled: ScheduledChange[];
  /** The source of every existing rule's final price. */
  sources: { pattern: string; kind: SourceKind }[];
  /** Existing rules with one source only, or a rate only one source has, whose value differs from ours: left alone. */
  keptSingle: { pattern: string; field: FieldName; current: number; value: number; from: string }[];
  unchanged: number;
  unmatched: string[]; // rules with no source entry at all
  fallbackSources: { pattern: string; key: string }[];
  skipped: { reason: string; ids: string[] }[];
  problems: string[];
}

const PER_MILLION = 1e6;

/** A per-token price → USD per 1M tokens. */
export function perMillion(perToken: number): number {
  return round6(perToken * PER_MILLION);
}

// --- makers -------------------------------------------------------------------------------------------------

interface Maker {
  name: string;
  /** Normalized ids of this maker. */
  test: RegExp;
  /** LiteLLM provider keys that are the maker's own API. Cloud resellers (Bedrock, Vertex, Azure) are only a fallback. */
  providers: string[];
  /** OpenRouter vendor prefixes. */
  vendors: string[];
  /** Comment line for a section that doesn't exist in pricing.ts yet. */
  heading: string;
  page: string;
  /** Claude-style cache prices: derived 0.1x read, 1.25x and 2x writes. */
  derivedCache?: boolean;
}

const MAKERS: Maker[] = [
  { name: "Anthropic", test: /^claude-/, providers: ["anthropic"], vendors: ["anthropic"], heading: "", page: "https://platform.claude.com/docs/en/about-claude/pricing", derivedCache: true },
  { name: "OpenAI", test: /^(gpt-|o\d|codex)/, providers: ["openai"], vendors: ["openai"], heading: "", page: "https://developers.openai.com/api/docs/pricing" },
  { name: "Google Gemini", test: /^gemini-/, providers: ["gemini"], vendors: ["google"], heading: "", page: "https://ai.google.dev/gemini-api/docs/pricing" },
  { name: "Z.ai (GLM)", test: /^glm-/, providers: ["zai"], vendors: ["z-ai"], heading: "", page: "https://docs.z.ai/guides/overview/pricing" },
  { name: "xAI", test: /^grok-/, providers: ["xai"], vendors: ["x-ai"], heading: "xAI — cached input is discounted, no cache-write charge.", page: "https://docs.x.ai/docs/models" },
  { name: "DeepSeek", test: /^deepseek-/, providers: ["deepseek"], vendors: ["deepseek"], heading: "DeepSeek — cache hits are discounted, no cache-write charge.", page: "https://api-docs.deepseek.com/quick_start/pricing" },
  { name: "Moonshot (Kimi)", test: /^kimi-/, providers: ["moonshot"], vendors: ["moonshotai"], heading: "Moonshot (Kimi) — cache hits are discounted, no cache-write charge.", page: "https://platform.kimi.ai/docs/pricing/chat" },
  { name: "Alibaba Qwen", test: /^qwen/, providers: ["dashscope", "qwencloud", "qwen_ai_platform"], vendors: ["qwen"], heading: "Alibaba Qwen — base tier prices, cache write as listed.", page: "https://www.alibabacloud.com/help/en/model-studio/models" },
  { name: "Mistral", test: /^(mistral-|devstral-|codestral-)/, providers: ["mistral"], vendors: ["mistralai"], heading: "Mistral — cached input is discounted, no cache-write charge.", page: "https://mistral.ai/pricing#api-pricing" },
  { name: "MiniMax", test: /^minimax-/, providers: ["minimax"], vendors: ["minimax"], heading: "MiniMax — cache read and write as listed.", page: "https://platform.minimax.io/docs/guides/pricing-paygo" },
];
const RESELLERS = ["vertex_ai-language-models", "vertex_ai", "bedrock_converse", "bedrock", "azure"];

function makerIndex(id: string): number {
  return MAKERS.findIndex((m) => m.test.test(id));
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** Dated snapshots: "-2025-04-14", "-20250514", "-0613", "-05-06", "-001". */
const DATE_SEGMENT = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4}|\d{2}-\d{2}|0\d{2})(?=-|$)/;
/** Moving aliases and pre-release variants of a model that has its own id. */
const ALIAS_ID = /-latest|-beta|-experimental|-exp(?:-|$)|-gv2/;
/** Older generations that are still listed but are not what harnesses run today. */
const LEGACY_ID = /^(gpt-3|gpt-4$|gpt-4-|o1|gemini-(1\.|2\.0|exp|gemma)|deepseek-(coder|r1$|v3$)|mistral-(tiny|vibe)|glm-4-)/;
/** Image, audio, embedding, realtime and search-only models. */
const NON_TEXT_ID = /audio|realtime|-live|image|tts|transcribe|search|embed|whisper|moderation|ocr|robotics|computer-use|diarize|imagen|lyria|veo|sora|omni/;

// --- LiteLLM data -------------------------------------------------------------------------------------------

function optionalPrice(entry: Record<string, unknown>, field: string, key: string): number | undefined {
  const v = entry[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`${key}: ${field} is not a non-negative number (${JSON.stringify(v)})`);
  return v;
}

function scaled(n: number | undefined): number | undefined {
  return n === undefined ? undefined : perMillion(n);
}

/** Strict parse: anything that doesn't look like LiteLLM's file is an error, never silently skipped. */
export function parseLiteLLM(data: unknown): SourceEntry[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("LiteLLM data is not a JSON object");
  const out: SourceEntry[] = [];
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    if (key === "sample_spec") continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${key}: entry is not an object`);
    const e = raw as Record<string, unknown>;
    const mode = e.mode;
    if (mode !== "chat" && mode !== "responses") continue; // embeddings, images, audio, and metadata blocks
    if (typeof e.litellm_provider !== "string") fail(`${key}: litellm_provider is missing`);
    const input = optionalPrice(e, "input_cost_per_token", key);
    const output = optionalPrice(e, "output_cost_per_token", key);
    if (input === undefined || output === undefined) continue; // no list price to compare (tiered or free-form)
    const dep = e.deprecation_date;
    out.push({
      key,
      id: normalizeModel(key),
      provider: e.litellm_provider,
      input: perMillion(input),
      output: perMillion(output),
      cacheRead: scaled(optionalPrice(e, "cache_read_input_token_cost", key)),
      cacheWrite5m: scaled(optionalPrice(e, "cache_creation_input_token_cost", key)),
      cacheWrite1h: scaled(optionalPrice(e, "cache_creation_input_token_cost_above_1hr", key)),
      nonText: e.supports_audio_output === true || e.output_cost_per_image !== undefined || e.output_cost_per_audio_token !== undefined,
      endOfLife: typeof dep === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dep) ? dep : undefined,
    });
  }
  // A file that lost its main providers is broken, not "no changes".
  for (const provider of ["anthropic", "openai", "gemini"]) {
    if (!out.some((e) => e.provider === provider)) fail(`LiteLLM data has no ${provider} chat models, the format may have changed`);
  }
  return out;
}

// --- OpenRouter data ----------------------------------------------------------------------------------------

function orPrice(p: Record<string, unknown>, field: string, id: string): number | undefined {
  const v = p[field];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) fail(`OpenRouter ${id}: pricing.${field} is not a non-negative number (${JSON.stringify(v)})`);
  return n;
}

/**
 * Strict parse of GET /api/v1/models. Prices are per-token strings. Only the base tier is read: `pricing.overrides`
 * holds the higher long-context tiers. Variants (":batch", ":free"), "~" aliases, routers priced "-1" and models
 * with image or audio output are left out.
 */
export function parseOpenRouter(data: unknown): SourceEntry[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("OpenRouter data is not a JSON object");
  const list = (data as Record<string, unknown>).data;
  if (!Array.isArray(list) || list.length === 0) fail("OpenRouter data has no model list");
  const out: SourceEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("OpenRouter entry is not an object");
    const e = raw as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id === "") fail("OpenRouter entry without an id");
    const id = e.id;
    const p = e.pricing;
    if (!p || typeof p !== "object" || Array.isArray(p)) fail(`OpenRouter ${id}: pricing is missing`);
    const pr = p as Record<string, unknown>;
    if (pr.prompt === "-1" || pr.completion === "-1") continue; // routers with no fixed price
    if (id.startsWith("~") || id.includes(":")) continue;
    const input = orPrice(pr, "prompt", id);
    const output = orPrice(pr, "completion", id);
    if (input === undefined || output === undefined) fail(`OpenRouter ${id}: prompt or completion price is missing`);
    const outputs = (e.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
    const exp = e.expiration_date;
    out.push({
      key: id,
      id: normalizeModel(id),
      provider: "openrouter",
      input: perMillion(input),
      output: perMillion(output),
      cacheRead: scaled(orPrice(pr, "input_cache_read", id)),
      cacheWrite5m: scaled(orPrice(pr, "input_cache_write", id)),
      cacheWrite1h: scaled(orPrice(pr, "input_cache_write_1h", id)),
      nonText: Array.isArray(outputs) && outputs.some((o) => o !== "text"),
      endOfLife: typeof exp === "string" && /^\d{4}-\d{2}-\d{2}/.test(exp) ? exp.slice(0, 10) : undefined,
    });
  }
  for (const vendor of ["anthropic/", "openai/", "google/"]) {
    if (!out.some((e) => e.key.startsWith(vendor))) fail(`OpenRouter data has no ${vendor} models, the format may have changed`);
  }
  return out;
}

// --- pricing.ts ---------------------------------------------------------------------------------------------

const RULE_LINE = /^(\s*\{ pattern: ")([^"]+)(",)(.*?)( \},?)(.*)$/;

export function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  source.split(/\r?\n/).forEach((text, line) => {
    const m = RULE_LINE.exec(text);
    if (!m) return;
    const fields: Rule["fields"] = {};
    for (const f of m[4]!.matchAll(/(\w+): ([\d.e+-]+)/g)) {
      if (!FIELD_ORDER.includes(f[1] as FieldName)) fail(`pricing.ts line ${line + 1}: unknown field ${f[1]}`);
      fields[f[1] as FieldName] = Number(f[2]);
    }
    if (fields.input === undefined || fields.output === undefined) fail(`pricing.ts line ${line + 1}: rule without input or output`);
    rules.push({ pattern: m[2]!, line, fields });
  });
  if (rules.length === 0) fail("no price rules found in pricing.ts");
  return rules;
}

/** Same rates PriceBook.rates() reports: missing cache fields derived from input. */
export function effective(f: Rule["fields"]): Rates {
  const input = f.input!;
  return {
    input,
    output: f.output!,
    cacheRead: f.cacheRead ?? round6(input * 0.1),
    cacheWrite5m: f.cacheWrite5m ?? round6(input * 1.25),
    cacheWrite1h: f.cacheWrite1h ?? round6(input * 2),
  };
}

function matches(pattern: string, id: string): boolean {
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

/** Longest prefix wins, exact ids beat prefixes: the same order PriceBook uses. */
function specificity(pattern: string): number {
  return pattern.endsWith("*") ? pattern.length - 1 : pattern.length + 1000;
}

function winningRule(rules: Rule[], id: string): Rule | undefined {
  let best: Rule | undefined;
  for (const r of rules) if (matches(r.pattern, id) && (!best || specificity(r.pattern) > specificity(best.pattern))) best = r;
  return best;
}

/**
 * A prefix rule such as "claude-opus-4*" also catches "claude-opus-4-9", a newer model with its own price.
 * Only ids that continue the stem with something other than a version number count as the same model.
 */
function belongsToRule(rule: Rule, id: string): boolean {
  if (!rule.pattern.endsWith("*")) return id === rule.pattern;
  const stem = rule.pattern.slice(0, -1);
  if (id === stem) return true;
  return !/^[-.]?\d/.test(id.slice(stem.length));
}

/** The entry that gives a rule its price: the stem itself, else the shortest id that continues it. */
function pickCanonical<T extends SourceEntry>(stem: string, pool: T[]): T | undefined {
  const rank = (e: T) => [e.id === stem ? 0 : 1, RESELLERS.indexOf(e.provider), e.id.length, e.key.length, e.key] as const;
  return [...pool].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i]! < y[i]!) return -1; else if (x[i]! > y[i]!) return 1;
    return 0;
  })[0];
}

// --- comparing the two sources ------------------------------------------------------------------------------

function agree(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01 * Math.max(a, b);
}

/** What a source says per rate. Rates it doesn't list are undefined, except Claude's, which are derived. */
function sourceRates(e: SourceEntry, derived: boolean): Fields {
  const r: Fields = { input: e.input, output: e.output };
  if (derived) {
    r.cacheRead = e.cacheRead ?? round6(e.input * 0.1);
    r.cacheWrite5m = e.cacheWrite5m ?? round6(e.input * 1.25);
    r.cacheWrite1h = e.cacheWrite1h ?? round6(e.input * 2);
    return r;
  }
  r.cacheRead = e.cacheRead;
  // A cache write below the input price is a storage fee (Gemini), not a write rate.
  const write = (v: number | undefined) => (v !== undefined && v > 0 && v >= e.input * 0.999 ? v : undefined);
  r.cacheWrite5m = write(e.cacheWrite5m);
  r.cacheWrite1h = write(e.cacheWrite1h);
  return r;
}

interface Resolved {
  /** Rates both sources list: agreed (LiteLLM's value) or the higher one. */
  both: Fields;
  /** Rates only LiteLLM lists. */
  llOnly: Fields;
  disagree: { field: FieldName; litellm: number; openrouter: number; used: number }[];
}

function resolve(ll: SourceEntry, or: SourceEntry | undefined, derived: boolean): Resolved {
  const a = sourceRates(ll, derived);
  const b = or ? sourceRates(or, derived) : {};
  const res: Resolved = { both: {}, llOnly: {}, disagree: [] };
  for (const f of FIELD_ORDER) {
    const x = a[f];
    const y = b[f];
    if (x !== undefined && y !== undefined) {
      if (agree(x, y)) res.both[f] = x;
      else {
        const used = Math.max(x, y);
        res.both[f] = used;
        res.disagree.push({ field: f, litellm: x, openrouter: y, used });
      }
    } else if (x !== undefined) res.llOnly[f] = x;
  }
  return res;
}

/** The rule line fields for a full set of rates: Claude's derived cache prices stay implicit. */
function writeFields(rates: Rates, explicit: boolean): Fields {
  const w: Fields = { input: rates.input, output: rates.output };
  if (explicit || rates.cacheRead !== round6(rates.input * 0.1)) w.cacheRead = rates.cacheRead;
  if (explicit || rates.cacheWrite5m !== round6(rates.input * 1.25)) w.cacheWrite5m = rates.cacheWrite5m;
  if (explicit || rates.cacheWrite1h !== round6(rates.input * 2)) w.cacheWrite1h = rates.cacheWrite1h;
  return w;
}

function sameRates(a: Rates, b: Rates): boolean {
  return FIELD_ORDER.every((f) => round6(a[f]) === round6(b[f]));
}

// --- planning -----------------------------------------------------------------------------------------------

/** Rates where LiteLLM or OpenRouter says something other than the official page (more than 1% off). */
function diffOfficial(off: OfficialEntry, ll: SourceEntry | undefined, or: SourceEntry | undefined, derived: boolean): OfficialDiff["fields"] {
  const a = ll ? sourceRates(ll, derived) : {};
  const b = or ? sourceRates(or, derived) : {};
  const out: OfficialDiff["fields"] = [];
  for (const f of FIELD_ORDER) {
    if (off.unlisted?.includes(f)) continue;
    const [x, y] = [a[f], b[f]];
    if ((x !== undefined && !agree(x, off[f])) || (y !== undefined && !agree(y, off[f]))) out.push({ field: f, official: off[f], litellm: x, openrouter: y });
  }
  return out;
}

const ratesOf = (e: Rates): Rates => ({ input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite5m: e.cacheWrite5m, cacheWrite1h: e.cacheWrite1h });

const kindOf = (osrc: SourceEntry | undefined, disagreements: number): SourceKind => (!osrc ? "single source" : disagreements ? "higher of aggregators" : "aggregators agree");

export function planUpdates(
  pricingSource: string,
  litellm: SourceEntry[],
  openrouter: SourceEntry[],
  today = new Date().toISOString().slice(0, 10),
  official: OfficialOutcome[] = [],
): Plan {
  const rules = parseRules(pricingSource);
  const plan: Plan = { rules, changes: [], additions: [], disagreements: [], officialDiffs: [], official: [], scheduled: [], sources: [], keptSingle: [], unchanged: 0, unmatched: [], fallbackSources: [], skipped: [], problems: [] };

  // Official pages: a page that could not be read is ignored whole, so that maker falls back to the aggregators.
  const officialEntries: OfficialEntry[] = [];
  for (const o of official) {
    const status: OfficialStatus = { maker: o.maker, state: "read", models: 0, detail: "", notes: o.notes ?? [], warnings: o.warnings ?? [] };
    if (o.error !== undefined) Object.assign(status, { state: "failed", detail: o.error });
    else if (o.unavailable !== undefined) Object.assign(status, { state: "unavailable", detail: o.unavailable });
    else {
      const mi = MAKERS.findIndex((m) => m.name === o.maker);
      const mine = (o.entries ?? []).filter((e) => mi >= 0 && makerIndex(e.id) === mi);
      status.models = mine.length;
      officialEntries.push(...mine);
    }
    plan.official.push(status);
  }
  const noteScheduled = (target: string, e: OfficialEntry) => {
    for (const s of e.scheduled ?? []) {
      const changes = FIELD_ORDER.filter((f) => s.to[f] !== undefined && round6(s.to[f]!) !== round6(e[f])).map((field) => ({ field, now: e[field], then: s.to[field]! }));
      if (changes.length) plan.scheduled.push({ target, from: s.from, changes });
    }
  };

  // Only the makers' own models, text only, and for OpenRouter only the maker's own vendor prefix.
  // A model that is retired, or retires within 90 days, is not a model to start pricing now.
  const horizon = new Date(Date.parse(today) + 90 * 86_400_000).toISOString().slice(0, 10);
  const live = (e: SourceEntry) => !e.nonText && !(e.endOfLife && e.endOfLife <= horizon) && !LEGACY_ID.test(e.id);
  const ll = litellm.filter((e) => makerIndex(e.id) >= 0 && !NON_TEXT_ID.test(e.id));
  const orAll = openrouter.filter((e) => {
    const mi = makerIndex(e.id);
    return mi >= 0 && MAKERS[mi]!.vendors.includes(e.key.split("/")[0]!) && !NON_TEXT_ID.test(e.id);
  });
  const llLive = ll.filter(live);
  const orLive = orAll.filter(live);

  // --- existing rules
  const llCovered = new Map<Rule, SourceEntry[]>();
  const orCovered = new Map<Rule, SourceEntry[]>();
  const offCovered = new Map<Rule, OfficialEntry[]>();
  const sort = <T extends SourceEntry>(e: T, map: Map<Rule, T[]>, accept: (e: T) => boolean) => {
    const rule = winningRule(rules, e.id);
    if (!rule || !belongsToRule(rule, e.id) || !accept(e)) return;
    const list = map.get(rule) ?? [];
    list.push(e);
    map.set(rule, list);
  };
  for (const e of ll) sort(e, llCovered, (x) => x.provider === "openai" || MAKERS[makerIndex(x.id)]!.providers.includes(x.provider) || RESELLERS.includes(x.provider));
  for (const e of orAll) sort(e, orCovered, () => true);
  for (const e of officialEntries) sort(e, offCovered, () => true);

  const finalRates = new Map<Rule, Rates>();
  const priced = new Set<OfficialEntry>();
  for (const rule of rules) {
    const mk = MAKERS[makerIndex(rule.pattern)];
    const derived = !!mk?.derivedCache;
    const stem = rule.pattern.endsWith("*") ? rule.pattern.slice(0, -1) : rule.pattern;
    const pool = llCovered.get(rule) ?? [];
    const own = pool.filter((e) => mk?.providers.includes(e.provider));
    const src = pickCanonical(stem, own.length ? own : pool);
    const osrc = pickCanonical(stem, orCovered.get(rule) ?? []);
    const off = pickCanonical(stem, offCovered.get(rule) ?? []);
    if (!src && !off) {
      plan.unmatched.push(rule.pattern);
      continue;
    }
    const before = effective(rule.fields);
    const explicit = rule.fields.cacheWrite5m !== undefined || rule.fields.cacheWrite1h !== undefined;
    let after: Rates;
    let kind: SourceKind;
    if (off) {
      // The maker's own page wins outright. Aggregators that say something else are listed, never used.
      priced.add(off);
      after = ratesOf(off);
      for (const f of off.unlisted ?? []) after[f] = before[f]; // not on the page: the rule keeps its own
      kind = "official";
      const fields = diffOfficial(off, src, osrc, derived);
      if (fields.length) plan.officialDiffs.push({ target: rule.pattern, kind: "update", maker: mk?.name ?? "", official: off.key, litellm: src?.key ?? "", openrouter: osrc?.key ?? "", fields });
      noteScheduled(rule.pattern, off);
    } else {
      if (!mk?.providers.includes(src!.provider)) plan.fallbackSources.push({ pattern: rule.pattern, key: src!.key });
      const r = resolve(src!, osrc, derived);
      if (r.disagree.length) {
        plan.disagreements.push({ target: rule.pattern, kind: "update", maker: mk?.name ?? "", litellm: src!.key, openrouter: osrc!.key, fields: r.disagree });
      }
      // A rate both sources list may change. A rate only one lists never does.
      after = { ...before };
      for (const f of FIELD_ORDER) {
        const v = r.both[f];
        if (v !== undefined) after[f] = v;
        else if (r.llOnly[f] !== undefined && round6(r.llOnly[f]!) !== round6(before[f])) {
          plan.keptSingle.push({ pattern: rule.pattern, field: f, current: before[f], value: r.llOnly[f]!, from: osrc ? "LiteLLM" : "LiteLLM, not on OpenRouter" });
        }
      }
      // Cache prices without a source follow a changed input price when they were tied to it.
      if (after.input !== before.input) {
        const tied: [FieldName, number][] = explicit ? [["cacheRead", 0.1], ["cacheWrite5m", 1]] : [];
        for (const [f, k] of tied) {
          if (r.both[f] === undefined && round6(before[f]) === round6(before.input * k)) after[f] = round6(after.input * k);
        }
        if (explicit && r.both.cacheWrite1h === undefined && before.cacheWrite1h === before.cacheWrite5m) after.cacheWrite1h = after.cacheWrite5m;
      }
      kind = kindOf(osrc, r.disagree.length);
    }
    plan.sources.push({ pattern: rule.pattern, kind });
    finalRates.set(rule, after);
    if (sameRates(before, after)) {
      plan.unchanged++;
      continue;
    }
    plan.changes.push({ rule, kind, source: src?.key ?? "", orSource: osrc?.key ?? "", official: off?.key ?? "", before, after, write: writeFields(after, explicit) });
  }

  // --- new models
  const skip = (reason: string, id: string) => {
    const s = plan.skipped.find((x) => x.reason === reason);
    if (s) s.ids.push(id);
    else plan.skipped.push({ reason, ids: [id] });
  };
  const allIds = new Set([...ll, ...orAll, ...officialEntries].map((e) => e.id));
  const orById = new Map<string, SourceEntry[]>();
  for (const e of orLive) orById.set(e.id, [...(orById.get(e.id) ?? []), e]);
  const done = new Set<string>();
  const firstParty = (e: SourceEntry) => MAKERS[makerIndex(e.id)]!.providers.includes(e.provider);

  // Official pages first: a model the page lists that no rule prices gets its exact id, and so does a model a prefix rule
  // catches but the page prices differently ("glm-4.5-x" under "glm-4.5*").
  for (const e of [...officialEntries].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))) {
    const id = e.id;
    if (done.has(id) || priced.has(e)) continue;
    done.add(id);
    const mi = makerIndex(id);
    const mk = MAKERS[mi]!;
    const rule = winningRule(rules, id);
    const covered = !!rule && belongsToRule(rule, id);
    const rates = ratesOf(e);
    if (covered && sameRates(finalRates.get(rule!) ?? effective(rule!.fields), rates)) continue; // a variant at the same price as its rule
    if (NON_TEXT_ID.test(id) || LEGACY_ID.test(id)) continue;
    if (ALIAS_ID.test(id)) {
      skip("aliases and beta variants", id);
      continue;
    }
    const base = id.replace(DATE_SEGMENT, "");
    if (base !== id && allIds.has(base)) {
      skip("dated snapshots of a model with an undated id", id);
      continue;
    }
    if (rates.input === 0 || rates.output === 0) {
      skip("free or zero priced", id);
      continue;
    }
    if (!covered && rule && sameRates(effective(rule.fields), rates)) {
      skip("already priced identically by a rule", id);
      continue;
    }
    const llEntry = pickCanonical(id, llLive.filter((x) => x.id === id && firstParty(x)));
    const orEntry = pickCanonical(id, orById.get(id) ?? []);
    const fields = diffOfficial(e, llEntry, orEntry, !!mk.derivedCache);
    if (fields.length) plan.officialDiffs.push({ target: id, kind: "new", maker: mk.name, official: e.key, litellm: llEntry?.key ?? "", openrouter: orEntry?.key ?? "", fields });
    noteScheduled(id, e);
    plan.additions.push({ id, makerIndex: mi, kind: "official", official: e.key, litellm: llEntry?.key ?? "", openrouter: orEntry?.key, rates, write: writeFields(rates, !mk.derivedCache) });
  }

  const candidates = [...new Set([...llLive.filter(firstParty).map((e) => e.id), ...orLive.map((e) => e.id)])].sort();
  for (const id of candidates) {
    if (done.has(id)) continue;
    done.add(id);
    const mi = makerIndex(id);
    const mk = MAKERS[mi]!;
    const rule = winningRule(rules, id);
    if (rule && belongsToRule(rule, id)) continue; // an existing rule prices it
    if (ALIAS_ID.test(id)) {
      skip("aliases and beta variants", id);
      continue;
    }
    const base = id.replace(DATE_SEGMENT, "");
    if (base !== id && allIds.has(base)) {
      skip("dated snapshots of a model with an undated id", id);
      continue;
    }
    const llEntry = pickCanonical(id, llLive.filter((e) => e.id === id && firstParty(e)));
    if (!llEntry) {
      skip("only on OpenRouter or a reseller, never added", id);
      continue;
    }
    if (llEntry.input === 0 || llEntry.output === 0) {
      skip("free or zero priced", id);
      continue;
    }
    const orEntry = pickCanonical(id, orById.get(id) ?? []);
    const r = resolve(llEntry, orEntry, !!mk.derivedCache);
    const merged: Fields = { ...r.llOnly, ...r.both };
    const input = merged.input!;
    let rates: Rates;
    if (mk.derivedCache) {
      rates = effective(merged);
    } else {
      // No cache-write charge unless a source lists one: written tokens cost what input does.
      const write5 = merged.cacheWrite5m ?? input;
      rates = { input, output: merged.output!, cacheRead: merged.cacheRead ?? round6(input * 0.1), cacheWrite5m: write5, cacheWrite1h: merged.cacheWrite1h ?? write5 };
    }
    if (rule && sameRates(effective(rule.fields), rates)) {
      skip("already priced identically by a rule", id);
      continue;
    }
    if (r.disagree.length) {
      plan.disagreements.push({ target: id, kind: "new", maker: mk.name, litellm: llEntry.key, openrouter: orEntry!.key, fields: r.disagree });
    }
    plan.additions.push({ id, makerIndex: mi, kind: kindOf(orEntry, r.disagree.length), official: "", litellm: llEntry.key, openrouter: orEntry?.key, rates, write: writeFields(rates, !mk.derivedCache) });
  }
  plan.additions.sort((a, b) => a.makerIndex - b.makerIndex || a.id.localeCompare(b.id, "en", { numeric: true }));
  for (const s of plan.skipped) s.ids.sort();

  // Sanity guard: these changes are too big to trust a single page or a community-maintained file. Additions don't count.
  for (const c of plan.changes) {
    const from = c.official ? `the official page, \`${c.official}\`` : `\`${c.source}\``;
    for (const f of FIELD_ORDER) {
      const [a, b] = [c.before[f], c.after[f]];
      if (a === b) continue;
      if (b === 0 && a > 0) plan.problems.push(`\`${c.rule.pattern}\` ${FIELD_LABEL[f]} drops to 0 (was ${a}, from ${from})`);
      else if (a > 0 && (b / a > 10 || a / b > 10)) plan.problems.push(`\`${c.rule.pattern}\` ${FIELD_LABEL[f]} moves more than 10x (${a} to ${b}, from ${from})`);
    }
  }
  if (plan.changes.length * 2 > rules.length) {
    plan.problems.push(`${plan.changes.length} of ${rules.length} rules would change at once, more than half`);
  }
  return plan;
}

// --- editing ------------------------------------------------------------------------------------------------

function fieldsText(write: Fields): string {
  return FIELD_ORDER.filter((f) => write[f] !== undefined)
    .map((f) => `${f}: ${write[f]}`)
    .join(", ");
}

/**
 * Rewrites the rule lines that changed, inserts new rules under their maker's section and bumps the version once.
 * A new rule goes before the first existing prefix rule that would also match it, else at the end of the section.
 * A maker with no section yet gets one, with a comment heading, at the end of the table.
 */
export function applyChanges(source: string, changes: Change[], additions: Addition[] = []): string {
  if (changes.length === 0 && additions.length === 0) return source;
  const eol = source.includes("\r\n") ? "\r\n" : "\n"; // keep the file's own line endings
  const lines = source.split(/\r?\n/);
  for (const c of changes) {
    const m = RULE_LINE.exec(lines[c.rule.line]!);
    if (!m || m[2] !== c.rule.pattern) fail(`pricing.ts changed under the script near ${c.rule.pattern}`);
    lines[c.rule.line] = `${m[1]}${m[2]}${m[3]} ${fieldsText(c.write)}${m[5]}${m[6]}`;
  }

  const rules = parseRules(source);
  const inserts = new Map<number, { id: string; text: string }[]>();
  const newSections = new Map<number, { id: string; text: string }[]>();
  const add = (at: number, id: string, text: string) => inserts.set(at, [...(inserts.get(at) ?? []), { id, text }]);
  for (const a of additions) {
    const text = `  { pattern: "${a.id}", ${fieldsText(a.write)} },`;
    if (rules.some((r) => r.pattern === a.id)) fail(`pricing.ts already has a rule for ${a.id}`);
    const group = rules.filter((r) => makerIndex(r.pattern) === a.makerIndex);
    if (group.length === 0) {
      newSections.set(a.makerIndex, [...(newSections.get(a.makerIndex) ?? []), { id: a.id, text }]);
      continue;
    }
    const cover = group.find((r) => r.pattern.endsWith("*") && a.id.startsWith(r.pattern.slice(0, -1)));
    if (!cover) {
      add(group[group.length - 1]!.line + 1, a.id, text);
      continue;
    }
    // Stay above the comment that belongs to the covering rule, but never above the section heading.
    let at = cover.line;
    while (lines[at - 1]?.trim().startsWith("//")) at--;
    const prev = lines[at - 1] ? RULE_LINE.exec(lines[at - 1]!) : null;
    if (at === cover.line || !prev || makerIndex(prev[2]!) !== a.makerIndex) at = cover.line;
    add(at, a.id, text);
  }
  let end = -1;
  const tail: string[] = [];
  if (newSections.size) {
    const start = lines.findIndex((l) => l.includes("BUILTIN_PRICES: "));
    end = lines.findIndex((l, i) => i > start && /^\];/.test(l));
    if (start < 0 || end < 0) fail("BUILTIN_PRICES table not found in pricing.ts");
    for (const [mi, list] of [...newSections].sort((a, b) => a[0] - b[0])) {
      tail.push(`  // ${MAKERS[mi]!.heading}`, ...list.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })).map((x) => x.text));
    }
  }
  const out: string[] = [];
  lines.forEach((l, i) => {
    const list = inserts.get(i);
    if (list) out.push(...list.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })).map((x) => x.text));
    if (i === end) out.push(...tail);
    out.push(l);
  });
  const text = out.join(eol);
  const bumped = text.replace(/(BUILTIN_PRICES_VERSION = )(\d+)/, (_, head, n) => `${head}${Number(n) + 1}`);
  if (bumped === text) fail("BUILTIN_PRICES_VERSION not found in pricing.ts");
  return bumped;
}

// --- report -------------------------------------------------------------------------------------------------

const MAX_LIST = 80;

const rateLine = (r: Rates) => `${r.input} | ${r.output} | ${r.cacheRead} | ${r.cacheWrite5m}`;
const cell = (v: number | undefined) => (v === undefined ? "none" : String(v));

export function renderReport(plan: Plan): string {
  const out: string[] = [];
  if (plan.problems.length) {
    out.push("## Needs a human", "", "The price check stopped without changing anything:", "", ...plan.problems.map((p) => `- ${p}`), "");
  }

  out.push("## Official pages", "", "The maker's own pricing page is checked first. Only a model it has no price for goes to LiteLLM and OpenRouter.", "");
  for (const o of plan.official) {
    if (o.state === "read") out.push(`- ${o.maker}: read, ${o.models} models.`);
    else if (o.state === "failed") out.push(`- ${o.maker}: official page could not be read: ${o.detail}. LiteLLM and OpenRouter were used for this maker.`);
    else out.push(`- ${o.maker}: no official machine-readable price (${o.detail}). LiteLLM and OpenRouter were used for this maker.`);
  }
  for (const o of plan.official) for (const n of o.notes) out.push(`- ${o.maker}: ${n}`);
  for (const o of plan.official) for (const w of o.warnings) out.push(`- **${o.maker}: ${w}**`);
  out.push("");

  out.push("## Price changes", "");
  if (plan.changes.length === 0) out.push("No built-in price differs from the official pages or the two aggregators.", "");
  else {
    out.push("Per 1M tokens in USD. Cache rates the rule doesn't set are derived from input.", "", "| Rule | Rate | Before | After | Source | Entry |", "|---|---|---|---|---|---|");
    for (const c of plan.changes) {
      const entry = c.official ? `\`${c.official}\`` : `LiteLLM \`${c.source}\`, OpenRouter \`${c.orSource}\``;
      for (const f of FIELD_ORDER) {
        if (round6(c.before[f]) === round6(c.after[f])) continue;
        out.push(`| \`${c.rule.pattern}\` | ${FIELD_LABEL[f]} | ${c.before[f]} | ${c.after[f]} | ${c.kind} | ${entry} |`);
      }
    }
    out.push("");
  }

  const fromOfficial = plan.additions.filter((a) => a.kind === "official");
  const both = plan.additions.filter((a) => a.kind !== "official" && a.openrouter);
  const single = plan.additions.filter((a) => a.kind !== "official" && !a.openrouter);
  out.push("## New models from official pages", "");
  if (fromOfficial.length === 0) out.push("None.", "");
  else {
    out.push("The maker's own page lists them. Per 1M tokens in USD.", "", "| Rule | Input | Output | Cache read | Cache write | Official entry |", "|---|---|---|---|---|---|");
    for (const a of fromOfficial) out.push(`| \`${a.id}\` | ${rateLine(a.rates)} | \`${a.official}\` |`);
    out.push("");
  }
  out.push("## New models added", "");
  if (both.length === 0) out.push("None.", "");
  else {
    out.push("No official price. Both aggregators list them. Per 1M tokens in USD.", "", "| Rule | Input | Output | Cache read | Cache write | Source | LiteLLM entry | OpenRouter entry |", "|---|---|---|---|---|---|---|---|");
    for (const a of both) out.push(`| \`${a.id}\` | ${rateLine(a.rates)} | ${a.kind} | \`${a.litellm}\` | \`${a.openrouter}\` |`);
    out.push("");
  }
  out.push("## Single source additions", "");
  if (single.length === 0) out.push("None.", "");
  else {
    out.push("No official price. Only the maker's own LiteLLM entry lists them, OpenRouter has no model with this id. Check them against the maker.", "", "| Rule | Input | Output | Cache read | Cache write | LiteLLM entry |", "|---|---|---|---|---|---|");
    for (const a of single) out.push(`| \`${a.id}\` | ${rateLine(a.rates)} | \`${a.litellm}\` |`);
    out.push("");
  }

  out.push("## Aggregators differ from the official price", "");
  if (plan.officialDiffs.length === 0) out.push("None.", "");
  else {
    out.push(
      "The official price is used. LiteLLM or OpenRouter differs by more than 1%, which is listed here so a human sees it. OpenRouter often shows the cheapest routed provider.",
      "",
      "| Model | Rate | Official (used) | LiteLLM | OpenRouter |",
      "|---|---|---|---|---|",
    );
    for (const d of plan.officialDiffs) {
      for (const f of d.fields) out.push(`| \`${d.target}\`${d.kind === "new" ? " (new)" : ""} | ${FIELD_LABEL[f.field]} | ${f.official} | ${cell(f.litellm)} | ${cell(f.openrouter)} |`);
    }
    out.push("");
  }

  out.push("## Sources disagree, higher used", "");
  if (plan.disagreements.length === 0) out.push("None.", "");
  else {
    out.push(
      "No official price for these. LiteLLM and OpenRouter differ by more than 1%, so the higher price per rate is used. OpenRouter often shows the cheapest routed provider for third-party makers. Check these against the maker's pricing page.",
      "",
      "| Model | Rate | LiteLLM | OpenRouter | Used | Official pricing |",
      "|---|---|---|---|---|---|",
    );
    for (const d of plan.disagreements) {
      const page = MAKERS.find((m) => m.name === d.maker)?.page ?? "";
      for (const f of d.fields) {
        out.push(`| \`${d.target}\`${d.kind === "new" ? " (new)" : ""} | ${FIELD_LABEL[f.field]} | ${f.litellm} | ${f.openrouter} | ${f.used} | ${page} |`);
      }
    }
    out.push("");
  }

  out.push("## Scheduled price changes", "");
  if (plan.scheduled.length === 0) out.push("None announced on the official pages.", "");
  else {
    out.push("The price used today is the one valid today. The official page announces these changes, and a weekly run after the date picks them up.", "", "| Model | From | Rate | Now | Then |", "|---|---|---|---|---|");
    for (const s of plan.scheduled) for (const c of s.changes) out.push(`| \`${s.target}\` | ${s.from} | ${FIELD_LABEL[c.field]} | ${c.now} | ${c.then} |`);
    out.push("");
  }

  out.push("## Price sources", "");
  const kinds: SourceKind[] = ["official", "aggregators agree", "higher of aggregators", "single source"];
  out.push(`Existing rules by the source of their price: ${kinds.map((k) => `${plan.sources.filter((s) => s.kind === k).length} ${k}`).join(", ")}, ${plan.unmatched.length} unchecked.`, "");
  const unofficial = plan.sources.filter((s) => s.kind !== "official");
  if (unofficial.length) {
    out.push("Not on an official page, so priced from the aggregators:", "");
    for (const k of kinds.slice(1)) {
      const list = unofficial.filter((s) => s.kind === k);
      if (list.length) out.push(`- ${k} (${list.length}): ${list.slice(0, MAX_LIST).map((s) => `\`${s.pattern}\``).join(", ")}${list.length > MAX_LIST ? `, and ${list.length - MAX_LIST} more` : ""}`);
    }
    out.push("");
  }

  out.push("## Skipped", "");
  out.push(`${plan.changes.length} changed, ${plan.additions.length} added, ${plan.unchanged} unchanged, ${plan.unmatched.length} without any source entry.`, "");
  if (plan.unmatched.length) out.push(`No official, LiteLLM or OpenRouter entry for: ${plan.unmatched.map((p) => `\`${p}\``).join(", ")}. Their prices were not checked.`, "");
  if (plan.fallbackSources.length) {
    out.push(
      "Priced from a cloud reseller because there is no first-party entry: " +
        plan.fallbackSources.map((f) => `\`${f.pattern}\` (\`${f.key}\`)`).join(", ") +
        ". Check these against the maker.",
      "",
    );
  }
  if (plan.keptSingle.length) {
    out.push("A rate only one aggregator lists is never changed automatically:", "");
    for (const k of plan.keptSingle.slice(0, MAX_LIST)) out.push(`- \`${k.pattern}\` ${FIELD_LABEL[k.field]} is ${k.current}, ${k.from} says ${k.value}`);
    out.push("");
  }
  for (const s of plan.skipped) {
    const shown = s.ids.slice(0, MAX_LIST).map((i) => `\`${i}\``).join(", ");
    out.push(`- ${s.reason} (${s.ids.length}): ${shown}${s.ids.length > MAX_LIST ? `, and ${s.ids.length - MAX_LIST} more` : ""}`);
  }
  if (plan.skipped.length) out.push("");

  out.push(
    "## Review",
    "",
    "Prices from an aggregator are community or reseller data, so spot-check them and the changed and added rules against the official pages:",
    "",
    ...MAKERS.map((m) => `- ${m.name}: ${m.page}`),
    "",
    "Prices in Settings → Pricing always win over the built-in ones.",
    "",
  );
  return out.join("\n");
}

// --- main ---------------------------------------------------------------------------------------------------

async function fetchJson(url: string, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
  } catch (e) {
    return fail(`fetching the ${label} data failed: ${(e as Error).message}`);
  }
  if (!res.ok) fail(`fetching ${url} failed with HTTP ${res.status}`);
  try {
    return JSON.parse(await res.text());
  } catch {
    return fail(`${label} data is not valid JSON`);
  }
}

function setOutput(changed: boolean) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

export async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dryRun = argv.includes("--dry-run");
  const reportPath = arg("--report");
  const pricingPath = arg("--pricing") ?? new URL("../src/core/pricing.ts", import.meta.url).pathname;
  const sourcePath = arg("--source");
  const orPath = arg("--openrouter");
  const officialDir = arg("--official-dir");
  const today = new Date().toISOString().slice(0, 10);
  try {
    const [llData, orData] = await Promise.all([
      sourcePath ? Bun.file(sourcePath).text().then((t) => JSON.parse(t)) : fetchJson(LITELLM_URL, "LiteLLM"),
      orPath ? Bun.file(orPath).text().then((t) => JSON.parse(t)) : fetchJson(OPENROUTER_URL, "OpenRouter"),
    ]);
    // --official-dir reads <key>.md from a folder (tests, offline runs), --no-official skips the official pages.
    const official = argv.includes("--no-official")
      ? []
      : await loadOfficial(today, officialDir ? (s) => Bun.file(`${officialDir}/${s.key}.md`).text() : fetchOfficial);
    const pricing = await Bun.file(pricingPath).text();
    const plan = planUpdates(pricing, parseLiteLLM(llData), parseOpenRouter(orData), today, official);
    const report = renderReport(plan);
    if (reportPath) await Bun.write(reportPath, report);
    if (dryRun) console.log(report);
    if (plan.problems.length) {
      console.error(`Refusing to update prices:\n${plan.problems.map((p) => `- ${p}`).join("\n")}`);
      setOutput(false);
      return 1;
    }
    const changed = plan.changes.length > 0 || plan.additions.length > 0;
    if (changed && !dryRun) await Bun.write(pricingPath, applyChanges(pricing, plan.changes, plan.additions));
    if (!dryRun) console.log(changed ? `Updated ${plan.changes.length} rules, added ${plan.additions.length}.` : "Prices are up to date.");
    setOutput(changed && !dryRun);
    return 0;
  } catch (e) {
    console.error(`Price check failed: ${(e as Error).message}`);
    setOutput(false);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
