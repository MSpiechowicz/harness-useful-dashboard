import type { Database } from "bun:sqlite";
import { normalizeModel } from "./models.ts";

export { normalizeModel };

/** USD per 1M tokens. Missing cache rates are derived from `input` with the provider's usual multipliers. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

export interface PriceRule extends Price {
  /** Matched against the normalized model id: exact id, or prefix when it ends with "*". */
  pattern: string;
  source: "builtin" | "user";
}

/** Raised whenever BUILTIN_PRICES changes: a database priced with an older table is re-priced once on open. */
export const BUILTIN_PRICES_VERSION = 3;

/**
 * Built-in list prices (first-party API rates). Claude Code and Codex subscription users don't pay these
 * per token; the dashboard reports them as "API-equivalent" cost. Edit or extend them in Settings → Pricing.
 */
export const BUILTIN_PRICES: Omit<PriceRule, "source">[] = [
  // Anthropic — cache write 1.25x (5m) / 2x (1h), cache read 0.1x unless noted.
  { pattern: "claude-fable-5-1*", input: 10, output: 50, cacheRead: 0.25 },
  { pattern: "claude-mythos-5-1*", input: 10, output: 50, cacheRead: 0.25 },
  { pattern: "claude-fable-5*", input: 10, output: 50 },
  { pattern: "claude-mythos-5*", input: 10, output: 50 },
  { pattern: "claude-opus-5-5*", input: 4, output: 20, cacheRead: 0.2 },
  { pattern: "claude-opus-5*", input: 5, output: 25 },
  { pattern: "claude-opus-4-8*", input: 5, output: 25 },
  { pattern: "claude-opus-4-7*", input: 5, output: 25 },
  { pattern: "claude-opus-4-6*", input: 5, output: 25 },
  { pattern: "claude-opus-4-5*", input: 5, output: 25 },
  { pattern: "claude-opus-4-1*", input: 15, output: 75 },
  { pattern: "claude-opus-4*", input: 15, output: 75 },
  { pattern: "claude-sonnet-5-5*", input: 2, output: 10, cacheRead: 0.2 },
  { pattern: "claude-sonnet-5*", input: 2, output: 10 },
  { pattern: "claude-sonnet-4*", input: 3, output: 15 },
  { pattern: "claude-3-7-sonnet*", input: 3, output: 15 },
  { pattern: "claude-3-5-sonnet*", input: 3, output: 15 },
  { pattern: "claude-haiku-4-5*", input: 1, output: 5 },
  { pattern: "claude-3-5-haiku*", input: 0.8, output: 4 },
  { pattern: "claude-3-haiku*", input: 0.25, output: 1.25 },
  { pattern: "claude-3-opus*", input: 15, output: 75 },
  // OpenAI — cached input is 0.1x, no cache-write charge.
  { pattern: "gpt-5-nano*", input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite5m: 0.05, cacheWrite1h: 0.05 },
  { pattern: "gpt-5-mini*", input: 0.25, output: 2, cacheRead: 0.025, cacheWrite5m: 0.25, cacheWrite1h: 0.25 },
  // Exact families only: newer point releases (gpt-5.x) have their own prices and fall back as "estimated".
  { pattern: "gpt-5", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  { pattern: "gpt-5-codex*", input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  // Pro models have no cached-input discount.
  { pattern: "gpt-5-pro*", input: 15, output: 120, cacheRead: 15, cacheWrite5m: 15, cacheWrite1h: 15 },
  { pattern: "gpt-4.1-nano*", input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite5m: 0.1, cacheWrite1h: 0.1 },
  { pattern: "gpt-4.1-mini*", input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite5m: 0.4, cacheWrite1h: 0.4 },
  { pattern: "gpt-4.1*", input: 2, output: 8, cacheRead: 0.5, cacheWrite5m: 2, cacheWrite1h: 2 },
  { pattern: "gpt-4o-mini*", input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite5m: 0.15, cacheWrite1h: 0.15 },
  { pattern: "gpt-4o*", input: 2.5, output: 10, cacheRead: 1.25, cacheWrite5m: 2.5, cacheWrite1h: 2.5 },
  { pattern: "o4-mini*", input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite5m: 1.1, cacheWrite1h: 1.1 },
  { pattern: "o3-pro*", input: 20, output: 80, cacheRead: 20, cacheWrite5m: 20, cacheWrite1h: 20 },
  { pattern: "o3-mini*", input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite5m: 1.1, cacheWrite1h: 1.1 },
  { pattern: "o3", input: 2, output: 8, cacheRead: 0.5, cacheWrite5m: 2, cacheWrite1h: 2 },
  { pattern: "codex-mini*", input: 1.5, output: 6, cacheRead: 0.375, cacheWrite5m: 1.5, cacheWrite1h: 1.5 },
  // Google — up to 200k tokens of context; cache storage is billed per hour, not per write.
  { pattern: "gemini-2.5-pro*", input: 1.25, output: 10, cacheRead: 0.31, cacheWrite5m: 1.25, cacheWrite1h: 1.25 },
  { pattern: "gemini-3.1-pro*", input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 2, cacheWrite1h: 2 },
  { pattern: "gemini-2.5-flash-lite*", input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite5m: 0.1, cacheWrite1h: 0.1 },
  { pattern: "gemini-2.5-flash*", input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite5m: 0.3, cacheWrite1h: 0.3 },
  // Zhipu, as OpenCode, Zed and Cline users often run it.
  { pattern: "glm-4.6*", input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite5m: 0.6, cacheWrite1h: 0.6 },
  { pattern: "glm-4.5-air*", input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite5m: 0.2, cacheWrite1h: 0.2 },
  { pattern: "glm-4.5*", input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite5m: 0.6, cacheWrite1h: 0.6 },
];

/** A price for a maker that doesn't charge extra for cache writes: written tokens cost what input does. */
function noCacheWrite(input: number, output: number, cacheRead = input * 0.1): Price {
  return { input, output, cacheRead, cacheWrite5m: input, cacheWrite1h: input };
}

/** Used for models with no matching rule; rows priced this way are flagged `cost_estimated`. */
const FALLBACKS: { test: RegExp; price: Price }[] = [
  { test: /opus/, price: { input: 5, output: 25 } },
  { test: /fable|mythos/, price: { input: 10, output: 50 } },
  { test: /haiku/, price: { input: 1, output: 5 } },
  { test: /claude|sonnet/, price: { input: 3, output: 15 } },
  { test: /^(gpt|o\d|codex)/, price: noCacheWrite(1.25, 10) },
  { test: /^gemini/, price: noCacheWrite(1.25, 10) },
  { test: /^deepseek/, price: noCacheWrite(0.28, 0.42) },
  { test: /^grok/, price: noCacheWrite(3, 15, 0.75) },
  { test: /^kimi/, price: noCacheWrite(0.6, 2.5, 0.15) },
  { test: /^glm/, price: noCacheWrite(0.6, 2.2, 0.11) },
  { test: /^qwen/, price: noCacheWrite(1, 5) },
  // Any other named model: not Anthropic's, so no cache-write charge.
  { test: /^(?!unknown$)/, price: noCacheWrite(3, 15) },
];
/** No model id at all: most usage is Claude's, priced like a Sonnet. */
const DEFAULT_FALLBACK: Price = { input: 3, output: 15 };


function matches(pattern: string, model: string): boolean {
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return model === pattern;
}

function specificity(pattern: string): number {
  return pattern.endsWith("*") ? pattern.length - 1 : pattern.length + 1000;
}

export class PriceBook {
  private rules: PriceRule[];
  private cache = new Map<string, { price: Price; estimated: boolean; rule: string | null }>();

  constructor(userRules: Omit<PriceRule, "source">[] = []) {
    const builtin: PriceRule[] = BUILTIN_PRICES.map((r) => ({ ...r, source: "builtin" }));
    const user: PriceRule[] = userRules.map((r) => ({ ...r, source: "user" }));
    // User rules win ties: sort by specificity, user before builtin.
    this.rules = [...user, ...builtin].sort((a, b) => {
      const d = specificity(b.pattern) - specificity(a.pattern);
      if (d !== 0) return d;
      return a.source === "user" ? -1 : b.source === "user" ? 1 : 0;
    });
  }

  static fromDb(db: Database): PriceBook {
    const rows = db
      .query<
        { pattern: string; input: number; output: number; cache_read: number | null; cache_write_5m: number | null; cache_write_1h: number | null },
        []
      >("SELECT * FROM pricing")
      .all();
    return new PriceBook(
      rows.map((r) => ({
        pattern: r.pattern,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read ?? undefined,
        cacheWrite5m: r.cache_write_5m ?? undefined,
        cacheWrite1h: r.cache_write_1h ?? undefined,
      })),
    );
  }

  allRules(): PriceRule[] {
    return this.rules;
  }

  lookup(model: string | null | undefined): { price: Price; estimated: boolean; rule: string | null } {
    const m = normalizeModel(model);
    const hit = this.cache.get(m);
    if (hit) return hit;
    const rule = this.rules.find((r) => matches(r.pattern, m));
    let result;
    if (rule) result = { price: rule, estimated: false, rule: rule.pattern };
    else result = { price: FALLBACKS.find((f) => f.test.test(m))?.price ?? DEFAULT_FALLBACK, estimated: true, rule: null };
    this.cache.set(m, result);
    return result;
  }

  /** Every token kind's rate for a model ($ per 1M), the missing cache rates derived. Synthetic messages cost nothing. */
  rates(model: string | null | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; estimated: boolean } {
    if (normalizeModel(model) === "<synthetic>") return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, estimated: false };
    const { price, estimated } = this.lookup(model);
    return {
      input: price.input,
      output: price.output,
      cacheRead: price.cacheRead ?? price.input * 0.1,
      cacheWrite: price.cacheWrite5m ?? price.input * 1.25,
      cacheWrite1h: price.cacheWrite1h ?? price.input * 2,
      estimated,
    };
  }

  cost(model: string | null | undefined, t: TokenCounts, speed?: string | null): { usd: number; estimated: boolean } {
    const r = this.rates(model);
    let usd = (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + t.cacheWrite * r.cacheWrite + t.cacheWrite1h * r.cacheWrite1h) / 1_000_000;
    if (speed === "fast") usd *= 2; // Claude fast mode is billed at 2x standard rates
    return { usd, estimated: r.estimated };
  }
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}
