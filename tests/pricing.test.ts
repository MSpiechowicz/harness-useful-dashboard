import { describe, expect, test } from "bun:test";
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
    ["", "unknown"],
    [null, "unknown"],
  ])("%p → %p", (input, expected) => {
    expect(normalizeModel(input as string | null)).toBe(expected);
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

  test("fast mode doubles the price", () => {
    const std = book.cost("claude-opus-5-5", { ...zero, output: M });
    const fast = book.cost("claude-opus-5-5", { ...zero, output: M }, "fast");
    expect(fast.usd).toBeCloseTo(std.usd * 2, 6);
  });

  test("unknown models use a flagged fallback", () => {
    const c = book.cost("gpt-5.6-sol", { ...zero, input: M });
    expect(c.estimated).toBe(true);
    expect(c.usd).toBeGreaterThan(0);
    expect(book.cost("some-new-model", { ...zero, input: M }).estimated).toBe(true);
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
