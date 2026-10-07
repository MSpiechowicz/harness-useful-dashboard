/**
 * Weekly price check: compares the built-in prices in src/core/pricing.ts with LiteLLM's community-maintained
 * price list and edits only the numbers that changed. The app never fetches prices itself. This script runs in
 * .github/workflows/prices.yml, which opens a pull request for a human to review.
 *
 *   bun scripts/update-prices.ts [--dry-run] [--report report.md] [--source file.json] [--pricing path]
 *
 * Exit 0: nothing to do, or changes written (`changed=true` goes to $GITHUB_OUTPUT). Exit 1: error or a change
 * that needs a human (a price moving more than 10x, dropping to 0, or more than half of the rules at once).
 */
import { appendFileSync } from "node:fs";
import { normalizeModel } from "../src/core/models.ts";

export const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Every rate in USD per 1M tokens. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface SourceEntry {
  key: string;
  id: string; // normalized
  provider: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface Rule {
  pattern: string;
  line: number;
  fields: Partial<Record<FieldName, number>>;
}

type FieldName = "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h";
const FIELD_ORDER: FieldName[] = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
const FIELD_LABEL: Record<FieldName, string> = {
  input: "input",
  output: "output",
  cacheRead: "cache read",
  cacheWrite5m: "cache write 5m",
  cacheWrite1h: "cache write 1h",
};

export interface Change {
  rule: Rule;
  source: string;
  before: Rates;
  after: Rates;
  /** The fields to write on the rule line. */
  write: Partial<Record<FieldName, number>>;
}

export interface Suggestion {
  key: string;
  id: string;
  input: number;
  output: number;
  cacheRead?: number;
  note: string;
}

export interface Plan {
  rules: Rule[];
  changes: Change[];
  unchanged: number;
  unmatched: string[]; // rules with no source entry at all
  fallbackSources: { pattern: string; key: string }[];
  suggestions: Suggestion[];
  problems: string[];
}

const PER_MILLION = 1e6;

/** Dated snapshots and moving aliases: "gpt-4o-2024-08-06", "gpt-4-0613", "gemini-flash-latest". */
const SNAPSHOT_ID = /(-\d{4}-\d{2}-\d{2}|-\d{4}|-\d{2}-\d{4}|-latest)$/;

/** Six significant digits: enough for every list price, and it removes float noise like 0.30000000000000004. */
export function round6(n: number): number {
  return Number(n.toPrecision(6));
}

/** LiteLLM's per-token price → USD per 1M tokens. */
export function perMillion(perToken: number): number {
  return round6(perToken * PER_MILLION);
}

// --- LiteLLM data -------------------------------------------------------------------------------------------

/** First-party provider per maker prefix. Cloud resellers (Bedrock, Vertex, Azure) are only a fallback. */
const MAKERS: { test: RegExp; provider: string }[] = [
  { test: /^claude-/, provider: "anthropic" },
  { test: /^(gpt-|o\d|codex|chatgpt)/, provider: "openai" },
  { test: /^gemini-/, provider: "gemini" },
  { test: /^glm-/, provider: "zai" },
];
const RESELLERS = ["vertex_ai-language-models", "vertex_ai", "bedrock_converse", "bedrock", "azure"];

function fail(msg: string): never {
  throw new Error(msg);
}

function optionalPrice(entry: Record<string, unknown>, field: string, key: string): number | undefined {
  const v = entry[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) fail(`${key}: ${field} is not a non-negative number (${JSON.stringify(v)})`);
  return v;
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
    if (input === undefined || output === undefined) continue; // no list price to compare
    out.push({
      key,
      id: normalizeModel(key),
      provider: e.litellm_provider,
      input: perMillion(input),
      output: perMillion(output),
      cacheRead: scaled(optionalPrice(e, "cache_read_input_token_cost", key)),
      cacheWrite5m: scaled(optionalPrice(e, "cache_creation_input_token_cost", key)),
      cacheWrite1h: scaled(optionalPrice(e, "cache_creation_input_token_cost_above_1hr", key)),
    });
  }
  // A file that lost its main providers is broken, not "no changes".
  for (const provider of ["anthropic", "openai", "gemini"]) {
    if (!out.some((e) => e.provider === provider)) fail(`LiteLLM data has no ${provider} chat models, the format may have changed`);
  }
  return out;
}

function scaled(n: number | undefined): number | undefined {
  return n === undefined ? undefined : perMillion(n);
}

// --- pricing.ts ---------------------------------------------------------------------------------------------

const RULE_LINE = /^(\s*\{ pattern: ")([^"]+)(",)(.*?)( \},?)(.*)$/;

export function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  source.split("\n").forEach((text, line) => {
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

function makerProvider(id: string): string | null {
  return MAKERS.find((m) => m.test.test(id))?.provider ?? null;
}

/** The entry that gives a rule its price: the stem itself, else the shortest id that continues it. */
function pickCanonical(rule: Rule, pool: SourceEntry[]): SourceEntry | undefined {
  const stem = rule.pattern.endsWith("*") ? rule.pattern.slice(0, -1) : rule.pattern;
  const rank = (e: SourceEntry) => [e.id === stem ? 0 : 1, RESELLERS.indexOf(e.provider), e.id.length, e.key.length, e.key] as const;
  return [...pool].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    for (let i = 0; i < x.length; i++) if (x[i]! < y[i]!) return -1; else if (x[i]! > y[i]!) return 1;
    return 0;
  })[0];
}

// --- planning -----------------------------------------------------------------------------------------------

function desiredFields(rule: Rule, src: SourceEntry): { write: Rule["fields"]; rates: Rates } {
  const cur = rule.fields;
  const input = src.input;
  // Makers with no cache-write charge list every cache write explicitly, at the input price.
  const explicitWrites = cur.cacheWrite5m !== undefined || cur.cacheWrite1h !== undefined;
  const cacheRead = src.cacheRead ?? (cur.cacheRead !== undefined ? cur.cacheRead : round6(input * 0.1));
  let w5: number;
  let w1: number;
  if (explicitWrites) {
    w5 = src.cacheWrite5m && src.cacheWrite5m > 0 ? src.cacheWrite5m : input;
    w1 = src.cacheWrite1h && src.cacheWrite1h > 0 ? src.cacheWrite1h : w5;
  } else {
    w5 = src.cacheWrite5m ?? round6(input * 1.25);
    w1 = src.cacheWrite1h ?? round6(input * 2);
  }
  const rates: Rates = { input, output: src.output, cacheRead, cacheWrite5m: w5, cacheWrite1h: w1 };
  const write: Rule["fields"] = { input, output: src.output };
  if (explicitWrites || cacheRead !== round6(input * 0.1)) write.cacheRead = cacheRead;
  if (explicitWrites || w5 !== round6(input * 1.25)) write.cacheWrite5m = w5;
  if (explicitWrites || w1 !== round6(input * 2)) write.cacheWrite1h = w1;
  return { write, rates };
}

function sameRates(a: Rates, b: Rates): boolean {
  return FIELD_ORDER.every((f) => round6(a[f]) === round6(b[f]));
}

export function planUpdates(pricingSource: string, entries: SourceEntry[]): Plan {
  const rules = parseRules(pricingSource);
  const plan: Plan = { rules, changes: [], unchanged: 0, unmatched: [], fallbackSources: [], suggestions: [], problems: [] };

  const covered = new Map<Rule, SourceEntry[]>();
  const seenSuggestion = new Set<string>();
  for (const e of entries) {
    const provider = makerProvider(e.id);
    if (!provider) continue;
    const rule = winningRule(rules, e.id);
    const firstParty = e.provider === provider;
    if (rule && belongsToRule(rule, e.id)) {
      if (firstParty || RESELLERS.includes(e.provider)) {
        const list = covered.get(rule) ?? [];
        list.push(e);
        covered.set(rule, list);
      }
      continue;
    }
    // Not priced by any rule, or caught by a prefix rule that is a different model: worth a look.
    if (!firstParty || SNAPSHOT_ID.test(e.id) || e.input === 0 || seenSuggestion.has(e.id)) continue;
    if (rule && e.input === rule.fields.input && e.output === rule.fields.output) continue; // the rule already prices it right
    seenSuggestion.add(e.id);
    plan.suggestions.push({
      key: e.key,
      id: e.id,
      input: e.input,
      output: e.output,
      cacheRead: e.cacheRead,
      note: rule ? `now priced by \`${rule.pattern}\`` : "no rule",
    });
  }
  plan.suggestions.sort((a, b) => a.id.localeCompare(b.id));

  for (const rule of rules) {
    const pool = covered.get(rule) ?? [];
    const provider = makerProvider(rule.pattern);
    const firstParty = pool.filter((e) => e.provider === provider);
    const src = pickCanonical(rule, firstParty.length ? firstParty : pool);
    if (!src) {
      plan.unmatched.push(rule.pattern);
      continue;
    }
    if (src.provider !== provider) plan.fallbackSources.push({ pattern: rule.pattern, key: src.key });
    const before = effective(rule.fields);
    const { write, rates } = desiredFields(rule, src);
    if (sameRates(before, rates)) {
      plan.unchanged++;
      continue;
    }
    plan.changes.push({ rule, source: src.key, before, after: rates, write });
  }

  // Sanity guard: these changes are too big to trust a community-maintained file.
  for (const c of plan.changes) {
    for (const f of FIELD_ORDER) {
      const [a, b] = [c.before[f], c.after[f]];
      if (a === b) continue;
      if (b === 0 && a > 0) plan.problems.push(`\`${c.rule.pattern}\` ${FIELD_LABEL[f]} drops to 0 (was ${a}, from \`${c.source}\`)`);
      else if (a > 0 && (b / a > 10 || a / b > 10)) plan.problems.push(`\`${c.rule.pattern}\` ${FIELD_LABEL[f]} moves more than 10x (${a} to ${b}, from \`${c.source}\`)`);
    }
  }
  if (plan.changes.length * 2 > rules.length) {
    plan.problems.push(`${plan.changes.length} of ${rules.length} rules would change at once, more than half`);
  }
  return plan;
}

// --- editing ------------------------------------------------------------------------------------------------

function fieldsText(write: Rule["fields"]): string {
  return FIELD_ORDER.filter((f) => write[f] !== undefined)
    .map((f) => `${f}: ${write[f]}`)
    .join(", ");
}

/** Rewrites only the rule lines that changed and bumps the version. Comments and layout stay as they are. */
export function applyChanges(source: string, changes: Change[]): string {
  if (changes.length === 0) return source;
  const lines = source.split("\n");
  for (const c of changes) {
    const m = RULE_LINE.exec(lines[c.rule.line]!);
    if (!m || m[2] !== c.rule.pattern) fail(`pricing.ts changed under the script near ${c.rule.pattern}`);
    lines[c.rule.line] = `${m[1]}${m[2]}${m[3]} ${fieldsText(c.write)}${m[5]}${m[6]}`;
  }
  const out = lines.join("\n");
  const bumped = out.replace(/(BUILTIN_PRICES_VERSION = )(\d+)/, (_, head, n) => `${head}${Number(n) + 1}`);
  if (bumped === out) fail("BUILTIN_PRICES_VERSION not found in pricing.ts");
  return bumped;
}

// --- report -------------------------------------------------------------------------------------------------

const PRICING_PAGES = [
  ["Anthropic", "https://docs.anthropic.com/en/docs/about-claude/pricing"],
  ["OpenAI", "https://developers.openai.com/api/docs/pricing"],
  ["Google Gemini", "https://ai.google.dev/gemini-api/docs/pricing"],
  ["Z.ai (GLM)", "https://docs.z.ai/guides/overview/pricing"],
] as const;

const MAX_SUGGESTIONS = 60;

export function renderReport(plan: Plan): string {
  const out: string[] = [];
  if (plan.problems.length) {
    out.push("## Needs a human", "", "The price check stopped without changing anything:", "", ...plan.problems.map((p) => `- ${p}`), "");
  }
  out.push("## Price changes", "");
  if (plan.changes.length === 0) out.push("No built-in price differs from LiteLLM.", "");
  else {
    out.push("Per 1M tokens in USD. Cache rates the rule doesn't set are derived from input.", "", "| Rule | Rate | Before | After | LiteLLM entry |", "|---|---|---|---|---|");
    for (const c of plan.changes) {
      for (const f of FIELD_ORDER) {
        if (round6(c.before[f]) === round6(c.after[f])) continue;
        out.push(`| \`${c.rule.pattern}\` | ${FIELD_LABEL[f]} | ${c.before[f]} | ${c.after[f]} | \`${c.source}\` |`);
      }
    }
    out.push("");
  }
  out.push(`${plan.changes.length} changed, ${plan.unchanged} unchanged, ${plan.unmatched.length} without a LiteLLM entry.`, "");
  if (plan.unmatched.length) out.push(`No LiteLLM entry for: ${plan.unmatched.map((p) => `\`${p}\``).join(", ")}. Their prices were not checked.`, "");
  if (plan.fallbackSources.length) {
    out.push(
      "Priced from a cloud reseller because there is no first-party entry: " +
        plan.fallbackSources.map((f) => `\`${f.pattern}\` (\`${f.key}\`)`).join(", ") +
        ". Check these against the maker.",
      "",
    );
  }
  out.push("## New models you may want to add", "");
  if (plan.suggestions.length === 0) out.push("None. Every model from the makers we price is covered by a rule.", "");
  else {
    out.push("Not added automatically. Per 1M tokens in USD.", "", "| Model | Input | Output | Cache read | Today |", "|---|---|---|---|---|");
    for (const s of plan.suggestions.slice(0, MAX_SUGGESTIONS)) out.push(`| \`${s.id}\` | ${s.input} | ${s.output} | ${s.cacheRead ?? "-"} | ${s.note} |`);
    if (plan.suggestions.length > MAX_SUGGESTIONS) out.push("", `And ${plan.suggestions.length - MAX_SUGGESTIONS} more.`);
    out.push("");
  }
  out.push(
    "## Review",
    "",
    "LiteLLM is community-maintained, so spot-check the changed rules against the official pages:",
    "",
    ...PRICING_PAGES.map(([name, url]) => `- ${name}: ${url}`),
    "",
    "Prices in Settings → Pricing always win over the built-in ones.",
    "",
  );
  return out.join("\n");
}

// --- main ---------------------------------------------------------------------------------------------------

async function fetchSource(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) fail(`fetching ${url} failed with HTTP ${res.status}`);
  try {
    return JSON.parse(await res.text());
  } catch {
    return fail("LiteLLM data is not valid JSON");
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
  try {
    const data = sourcePath ? JSON.parse(await Bun.file(sourcePath).text()) : await fetchSource(LITELLM_URL);
    const pricing = await Bun.file(pricingPath).text();
    const plan = planUpdates(pricing, parseLiteLLM(data));
    const report = renderReport(plan);
    if (reportPath) await Bun.write(reportPath, report);
    if (dryRun) console.log(report);
    if (plan.problems.length) {
      console.error(`Refusing to update prices:\n${plan.problems.map((p) => `- ${p}`).join("\n")}`);
      setOutput(false);
      return 1;
    }
    const changed = plan.changes.length > 0;
    if (changed && !dryRun) await Bun.write(pricingPath, applyChanges(pricing, plan.changes));
    if (!dryRun) console.log(changed ? `Updated ${plan.changes.length} rules.` : "Prices are up to date.");
    setOutput(changed && !dryRun);
    return 0;
  } catch (e) {
    console.error(`Price check failed: ${(e as Error).message}`);
    setOutput(false);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
