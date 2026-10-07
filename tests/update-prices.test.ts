import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChanges, effective, main, parseLiteLLM, parseRules, perMillion, planUpdates, renderReport, round6 } from "../scripts/update-prices.ts";

const PRICING = `export const BUILTIN_PRICES_VERSION = 4;
export const BUILTIN_PRICES: Omit<PriceRule, "source">[] = [
  // Anthropic — derived cache prices unless noted.
  { pattern: "claude-opus-5-5*", input: 4, output: 20, cacheRead: 0.2 },
  { pattern: "claude-opus-5*", input: 5, output: 25 },
  { pattern: "claude-opus-4*", input: 15, output: 75 },
  // OpenAI
  { pattern: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  { pattern: "gpt-4o*", input: 2.5, output: 10, cacheRead: 1.25, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
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
    "gpt-6-sol": other("openai", 2, 10, { cache_read_input_token_cost: 2e-7 }),
    "gpt-4o-2024-08-06": other("openai", 2.5, 10),
    "text-embedding-3-small": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 2e-8 },
    "claude-opus-4-9": claude(8, 40),
    ...over,
  };
}

const plan = (data: unknown, pricing = PRICING) => planUpdates(pricing, parseLiteLLM(data));

describe("rounding", () => {
  test("per-token to per-1M without float noise", () => {
    expect(perMillion(3e-7)).toBe(0.3);
    expect(perMillion(0.00000375)).toBe(3.75);
    expect(round6(0.1 + 0.2)).toBe(0.3);
    expect(perMillion(1.25e-7)).toBe(0.125);
  });
});

describe("matching", () => {
  test("first-party entries win, resellers and dated ids fold in", () => {
    const p = plan(fixture());
    expect(p.changes).toEqual([]);
    expect(p.unchanged).toBe(6);
    expect(p.unmatched).toEqual([]);
    expect(p.fallbackSources).toEqual([]);
  });

  test("a reseller is used only when there is no first-party entry", () => {
    const data = fixture();
    delete (data as Record<string, unknown>)["claude-opus-4-20250514"];
    const p = plan(data);
    expect(p.fallbackSources).toEqual([{ pattern: "claude-opus-4*", key: "anthropic.claude-opus-4-20250514-v1:0" }]);
    expect(p.changes[0]?.rule.pattern).toBe("claude-opus-4*");
    expect(p.changes[0]?.after.input).toBe(99);
  });

  test("a rule with no entry is reported, not an error", () => {
    const data = fixture();
    delete (data as Record<string, unknown>)["gpt-5"];
    expect(plan(data).unmatched).toEqual(["gpt-5"]);
  });

  test("a newer version does not feed an older prefix rule", () => {
    const data = fixture({ "claude-opus-4-20250514": claude(15, 75) });
    expect(plan(data).changes).toEqual([]);
  });
});

describe("changes", () => {
  test("derived Claude cache prices stay implicit", () => {
    const p = plan(fixture({ "claude-opus-5": claude(6, 30) }));
    const c = p.changes[0]!;
    expect(c.rule.pattern).toBe("claude-opus-5*");
    expect(c.after).toEqual({ input: 6, output: 30, cacheRead: 0.6, cacheWrite5m: 7.5, cacheWrite1h: 12 });
    expect(c.write).toEqual({ input: 6, output: 30 });
  });

  test("a cache price that differs from the derived one is written", () => {
    const p = plan(fixture({ "claude-opus-5": claude(5, 25, { cache_read_input_token_cost: 2.5e-7 }) }));
    expect(p.changes[0]!.write).toEqual({ input: 5, output: 25, cacheRead: 0.25 });
  });

  test("makers without a cache-write charge keep writes at the input price", () => {
    const p = plan(fixture({ "gpt-4o": other("openai", 3, 12, { cache_read_input_token_cost: 1.5e-6 }) }));
    expect(p.changes[0]!.write).toEqual({ input: 3, output: 12, cacheRead: 1.5, cacheWrite5m: 3, cacheWrite1h: 3 });
  });

  test("a changed price is edited in place and the version bumped", () => {
    const p = plan(fixture({ "claude-opus-5": claude(6, 30), "gpt-5": other("openai", 1.25, 8, { cache_read_input_token_cost: 1.25e-7 }) }));
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
  test("lists unpriced models from priced makers, not snapshots, other kinds or other makers", () => {
    const ids = plan(fixture()).suggestions.map((s) => s.id);
    expect(ids).toContain("gpt-6-sol");
    expect(ids).toContain("claude-opus-4-9");
    expect(ids).not.toContain("gpt-4o-2024-08-06");
    expect(ids).not.toContain("text-embedding-3-small");
    expect(ids).not.toContain("claude-opus-5");
  });

  test("the report carries the table, the official links and the caveat", () => {
    const text = renderReport(plan(fixture({ "claude-opus-5": claude(6, 30) })));
    expect(text).toContain("| `claude-opus-5*` | input | 5 | 6 |");
    expect(text).toContain("`gpt-6-sol`");
    expect(text).toContain("https://ai.google.dev/gemini-api/docs/pricing");
    expect(text).toContain("community-maintained");
  });
});

describe("sanity guard", () => {
  test("a 10x jump needs a human", () => {
    expect(plan(fixture({ "claude-opus-5": claude(60, 25) })).problems.join()).toContain("more than 10x");
  });

  test("a drop to zero needs a human", () => {
    expect(plan(fixture({ "gpt-4o": other("openai", 0, 10, { cache_read_input_token_cost: 1.25e-6 }) })).problems.join()).toContain("drops to 0");
  });

  test("more than half of the rules changing needs a human", () => {
    const data = fixture({
      "claude-opus-5-5": claude(4.4, 22, { cache_read_input_token_cost: 2.2e-7 }),
      "claude-opus-5": claude(5.5, 27),
      "claude-opus-4-20250514": claude(16, 80),
      "gpt-5": other("openai", 1.3, 10, { cache_read_input_token_cost: 1.25e-7 }),
    });
    expect(plan(data).problems.join()).toContain("more than half");
  });

  test("small changes pass", () => {
    expect(plan(fixture({ "claude-opus-5": claude(6, 30) })).problems).toEqual([]);
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

  test("invalid JSON exits 1 and writes nothing", async () => {
    const dir = (await import("node:fs")).mkdtempSync(join(tmpdir(), "prices-test-"));
    await Bun.write(`${dir}/bad.json`, "{nope");
    await Bun.write(`${dir}/pricing.ts`, PRICING);
    const code = await main(["--source", `${dir}/bad.json`, "--pricing", `${dir}/pricing.ts`, "--report", `${dir}/r.md`]);
    expect(code).toBe(1);
    expect(await Bun.file(`${dir}/pricing.ts`).text()).toBe(PRICING);
    expect(await Bun.file(`${dir}/r.md`).exists()).toBe(false);
  });

  test("main edits a copy of pricing.ts, and --dry-run does not", async () => {
    const dir = (await import("node:fs")).mkdtempSync(join(tmpdir(), "prices-test-"));
    await Bun.write(`${dir}/src.json`, JSON.stringify(fixture({ "claude-opus-5": claude(6, 30) })));
    await Bun.write(`${dir}/pricing.ts`, PRICING);
    const args = ["--source", `${dir}/src.json`, "--pricing", `${dir}/pricing.ts`];
    const log = console.log;
    console.log = () => {};
    try {
      expect(await main([...args, "--dry-run"])).toBe(0);
      expect(await Bun.file(`${dir}/pricing.ts`).text()).toBe(PRICING);
      expect(await main([...args, "--report", `${dir}/r.md`])).toBe(0);
    } finally {
      console.log = log;
    }
    expect(await Bun.file(`${dir}/pricing.ts`).text()).toContain("input: 6, output: 30");
    expect(await Bun.file(`${dir}/r.md`).text()).toContain("## Price changes");
  });
});

describe("line endings", () => {
  test("a pricing.ts checked out with CRLF (Windows) parses and keeps its CRLF when edited", async () => {
    const lf = await Bun.file(join(import.meta.dir, "..", "src", "core", "pricing.ts")).text();
    const crlf = lf.replace(/\r?\n/g, "\r\n");
    const a = parseRules(lf.replace(/\r\n/g, "\n"));
    const b = parseRules(crlf);
    expect(b.map((r) => [r.pattern, r.line, r.fields])).toEqual(a.map((r) => [r.pattern, r.line, r.fields]));
    const rule = b[0]!;
    const out = applyChanges(crlf, [{ rule, write: { ...rule.fields, input: rule.fields.input! + 1 } } as never]);
    expect(out.includes("\n") && !/[^\r]\n/.test(out)).toBe(true);
    expect(parseRules(out)[0]!.fields.input).toBe(rule.fields.input! + 1);
  });
});
