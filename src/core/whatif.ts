import type { Database } from "bun:sqlite";
import { memo } from "./cache.ts";
import { normalizeModel, type PriceBook, type TokenCounts } from "./pricing.ts";
import { type Filters, whereClause } from "./queries.ts";

/**
 * What a range would have cost on another model: every token re-priced at the candidate's rates, the same counts as
 * they are (tokenizers differ between vendors, the UI says so). Claude's fast mode doubles a price only on the model
 * that ran in it: another model has no fast mode to bill.
 */
export interface WhatIf {
  candidate: string;
  candidates: { inUse: string[]; priced: string[] };
  actual: number;
  whatIf: number;
  /** whatIf / actual − 1, null when nothing was spent. */
  change: number | null;
  /** The candidate has no list price of its own. */
  estimated: boolean;
  /** Some of the actual cost was reported by the provider, not priced here: the candidate's own model can differ. */
  reported: boolean;
  rows: { model: string; tokens: number; actual: number; whatIf: number }[];
}

interface Group extends TokenCounts {
  model: string | null;
  fast: number;
  cost: number;
  reported: number;
}

/** Messages a harness made up, not a model's: never a candidate and never in the table. */
const SYNTHETIC = "<synthetic>";

/** Costs the provider reported: recomputeCosts (writer.ts) leaves exactly these rows as they are. */
const REPORTED = "(u.provider IN ('cursor', 'cline', 'roo', 'kilo') AND u.cost_estimated = 0)";

function groups(db: Database, f: Filters): Group[] {
  return memo(db, `whatif:${JSON.stringify(f)}`, () => {
    const w = whereClause(f);
    return db
      .query<Group, Record<string, string | number | null>>(
        `SELECT u.model, (u.speed IS 'fast') AS fast,
                COALESCE(SUM(u.input_tokens), 0) AS input, COALESCE(SUM(u.output_tokens), 0) AS output,
                COALESCE(SUM(u.cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(u.cache_write_tokens), 0) AS cacheWrite,
                COALESCE(SUM(u.cache_write_1h_tokens), 0) AS cacheWrite1h, COALESCE(SUM(u.cost_usd), 0) AS cost,
                MAX(${REPORTED}) AS reported
         FROM usage u ${w.sql} GROUP BY u.model, fast`,
      )
      .all(w.params)
      .filter((g) => normalizeModel(g.model) !== SYNTHETIC);
  });
}

const pricedNames = new WeakMap<PriceBook, string[]>();

/** Every model the price book has a price for, by the name its pattern gives: "claude-opus-5*" is "claude-opus-5". */
export function pricedModels(prices: PriceBook): string[] {
  const known = pricedNames.get(prices);
  if (known) return known;

  const names = new Set<string>();
  for (const rule of prices.allRules()) {
    const name = rule.pattern.replace(/\*+$/, "").replace(/[-.]+$/, "");
    if (name) names.add(name);
  }

  const sorted = [...names].sort();
  pricedNames.set(prices, sorted);
  return sorted;
}

/** The models in use in a range's groups, the costliest first, as the price book names them. */
function modelsInUse(rows: Group[]): string[] {
  const spent = new Map<string, number>();
  for (const g of rows) {
    const name = normalizeModel(g.model);
    if (name !== "unknown") spent.set(name, (spent.get(name) ?? 0) + g.cost);
  }
  return [...spent].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/**
 * Whether `candidate` is one the what-if offers for the range: a model in use there or one with a price. The server
 * takes no other, so a request can't fill the price book's cache with made-up names.
 */
export function isCandidate(db: Database, prices: PriceBook, f: Filters, candidate: string): boolean {
  return pricedModels(prices).includes(candidate) || modelsInUse(groups(db, f)).includes(candidate);
}

/** The range re-priced at `candidate`'s rates, by model. Without a candidate, the model that cost the most. */
export function whatIf(db: Database, prices: PriceBook, f: Filters, candidate: string | null): WhatIf {
  const rows = groups(db, f);
  const inUse = modelsInUse(rows);
  const priced = pricedModels(prices);

  const chosen = candidate || inUse[0] || priced[0] || "";
  const target = normalizeModel(chosen);

  const byModel = new Map<string, { model: string; tokens: number; actual: number; whatIf: number }>();
  let reported = false;
  for (const g of rows) {
    const sameModel = normalizeModel(g.model) === target;
    const repriced = prices.cost(chosen, g, g.fast && sameModel ? "fast" : null).usd;

    const key = g.model ?? "(none)";
    const row = byModel.get(key) ?? { model: key, tokens: 0, actual: 0, whatIf: 0 };
    row.tokens += g.input + g.output + g.cacheRead + g.cacheWrite + g.cacheWrite1h;
    row.actual += g.cost;
    row.whatIf += repriced;
    byModel.set(key, row);

    if (g.reported) reported = true;
  }

  const table = [...byModel.values()].sort((a, b) => b.actual - a.actual || a.model.localeCompare(b.model));
  const actual = table.reduce((sum, r) => sum + r.actual, 0);
  const total = table.reduce((sum, r) => sum + r.whatIf, 0);

  return {
    candidate: chosen,
    candidates: { inUse, priced },
    actual,
    whatIf: total,
    change: actual ? total / actual - 1 : null,
    estimated: chosen ? prices.lookup(chosen).estimated : false,
    reported,
    rows: table,
  };
}
