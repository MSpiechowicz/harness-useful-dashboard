import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficialEntry, OfficialOutcome } from "../scripts/official-prices.ts";
import { applyChanges, effective, main, parseLiteLLM, parseOpenRouter, parseRules, perMillion, planUpdates, renderReport, round6 } from "../scripts/update-prices.ts";
import { normalizeModel } from "../src/core/models.ts";

const PRICING = `export const BUILTIN_PRICES_VERSION = 4;
export const BUILTIN_PRICES: Omit<PriceRule, "source">[] = [
  // Anthropic — derived cache prices unless noted.
  { pattern: "claude-opus-5-5*", input: 4, output: 20, cacheRead: 0.2 },
  { pattern: "claude-opus-5*", input: 5, output: 25 },
  { pattern: "claude-opus-4*", input: 15, output: 75 },
  // OpenAI
  { pattern: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  { pattern: "gpt-4o*", input: 2.5, output: 10, cacheRead: 1.25, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  // Google
  { pattern: "gemini-3-flash*", input: 0.5, output: 3, cacheRead: 0.05, cacheWrite5m: 0.5, cacheWrite1h: 0.5 },
];
`;

type Entry = Record<string, unknown>;
const claude = (input: number, output: number, extra: Entry = {}): Entry => ({
  litellm_provider: "anthropic",
  mode: "chat",
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
  cache_read_input_token_cost: (input * 0.1) / 1e6,
  cache_creation_input_token_cost: (input * 1.25) / 1e6,
  cache_creation_input_token_cost_above_1hr: (input * 2) / 1e6,
  input_cost_per_token_above_200k_tokens: (input * 2) / 1e6,
  ...extra,
});
const other = (provider: string, input: number, output: number, extra: Entry = {}): Entry => ({
  litellm_provider: provider,
  mode: "chat",
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
  ...extra,
});

function fixture(over: Record<string, Entry> = {}) {
  return {
    sample_spec: { litellm_provider: "one of https://docs.litellm.ai/docs/providers" },
    "claude-opus-5-5": claude(4, 20, { cache_read_input_token_cost: 2e-7 }),
    "claude-opus-5": claude(5, 25),
    "claude-opus-4-20250514": claude(15, 75),
    "anthropic.claude-opus-4-20250514-v1:0": other("bedrock", 99, 99),
    "us.anthropic.claude-opus-5-v1:0": other("bedrock", 99, 99),
    "gpt-5": other("openai", 1.25, 10, { cache_read_input_token_cost: 1.25e-7 }),
    "gpt-4o": other("openai", 2.5, 10, { cache_read_input_token_cost: 1.25e-6 }),
    "gpt-4o-audio-preview": other("openai", 40, 80),
    "azure/gpt-4o": other("azure", 99, 99),
    "gemini/gemini-3-flash-preview": other("gemini", 0.5, 3, { cache_read_input_token_cost: 5e-8, input_cost_per_token_above_200k_tokens: 1e-6 }),
    "gpt-6-sol": other("openai", 2, 10, { cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 2.5e-6 }),
    "gpt-4o-2024-08-06": other("openai", 2.5, 10),
    "text-embedding-3-small": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 2e-8 },
    "claude-opus-4-9": claude(8, 40),
    "xai/grok-4.5": other("xai", 2, 6, { cache_read_input_token_cost: 3e-7 }),
    "moonshot/kimi-k3": other("moonshot", 3, 15, { cache_read_input_token_cost: 3e-7 }),
    "deepseek/deepseek-v3": other("deepseek", 0.27, 1.1, { cache_read_input_token_cost: 7e-8, cache_creation_input_token_cost: 0 }),
    "mistral/mistral-small-latest": other("mistral", 0.15, 0.6),
    ...over,
  };
}

/** OpenRouter model with per-token string prices. */
const or = (id: string, input: number, output: number, extra: Record<string, number> = {}, top: Entry = {}): Entry => ({
  id,
  architecture: { output_modalities: ["text"] },
  pricing: {
    prompt: String(input / 1e6),
    completion: String(output / 1e6),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v / 1e6)])),
  },
  ...top,
});
const orClaude = (id: string, input: number, output: number, cacheRead = input * 0.1): Entry =>
  or(id, input, output, { input_cache_read: cacheRead, input_cache_write: input * 1.25, input_cache_write_1h: input * 2 });

/** OpenRouter agreeing with fixture() everywhere, plus the long-context overrides it lists. */
function orFixture(over: Entry[] = [], drop: string[] = []) {
  const base: Entry[] = [
    orClaude("anthropic/claude-opus-5.5", 4, 20, 0.2),
    orClaude("anthropic/claude-opus-5", 5, 25),
    orClaude("anthropic/claude-opus-4", 15, 75),
    or("openai/gpt-5", 1.25, 10, { input_cache_read: 0.125 }),
    or("openai/gpt-4o", 2.5, 10, { input_cache_read: 1.25 }),
    or("google/gemini-3-flash-preview", 0.5, 3, { input_cache_read: 0.05, input_cache_write: 0.0833 }),
    or("openai/gpt-6-sol", 2, 10, { input_cache_read: 0.2, input_cache_write: 2.5 }),
    or("openai/gpt-6-sol:batch", 1, 5),
    or("x-ai/grok-4.5", 2, 6, { input_cache_read: 0.3 }),
    or("moonshotai/kimi-k3", 3, 15, { input_cache_read: 0.3 }),
    orClaude("anthropic/claude-opus-4.9", 8, 40, 0.8),
    or("~anthropic/claude-opus-latest", 5, 25),
    or("typesafe/jev-router", 0, 0, {}, { pricing: { prompt: "-1", completion: "-1" } }),
    or("google/gemini-nano-banana-2.1", 1.5, 7.5, {}, { architecture: { output_modalities: ["image", "text"] } }),
  ];
  const list = [...base.filter((e) => !drop.includes(e.id as string)), ...over];
  return { data: list };
}

const plan = (data: unknown, orData: unknown = orFixture(), pricing = PRICING) => planUpdates(pricing, parseLiteLLM(data), parseOpenRouter(orData), "2026-10-07");

describe("rounding", () => {
  test("per-token to per-1M without float noise", () => {
    expect(perMillion(3e-7)).toBe(0.3);
    expect(perMillion(0.00000375)).toBe(3.75);
    expect(round6(0.1 + 0.2)).toBe(0.3);
    expect(perMillion(1.25e-7)).toBe(0.125);
  });
});

describe("OpenRouter data", () => {
  test("variants, aliases, routers and non-text models are left out, base tier prices are read", () => {
    const entries = parseOpenRouter(orFixture([or("openai/gpt-6.1-sol", 2, 10, {}, { pricing: { prompt: "0.000002", completion: "0.00001", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015" }] } })]));
    const ids = entries.map((e) => e.key);
    expect(ids).not.toContain("openai/gpt-6-sol:batch");
    expect(ids).not.toContain("~anthropic/claude-opus-latest");
    expect(ids).not.toContain("typesafe/jev-router");
    expect(entries.find((e) => e.key === "openai/gpt-6.1-sol")).toMatchObject({ id: "gpt-6.1-sol", input: 2, output: 10 });
    expect(entries.find((e) => e.key === "anthropic/claude-opus-5.5")).toMatchObject({ id: "claude-opus-5-5", cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    expect(entries.find((e) => e.key === "google/gemini-nano-banana-2.1")?.nonText).toBe(true);
  });

  test.each([
    ["not an object", []],
    ["no list", { data: [] }],
    ["entry without pricing", { data: [{ id: "anthropic/claude-x" }] }],
    ["price not a string number", orFixture([or("openai/gpt-x", 1, 2, {}, { pricing: { prompt: "abc", completion: "1" } })])],
    ["negative price", orFixture([or("openai/gpt-x", 1, 2, {}, { pricing: { prompt: "-0.5", completion: "1" } })])],
    ["no openai models", { data: [or("anthropic/claude-x", 1, 2), or("google/gemini-x", 1, 2)] }],
  ])("%s throws", (_, data) => {
    expect(() => parseOpenRouter(data)).toThrow();
  });
});

describe("normalization of the new makers' ids", () => {
  test.each([
    ["x-ai/grok-4", "grok-4"],
    ["moonshotai/kimi-k2", "kimi-k2"],
    ["qwen/qwen3-coder", "qwen3-coder"],
    ["z-ai/glm-5", "glm-5"],
    ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
    ["deepseek/deepseek-v3", "deepseek-v3"],
    ["deepseek-v4", "deepseek-v4"],
    ["mistralai/devstral-2512", "devstral-2512"],
    ["minimax/MiniMax-M2.5", "minimax-m2.5"],
    ["anthropic/claude-opus-5.5", "claude-opus-5-5"],
    ["openai/gpt-6-sol", "gpt-6-sol"],
    ["google/gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
    ["us.anthropic.claude-opus-4-1-20250805-v1:0", "claude-opus-4-1"],
    ["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeModel(input)).toBe(expected);
  });
});

describe("matching", () => {
  test("first-party entries win, resellers and dated ids fold in, nothing to change when both sources agree", () => {
    const p = plan(fixture());
    expect(p.changes).toEqual([]);
    expect(p.unchanged).toBe(6);
    expect(p.unmatched).toEqual([]);
    expect(p.fallbackSources).toEqual([]);
    expect(p.disagreements).toEqual([]);
  });

  test("a reseller is used only when there is no first-party entry", () => {
    const data = fixture();
    delete (data as Record<string, unknown>)["claude-opus-4-20250514"];
    const p = plan(data, orFixture([], ["anthropic/claude-opus-4"]));
    expect(p.fallbackSources).toEqual([{ pattern: "claude-opus-4*", key: "anthropic.claude-opus-4-20250514-v1:0" }]);
    expect(p.changes).toEqual([]); // the reseller says 99, OpenRouter has nothing to confirm it: single source
    expect(p.keptSingle[0]).toMatchObject({ pattern: "claude-opus-4*", field: "input", value: 99 });
  });

  test("a rule with no entry is reported, not an error", () => {
    const data = fixture();
    delete (data as Record<string, unknown>)["gpt-5"];
    expect(plan(data).unmatched).toEqual(["gpt-5"]);
  });

  test("a newer version does not feed an older prefix rule", () => {
    expect(plan(fixture({ "claude-opus-4-20250514": claude(15, 75) })).changes).toEqual([]);
  });
});

describe("agreement policy", () => {
  test("both sources agree on a new price: the rule changes, derived Claude cache prices stay implicit", () => {
    const p = plan(fixture({ "claude-opus-5": claude(6, 30) }), orFixture([orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"]));
    const c = p.changes[0]!;
    expect(c.rule.pattern).toBe("claude-opus-5*");
    expect(c.after).toEqual({ input: 6, output: 30, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12 });
    expect(c.write).toEqual({ input: 6, output: 30 });
    expect(c.orSource).toBe("anthropic/claude-opus-5");
    expect(p.disagreements).toEqual([]);
  });

  test("within 1% counts as agreeing and LiteLLM's value is used", () => {
    const p = plan(fixture(), orFixture([or("openai/gpt-5", 1.2505, 10.05, { input_cache_read: 0.125 })], ["openai/gpt-5"]));
    expect(p.changes).toEqual([]);
    expect(p.disagreements).toEqual([]);
  });

  test("a disagreement uses the higher value per rate and is listed with both", () => {
    // LiteLLM raises the output to 12, OpenRouter still says 10: 12 wins. OpenRouter's input is higher: 1.5 wins.
    const p = plan(fixture({ "gpt-5": other("openai", 1.25, 12, { cache_read_input_token_cost: 1.25e-7 }) }), orFixture([or("openai/gpt-5", 1.5, 10, { input_cache_read: 0.125 })], ["openai/gpt-5"]));
    const c = p.changes.find((x) => x.rule.pattern === "gpt-5")!;
    expect(c.after).toMatchObject({ input: 1.5, output: 12 });
    expect(p.disagreements).toEqual([
      expect.objectContaining({
        target: "gpt-5",
        kind: "update",
        litellm: "gpt-5",
        openrouter: "openai/gpt-5",
        fields: [
          { field: "input", litellm: 1.25, openrouter: 1.5, used: 1.5 },
          { field: "output", litellm: 12, openrouter: 10, used: 12 },
        ],
      }),
    ]);
    const text = renderReport(p);
    expect(text).toContain("## Sources disagree, higher used");
    expect(text).toContain("| `gpt-5` | input | 1.25 | 1.5 | 1.5 | https://developers.openai.com/api/docs/pricing |");
  });

  test("a cheaper OpenRouter price never lowers an existing rule", () => {
    const p = plan(fixture(), orFixture([or("openai/gpt-5", 0.6, 4, { input_cache_read: 0.06 })], ["openai/gpt-5"]));
    expect(p.changes).toEqual([]);
    expect(p.disagreements[0]!.fields.map((f) => f.used)).toEqual([1.25, 10, 0.125]);
  });

  test("a rule only LiteLLM lists is never changed from that single source", () => {
    const p = plan(fixture({ "claude-opus-5": claude(6, 30) }), orFixture([], ["anthropic/claude-opus-5"]));
    expect(p.changes).toEqual([]);
    expect(p.keptSingle.map((k) => [k.pattern, k.field, k.current, k.value])).toContainEqual(["claude-opus-5*", "input", 5, 6]);
    expect(renderReport(p)).toContain("never changed automatically");
  });

  test("a rate only one source lists stays as it is while the others update", () => {
    // OpenRouter lists no cache read for gpt-4o: the read price is left alone, input and output follow both sources.
    const p = plan(fixture({ "gpt-4o": other("openai", 3, 12, { cache_read_input_token_cost: 1.5e-6 }) }), orFixture([or("openai/gpt-4o", 3, 12)], ["openai/gpt-4o"]));
    const c = p.changes.find((x) => x.rule.pattern === "gpt-4o*")!;
    expect(c.after).toMatchObject({ input: 3, output: 12, cacheRead: 1.25, cacheWrite5m: 3, cacheWrite1h: 3 }); // writes follow the input price
    expect(p.keptSingle).toEqual([{ pattern: "gpt-4o*", field: "cacheRead", current: 1.25, value: 1.5, from: "LiteLLM" }]);
  });

  test("makers without a cache-write charge keep writes at the input price", () => {
    const p = plan(fixture({ "gpt-4o": other("openai", 3, 12, { cache_read_input_token_cost: 1.5e-6 }) }), orFixture([or("openai/gpt-4o", 3, 12, { input_cache_read: 1.5 })], ["openai/gpt-4o"]));
    expect(p.changes[0]!.write).toEqual({ input: 3, output: 12, cacheRead: 1.5, cacheWrite5m: 3, cacheWrite1h: 3 });
  });

  test("a changed price is edited in place and the version bumped", () => {
    const p = plan(
      fixture({ "claude-opus-5": claude(6, 30), "gpt-5": other("openai", 1.25, 8, { cache_read_input_token_cost: 1.25e-7 }) }),
      orFixture([orClaude("anthropic/claude-opus-5", 6, 30), or("openai/gpt-5", 1.25, 8, { input_cache_read: 0.125 })], ["anthropic/claude-opus-5", "openai/gpt-5"]),
    );
    expect(p.changes.map((c) => c.rule.pattern)).toEqual(["claude-opus-5*", "gpt-5"]);
    // gpt-5's output went down because both sources agree on 8
    const out = applyChanges(PRICING, p.changes);
    const before = PRICING.split("\n");
    const after = out.split("\n");
    expect(after.length).toBe(before.length);
    const diff = after.map((l, i) => [before[i], l]).filter(([a, b]) => a !== b);
    expect(diff).toEqual([
      ["export const BUILTIN_PRICES_VERSION = 4;", "export const BUILTIN_PRICES_VERSION = 5;"],
      ['  { pattern: "claude-opus-5*", input: 5, output: 25 },', '  { pattern: "claude-opus-5*", input: 6, output: 30 },'],
      [
        '  { pattern: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },',
        '  { pattern: "gpt-5", input: 1.25, output: 8, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },',
      ],
    ]);
    expect(out).toContain("// Anthropic — derived cache prices unless noted.");
  });

  test("no changes leaves the file alone", () => {
    expect(applyChanges(PRICING, [])).toBe(PRICING);
  });

  test("the real pricing.ts parses and its effective rates are derived like PriceBook's", async () => {
    const rules = parseRules(await Bun.file(new URL("../src/core/pricing.ts", import.meta.url)).text());
    expect(rules.length).toBeGreaterThan(40);
    expect(effective(rules.find((r) => r.pattern === "claude-sonnet-4*")!.fields)).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
  });
});

describe("new models", () => {
  const ids = (p: ReturnType<typeof plan>) => p.additions.map((a) => a.id);

  test("added when both sources list them, from priced makers only, not snapshots, other kinds or free models", () => {
    const p = plan(fixture());
    expect(ids(p)).toContain("gpt-6-sol");
    expect(ids(p)).toContain("claude-opus-4-9");
    expect(ids(p)).toContain("grok-4.5");
    expect(ids(p)).toContain("kimi-k3");
    expect(ids(p)).not.toContain("gpt-4o-2024-08-06");
    expect(ids(p)).not.toContain("text-embedding-3-small");
    expect(ids(p)).not.toContain("gpt-4o-audio-preview");
    expect(ids(p)).not.toContain("claude-opus-5");
    expect(ids(p)).not.toContain("mistral-small-latest");
    const sol = p.additions.find((a) => a.id === "gpt-6-sol")!;
    expect(sol).toMatchObject({ litellm: "gpt-6-sol", openrouter: "openai/gpt-6-sol", rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 2.5 } });
    expect(p.additions.find((a) => a.id === "claude-opus-4-9")!.write).toEqual({ input: 8, output: 40 });
  });

  test("a source that disagrees still adds the model at the higher price, and says so", () => {
    const p = plan(fixture({ "gpt-6-sol": other("openai", 4, 20, { cache_read_input_token_cost: 4e-7, cache_creation_input_token_cost: 5e-6 }) }));
    expect(p.additions.find((a) => a.id === "gpt-6-sol")!.rates).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 });
    const d = p.disagreements.find((x) => x.target === "gpt-6-sol")!;
    expect(d.kind).toBe("new");
    expect(d.fields.map((f) => [f.field, f.litellm, f.openrouter, f.used])).toContainEqual(["input", 4, 2, 4]);
  });

  test("OpenRouter's higher price wins over LiteLLM's lower one", () => {
    const p = plan(fixture(), orFixture([or("x-ai/grok-4.5", 3, 6, { input_cache_read: 0.3 })], ["x-ai/grok-4.5"]));
    expect(p.additions.find((a) => a.id === "grok-4.5")!.rates.input).toBe(3);
  });

  test("single source: only LiteLLM's first-party entry may add a model, and it is marked", () => {
    const p = plan(fixture(), orFixture([], ["moonshotai/kimi-k3"]));
    const a = p.additions.find((x) => x.id === "kimi-k3")!;
    expect(a.openrouter).toBeUndefined();
    expect(renderReport(p)).toContain("## Single source additions");
    expect(renderReport(p)).toMatch(/\| `kimi-k3` \| 3 \| 15 \|/);
  });

  test("never added from a reseller or from OpenRouter alone", () => {
    const data = fixture({ "bedrock/deepseek.v9": other("bedrock", 1, 2), "gpt-7": other("azure", 1, 2) });
    const p = plan(data, orFixture([or("openai/gpt-7", 1, 2), or("z-ai/glm-9", 1, 2), or("anthropic/claude-sonnet-9", 1, 2)]));
    expect(ids(p)).not.toContain("gpt-7");
    expect(ids(p)).not.toContain("glm-9");
    expect(ids(p)).not.toContain("claude-sonnet-9");
    expect(p.skipped.find((s) => s.reason.startsWith("only on OpenRouter"))!.ids).toEqual(expect.arrayContaining(["glm-9", "claude-sonnet-9"]));
  });

  test("a model retiring within 90 days or already retired is not added", () => {
    const p = plan(fixture({ "gpt-6-sol": other("openai", 2, 10, { cache_read_input_token_cost: 2e-7, deprecation_date: "2026-11-01" }) }));
    expect(ids(p)).not.toContain("gpt-6-sol");
  });

  test("a rule is not added when an existing prefix rule already prices the model identically", () => {
    const p = plan(fixture({ "claude-opus-4-9": claude(15, 75) }), orFixture([orClaude("anthropic/claude-opus-4.9", 15, 75)], ["anthropic/claude-opus-4.9"]));
    expect(ids(p)).not.toContain("claude-opus-4-9");
    expect(p.skipped.find((s) => s.reason.startsWith("already priced"))!.ids).toContain("claude-opus-4-9");
  });

  test("the report carries the tables, the official links and the caveat", () => {
    const text = renderReport(plan(fixture({ "claude-opus-5": claude(6, 30) }), orFixture([orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"])));
    expect(text).toContain("| `claude-opus-5*` | input | 5 | 6 |");
    expect(text).toContain("## New models added");
    expect(text).toContain("`gpt-6-sol`");
    expect(text).toContain("https://ai.google.dev/gemini-api/docs/pricing");
    expect(text).toContain("## Skipped");
  });
});

describe("placement of new rules", () => {
  const applied = () => {
    const p = plan(fixture());
    return { p, out: applyChanges(PRICING, p.changes, p.additions) };
  };

  test("a new rule goes under its maker, a more specific one before the prefix rule that covers it", () => {
    const { out } = applied();
    const lines = out.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    // OpenAI: exact gpt-6-sol after the existing rules of the section, before the Google heading
    expect(at('pattern: "gpt-6-sol"')).toBeGreaterThan(at('pattern: "gpt-4o*"'));
    expect(at('pattern: "gpt-6-sol"')).toBeLessThan(at("// Google"));
    // Anthropic: claude-opus-4-9 sits above claude-opus-4*
    expect(at('pattern: "claude-opus-4-9"')).toBeLessThan(at('pattern: "claude-opus-4*"'));
    expect(at('pattern: "claude-opus-4-9"')).toBeGreaterThan(at("// Anthropic"));
    // Claude's derived cache prices stay implicit
    expect(out).toContain('{ pattern: "claude-opus-4-9", input: 8, output: 40 },');
  });

  test("a maker without a section gets a heading and sorted rules at the end of the table", () => {
    const { out } = applied();
    const lines = out.split("\n");
    const end = lines.findIndex((l) => l.startsWith("];"));
    const xai = lines.findIndex((l) => l.includes("// xAI"));
    const kimi = lines.findIndex((l) => l.includes("// Moonshot"));
    expect(xai).toBeGreaterThan(lines.findIndex((l) => l.includes('pattern: "gemini-3-flash*"')));
    expect(kimi).toBeGreaterThan(xai);
    expect(kimi).toBeLessThan(end);
    expect(lines[xai + 1]).toContain('pattern: "grok-4.5"');
    expect(lines[kimi + 1]).toContain('pattern: "kimi-k3"');
    expect(lines.some((l) => l.includes("// DeepSeek"))).toBe(false); // deepseek-v3 is a legacy id: no section for it
  });

  test("the version is bumped once for the whole change set, and the result parses", () => {
    const { p, out } = applied();
    expect(out).toContain("BUILTIN_PRICES_VERSION = 5;");
    expect(parseRules(out).length).toBe(6 + p.additions.length);
    expect(plan(fixture(), orFixture(), out).additions).toEqual([]); // a second run adds nothing
  });

  test("applying a plan to a CRLF copy keeps the line endings", () => {
    const crlf = PRICING.replaceAll("\n", "\r\n");
    expect(parseRules(crlf).length).toBe(6);
    const p = planUpdates(crlf, parseLiteLLM(fixture({ "claude-opus-5": claude(6, 30) })), parseOpenRouter(orFixture([orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"])), "2026-10-07");
    const out = applyChanges(crlf, p.changes, p.additions);
    expect(out).toContain("input: 6, output: 30");
    expect(out).toContain("input: 8, output: 40");
    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
    expect(out.split("\r\n").length).toBeGreaterThan(PRICING.split("\n").length);
  });
});

describe("sanity guard", () => {
  test("a 10x jump needs a human", () => {
    const p = plan(fixture({ "claude-opus-5": claude(60, 25) }), orFixture([orClaude("anthropic/claude-opus-5", 60, 25)], ["anthropic/claude-opus-5"]));
    expect(p.problems.join()).toContain("more than 10x");
  });

  test("a drop to zero needs a human", () => {
    const p = plan(fixture({ "gpt-4o": other("openai", 0, 10, { cache_read_input_token_cost: 1.25e-6 }) }), orFixture([or("openai/gpt-4o", 0, 10, { input_cache_read: 1.25 })], ["openai/gpt-4o"]));
    expect(p.problems.join()).toContain("drops to 0");
  });

  test("more than half of the existing rules changing needs a human", () => {
    const data = fixture({
      "claude-opus-5-5": claude(4.4, 22, { cache_read_input_token_cost: 2.2e-7 }),
      "claude-opus-5": claude(5.5, 27),
      "claude-opus-4-20250514": claude(16, 80),
      "gpt-5": other("openai", 1.3, 10, { cache_read_input_token_cost: 1.25e-7 }),
    });
    const orData = orFixture(
      [orClaude("anthropic/claude-opus-5.5", 4.4, 22, 0.22), orClaude("anthropic/claude-opus-5", 5.5, 27), orClaude("anthropic/claude-opus-4", 16, 80), or("openai/gpt-5", 1.3, 10, { input_cache_read: 0.125 })],
      ["anthropic/claude-opus-5.5", "anthropic/claude-opus-5", "anthropic/claude-opus-4", "openai/gpt-5"],
    );
    expect(plan(data, orData).problems.join()).toContain("more than half");
  });

  test("additions do not count towards the half guard", () => {
    // Ninety new models and one changed rule out of six: fine.
    const extra: Record<string, Entry> = {};
    const orExtra: Entry[] = [];
    for (let i = 0; i < 90; i++) {
      extra[`gpt-9-${i}`] = other("openai", 1 + i / 100, 2);
      orExtra.push(or(`openai/gpt-9-${i}`, 1 + i / 100, 2));
    }
    const p = plan(fixture({ ...extra, "claude-opus-5": claude(6, 30) }), orFixture([...orExtra, orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"]));
    expect(p.additions.length).toBeGreaterThan(90);
    expect(p.changes.length).toBe(1);
    expect(p.problems).toEqual([]);
  });

  test("small changes pass", () => {
    const p = plan(fixture({ "claude-opus-5": claude(6, 30) }), orFixture([orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"]));
    expect(p.problems).toEqual([]);
  });
});

describe("bad data", () => {
  test.each([
    ["not an object", []],
    ["entry not an object", { "claude-x": 5 }],
    ["negative price", fixture({ "claude-opus-5": claude(-1, 25) })],
    ["string price", fixture({ "claude-opus-5": claude(5, 25, { output_cost_per_token: "0.1" }) })],
    ["no provider", fixture({ "claude-opus-5": { mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 } })],
    ["no anthropic models", { "gpt-5": other("openai", 1, 2), "gemini/g": other("gemini", 1, 2) }],
  ])("%s throws", (_, data) => {
    expect(() => parseLiteLLM(data)).toThrow();
  });

  const tmp = async () => {
    const dir = mkdtempSync(join(tmpdir(), "prices-test-"));
    await Bun.write(`${dir}/pricing.ts`, PRICING);
    await Bun.write(`${dir}/ll.json`, JSON.stringify(fixture({ "claude-opus-5": claude(6, 30) })));
    await Bun.write(`${dir}/or.json`, JSON.stringify(orFixture([orClaude("anthropic/claude-opus-5", 6, 30)], ["anthropic/claude-opus-5"])));
    return dir;
  };
  const quiet = async <T>(fn: () => Promise<T>) => {
    const [log, err] = [console.log, console.error];
    console.log = console.error = () => {};
    try {
      return await fn();
    } finally {
      [console.log, console.error] = [log, err];
    }
  };

  test("invalid JSON from either source exits 1 and writes nothing", async () => {
    for (const bad of ["ll", "or"]) {
      const dir = await tmp();
      await Bun.write(`${dir}/${bad}.json`, "{nope");
      const code = await quiet(() => main(["--source", `${dir}/ll.json`, "--openrouter", `${dir}/or.json`, "--pricing", `${dir}/pricing.ts`, "--no-official", "--report", `${dir}/r.md`]));
      expect(code).toBe(1);
      expect(await Bun.file(`${dir}/pricing.ts`).text()).toBe(PRICING);
      expect(await Bun.file(`${dir}/r.md`).exists()).toBe(false);
    }
  });

  test("main edits a copy of pricing.ts, and --dry-run does not", async () => {
    const dir = await tmp();
    const args = ["--source", `${dir}/ll.json`, "--openrouter", `${dir}/or.json`, "--pricing", `${dir}/pricing.ts`, "--no-official"];
    expect(await quiet(() => main([...args, "--dry-run"]))).toBe(0);
    expect(await Bun.file(`${dir}/pricing.ts`).text()).toBe(PRICING);
    expect(await quiet(() => main([...args, "--report", `${dir}/r.md`]))).toBe(0);
    const written = await Bun.file(`${dir}/pricing.ts`).text();
    expect(written).toContain("input: 6, output: 30");
    expect(written).toContain('pattern: "gpt-6-sol"');
    expect(await Bun.file(`${dir}/r.md`).text()).toContain("## Price changes");
  });

  test("main keeps CRLF line endings", async () => {
    const dir = await tmp();
    await Bun.write(`${dir}/pricing.ts`, PRICING.replaceAll("\n", "\r\n"));
    const code = await quiet(() => main(["--source", `${dir}/ll.json`, "--openrouter", `${dir}/or.json`, "--pricing", `${dir}/pricing.ts`, "--no-official"]));
    expect(code).toBe(0);
    const written = await Bun.file(`${dir}/pricing.ts`).text();
    expect(written).toContain("\r\n");
    expect(written.replaceAll("\r\n", "")).not.toContain("\n");
  });
});

// --- official pages first ---------------------------------------------------------------------------------------

const offEntry = (id: string, input: number, output: number, extra: Partial<OfficialEntry> = {}): OfficialEntry => ({
  key: id,
  id,
  provider: "official",
  input,
  output,
  cacheRead: round6(input * 0.1),
  cacheWrite5m: input,
  cacheWrite1h: input,
  ...extra,
});
const offClaude = (id: string, input: number, output: number, cacheRead = round6(input * 0.1)): OfficialEntry =>
  offEntry(id, input, output, { cacheRead, cacheWrite5m: round6(input * 1.25), cacheWrite1h: round6(input * 2) });
const read = (maker: string, ...entries: OfficialEntry[]): OfficialOutcome => ({ maker, entries });
const planO = (official: OfficialOutcome[], data: unknown = fixture(), orData: unknown = orFixture()) => planUpdates(PRICING, parseLiteLLM(data), parseOpenRouter(orData), "2026-10-07", official);

describe("official pages first", () => {
  test("an official price wins outright, even when it is lower than both aggregators, and the aggregators are listed", () => {
    const p = planO([read("OpenAI", offEntry("gpt-5", 1, 8, { cacheRead: 0.1 }))]);
    const c = p.changes.find((x) => x.rule.pattern === "gpt-5")!;
    expect(c.kind).toBe("official");
    expect(c.after).toMatchObject({ input: 1, output: 8, cacheRead: 0.1 });
    expect(p.disagreements).toEqual([]);
    expect(p.officialDiffs).toEqual([
      expect.objectContaining({
        target: "gpt-5",
        official: "gpt-5",
        fields: [
          { field: "input", official: 1, litellm: 1.25, openrouter: 1.25 },
          { field: "output", official: 8, litellm: 10, openrouter: 10 },
          { field: "cacheRead", official: 0.1, litellm: 0.125, openrouter: 0.125 },
        ],
      }),
    ]);
    expect(p.sources.find((s) => s.pattern === "gpt-5")!.kind).toBe("official");
    const text = renderReport(p);
    expect(text).toContain("## Aggregators differ from the official price");
    expect(text).toContain("| `gpt-5` | input | 1 | 1.25 | 1.25 |");
    expect(text).toContain("| `gpt-5` | input | 1.25 | 1 | official | `gpt-5` |");
  });

  test("an official price equal to the aggregators changes nothing and lists nothing", () => {
    const p = planO([read("OpenAI", offEntry("gpt-5", 1.25, 10, { cacheRead: 0.125 })), read("Anthropic", offClaude("claude-opus-5-5", 4, 20, 0.2))]);
    expect(p.changes).toEqual([]);
    expect(p.officialDiffs).toEqual([]);
    expect(p.sources.filter((s) => s.kind === "official").map((s) => s.pattern)).toEqual(["claude-opus-5-5*", "gpt-5"]);
  });

  test("a rule the official page doesn't list falls back to the aggregators with the higher price winning", () => {
    // The OpenAI page lists gpt-5 only. gpt-4o goes to LiteLLM 3 and OpenRouter 2.5: 3 wins. The same page does not touch gpt-5.
    const p = planO([read("OpenAI", offEntry("gpt-5", 1.25, 10, { cacheRead: 0.125 }))], fixture({ "gpt-4o": other("openai", 3, 10, { cache_read_input_token_cost: 1.25e-6 }) }));
    const c = p.changes.find((x) => x.rule.pattern === "gpt-4o*")!;
    expect(c.kind).toBe("higher of aggregators");
    expect(c.after.input).toBe(3);
    expect(p.disagreements.map((d) => d.target)).toEqual(["gpt-4o*"]);
    expect(p.officialDiffs).toEqual([]);
  });

  test("a page that could not be read sends that maker alone back to the aggregators", () => {
    const failed: OfficialOutcome = { maker: "OpenAI", error: "HTTP 503 from https://developers.openai.com/api/docs/pricing.md" };
    const p = planO([failed, read("Anthropic", offClaude("claude-opus-5", 4, 20))], fixture({ "gpt-5": other("openai", 1.25, 12, { cache_read_input_token_cost: 1.25e-7 }) }), orFixture([or("openai/gpt-5", 1.25, 12, { input_cache_read: 0.125 })], ["openai/gpt-5"]));
    expect(p.changes.find((c) => c.rule.pattern === "gpt-5")).toMatchObject({ kind: "aggregators agree", official: "" });
    expect(p.changes.find((c) => c.rule.pattern === "claude-opus-5*")).toMatchObject({ kind: "official" });
    expect(p.official.map((o) => [o.maker, o.state])).toEqual([["OpenAI", "failed"], ["Anthropic", "read"]]);
    const text = renderReport(p);
    expect(text).toContain("- OpenAI: official page could not be read: HTTP 503");
    expect(text).toContain("- Anthropic: read, 1 models.");
  });

  test("a maker with no machine-readable page is said so in the report", () => {
    const p = planO([{ maker: "DeepSeek", unavailable: "the page is HTML only" }]);
    expect(renderReport(p)).toContain("- DeepSeek: no official machine-readable price (the page is HTML only)");
  });

  test("a model on the official page that no rule prices is added with its exact id", () => {
    const p = planO([read("OpenAI", offEntry("gpt-5.7", 3, 18, { cacheRead: 0.3 }), offEntry("gpt-4o-search-preview", 9, 9), offEntry("gpt-4-0613", 30, 60))]);
    const a = p.additions.find((x) => x.id === "gpt-5.7")!;
    expect(a).toMatchObject({ kind: "official", official: "gpt-5.7", rates: { input: 3, output: 18, cacheRead: 0.3, cacheWrite5m: 3, cacheWrite1h: 3 } });
    expect(p.additions.some((x) => x.id.startsWith("gpt-4o-search") || x.id === "gpt-4-0613")).toBe(false);
    const text = renderReport(p);
    expect(text).toContain("## New models from official pages");
    expect(text).toContain("| `gpt-5.7` | 3 | 18 | 0.3 | 3 | `gpt-5.7` |");
    expect(applyChanges(PRICING, p.changes, p.additions)).toContain('{ pattern: "gpt-5.7", input: 3, output: 18, cacheRead: 0.3, cacheWrite5m: 3, cacheWrite1h: 3 }');
  });

  test("a variant a prefix rule catches gets its own rule when the page prices it differently, not when the price is the same", () => {
    const p = planO([read("OpenAI", offEntry("gpt-4o", 2.5, 10, { cacheRead: 1.25 }), offEntry("gpt-4o-xl", 5, 20, { cacheRead: 2.5 }), offEntry("gpt-4o-same", 2.5, 10, { cacheRead: 1.25 }))]);
    expect(p.additions.filter((a) => a.kind === "official").map((a) => a.id)).toEqual(["gpt-4o-xl"]);
  });

  test("a cached-input price the page doesn't list leaves the rule's own value", () => {
    const p = planO([read("OpenAI", offEntry("gpt-5", 2, 10, { cacheRead: 2, unlisted: ["cacheRead"] }))]);
    const c = p.changes.find((x) => x.rule.pattern === "gpt-5")!;
    expect(c.after.input).toBe(2);
    expect(c.after.cacheRead).toBe(0.125);
    expect(p.officialDiffs[0]!.fields.map((f) => f.field)).not.toContain("cacheRead");
  });

  test("explicit Claude cache prices from the page are written only when they differ from the derived ones", () => {
    const p = planO([read("Anthropic", offClaude("claude-opus-5-5", 4, 20, 0.2), offClaude("claude-opus-5", 5, 25, 0.25))]);
    expect(p.changes).toHaveLength(1);
    expect(p.changes[0]!.write).toEqual({ input: 5, output: 25, cacheRead: 0.25 });
  });

  test("an intro price is announced in the report with its date", () => {
    const p = planO([read("Google Gemini", offEntry("gemini-3-flash-preview", 0.5, 3, { cacheRead: 0.05, scheduled: [{ from: "2027-01-01", to: { input: 1, output: 6, cacheRead: 0.1 } }] }))]);
    expect(p.scheduled).toEqual([{ target: "gemini-3-flash*", from: "2027-01-01", changes: [{ field: "input", now: 0.5, then: 1 }, { field: "output", now: 3, then: 6 }, { field: "cacheRead", now: 0.05, then: 0.1 }] }]);
    expect(renderReport(p)).toContain("| `gemini-3-flash*` | 2027-01-01 | input | 0.5 | 1 |");
  });

  test("the sanity guard also covers official prices", () => {
    const p = planO([read("OpenAI", offEntry("gpt-5", 20, 10, { cacheRead: 0.125 }))]);
    expect(p.problems.join("\n")).toContain("`gpt-5` input moves more than 10x (1.25 to 20, from the official page");
  });

  test("the report has the new sections even when there is nothing to say", () => {
    const text = renderReport(planO([]));
    for (const h of ["## Official pages", "## Price changes", "## New models from official pages", "## Aggregators differ from the official price", "## Sources disagree, higher used", "## Scheduled price changes", "## Price sources", "## Skipped", "## Review"]) {
      expect(text).toContain(h);
    }
  });
});
