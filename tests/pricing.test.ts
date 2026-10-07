import { describe, expect, test } from "bun:test";
import { modelMaker } from "../src/core/models.ts";
import { normalizeModel, PriceBook } from "../src/core/pricing.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
const M = 1_000_000;

describe("normalizeModel", () => {
  test.each([
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-opus-4-6[1m]", "claude-opus-4-6"],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    ["anthropic/claude-opus-5-5", "claude-opus-5-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["GPT-5", "gpt-5"],
    // Routers: Copilot and OpenRouter prefixes go, Claude's dotted versions fold to Anthropic's dashes.
    ["github-copilot/claude-opus-5.5", "claude-opus-5-5"],
    ["claude-haiku-4.5", "claude-haiku-4-5"],
    ["openrouter/anthropic/claude-sonnet-4.5", "claude-sonnet-4-5"],
    ["openai-codex/gpt-6-sol", "gpt-6-sol"],
    ["models/gemini-2.5-pro", "gemini-2.5-pro"],
    // Other makers behind routers: the vendor prefix goes, a trailing "-v3" is a version, not a Bedrock suffix.
    ["x-ai/grok-4", "grok-4"],
    ["moonshotai/kimi-k2", "kimi-k2"],
    ["qwen/qwen3-coder", "qwen3-coder"],
    ["z-ai/glm-5", "glm-5"],
    ["deepseek/deepseek-v3", "deepseek-v3"],
    ["deepseek-v4", "deepseek-v4"],
    ["mistralai/devstral-2512", "devstral-2512"],
    ["minimax/MiniMax-M2.5", "minimax-m2.5"],
    ["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet"],
    ["", "unknown"],
    [null, "unknown"],
  ])("%p → %p", (input, expected) => {
    expect(normalizeModel(input as string | null)).toBe(expected);
  });
});

describe("modelMaker", () => {
  test.each([
    ["claude-opus-5-5", "anthropic"],
    ["github-copilot/claude-sonnet-4.5", "anthropic"],
    ["gpt-6-sol", "openai"],
    ["o3", "openai"],
    ["codex-auto-review", "openai"],
    ["gemini-2.5-pro", null],
    [null, null],
  ])("%p → %p", (input, expected) => {
    expect(modelMaker(input as string | null)).toBe(expected as "anthropic" | "openai" | null);
  });
});

describe("PriceBook", () => {
  const book = new PriceBook();

  test("Claude cache multipliers derive from input price", () => {
    // sonnet 4.x: $3 in / $15 out → 5m write 3.75, 1h write 6, read 0.30
    const c = book.cost("claude-sonnet-4-5", { input: M, output: M, cacheRead: M, cacheWrite: M, cacheWrite1h: M });
    expect(c.estimated).toBe(false);
    expect(c.usd).toBeCloseTo(3 + 15 + 0.3 + 3.75 + 6, 6);
  });

  test("explicit cache-read price wins (Opus 5.5 reads at $0.20)", () => {
    expect(book.cost("claude-opus-5-5", { ...zero, cacheRead: M }).usd).toBeCloseTo(0.2, 6);
    expect(book.cost("claude-opus-5-5", { ...zero, input: M }).usd).toBeCloseTo(4, 6);
  });

  test("more specific patterns beat shorter prefixes", () => {
    expect(book.lookup("claude-opus-5-5").rule).toBe("claude-opus-5-5*");
    expect(book.lookup("claude-opus-5").rule).toBe("claude-opus-5*");
    expect(book.lookup("claude-opus-4-1-20250805").rule).toBe("claude-opus-4-1*");
  });

  test.each([
    ["gpt-4.1-nano-2025-04-14", 0.1, 0.4],
    ["gpt-4.1-2025-04-14", 2, 8],
    ["o3-pro", 20, 80],
    ["o3-mini", 1.1, 4.4],
    ["o3", 2, 8],
    ["gpt-5-pro", 15, 120],
  ])("OpenAI %p is priced at its own list price", (model, input, output) => {
    const hit = book.lookup(model);
    expect(hit.estimated).toBe(false);
    expect([hit.price.input, hit.price.output]).toEqual([input, output]);
  });

  test("fast mode doubles the price", () => {
    const std = book.cost("claude-opus-5-5", { ...zero, output: M });
    const fast = book.cost("claude-opus-5-5", { ...zero, output: M }, "fast");
    expect(fast.usd).toBeCloseTo(std.usd * 2, 6);
  });

  test("unknown models use a flagged fallback", () => {
    const c = book.cost("gpt-9-nova", { ...zero, input: M });
    expect(c.estimated).toBe(true);
    expect(c.usd).toBeGreaterThan(0);
    expect(book.cost("some-new-model", { ...zero, input: M }).estimated).toBe(true);
  });

  test.each([
    ["models/gemini-3.1-pro-preview", 2, 12],
    ["gemini-2.5-flash-lite", 0.1, 0.4],
    ["z-ai/glm-4.6", 0.6, 2.2],
    ["glm-4.5-air", 0.2, 1.1],
  ])("%p has a price of its own", (model, input, output) => {
    const hit = book.lookup(model);
    expect(hit.estimated).toBe(false);
    expect([hit.price.input, hit.price.output]).toEqual([input, output]);
  });

  test.each(["qwen3-coder-plus", "gemini-9-ultra", "deepseek-chat", "mistral-large", "grok-4-0709", "kimi-k2-0905"])("unknown %p bills no cache-write premium", (model) => {
    const c = book.cost(model, { ...zero, cacheWrite: M, cacheWrite1h: M });
    const input = book.cost(model, { ...zero, input: M });
    expect(c.estimated).toBe(true);
    expect(c.usd).toBeCloseTo(input.usd * 2, 6);
  });

  test("unknown Claude models and missing ids keep Anthropic's cache-write multipliers", () => {
    for (const model of ["claude-sonnet-9", null]) {
      const c = book.cost(model, { ...zero, cacheWrite: M, cacheWrite1h: M });
      expect(c.estimated).toBe(true);
      expect(c.usd).toBeCloseTo(3 * 1.25 + 3 * 2, 6);
    }
  });

  test("synthetic messages are free", () => {
    expect(book.cost("<synthetic>", { ...zero, input: M }).usd).toBe(0);
  });

  test("user rules override built-ins", () => {
    const custom = new PriceBook([{ pattern: "claude-opus-5-5*", input: 1, output: 2 }]);
    const c = custom.cost("claude-opus-5-5", { ...zero, input: M, output: M });
    expect(c.usd).toBeCloseTo(3, 6);
    const exact = new PriceBook([{ pattern: "gpt-5.6-sol", input: 2, output: 8 }]);
    expect(exact.cost("gpt-5.6-sol", { ...zero, input: M }).estimated).toBe(false);
  });
});
