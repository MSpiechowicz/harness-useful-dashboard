import { modelMaker } from "../../../src/core/models.ts";
import { getJson } from "./api.svelte.ts";
import { FAMILIES, MAKER_FAMILIES, OTHER, PROVIDERS, RESERVED, TOKEN_TYPES, generalPool, modelShade, type Mode, type Provider } from "./palette.ts";
import { store } from "./state.svelte.ts";

/**
 * Color follows the entity, never its rank in the current view: each dimension value gets a fixed place
 * from its all-time ranking, so filtering never repaints the surviving series.
 *
 * Colors come from the design palette (palette.ts). Providers, their models (shades of the provider's color)
 * and the token types wear their reserved families, which nothing else can use. Every other dimension takes the general pool in
 * order - a different hue for each of the top values, then the variants - and past its end folds into "Other".
 * Single-measure marks use the neutral --data ink, not a hue.
 */

const NONE = "(none)";

/** Values that always take the first color of their dimension, ahead of the ranking. */
const FIRST: Record<string, string> = { agent: "main", source: "builtin" };

let ranking = $state<Record<string, string[]>>({});

/**
 * Colors go to what is in use now: values ranked by the last 30 days' cost come first, then everything
 * else in all-time order. Loaded once (and after scans), independent of the selected range, so changing
 * filters never repaints anything.
 */
export async function loadColorRanking(): Promise<void> {
  try {
    const from = Date.now() - 30 * 86_400_000;
    type Options = Record<string, { value: string }[]>;
    const [recent, all] = await Promise.all([getJson<Options>(`/api/filters?from=${from}`), getJson<Options>("/api/filters")]);
    const r: Record<string, string[]> = {};
    for (const dim of ["project", "user", "model", "skill", "agent"]) {
      r[dim] = [...new Set([...(recent[dim] ?? []), ...(all[dim] ?? [])].map((o) => o.value))];
    }
    ranking = r;
  } catch {
    /* colors fall back to hashing */
  }
}

/** Ranks a dimension that /api/filters doesn't cover (e.g. MCP servers), so its values get distinct colors in order. */
export function rankKeys(dim: string, keys: string[]): void {
  if (ranking[dim]?.join("\n") !== keys.join("\n")) ranking = { ...ranking, [dim]: keys };
}

function hashIndex(key: string, n: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % n;
}

/** The provider whose shades a model wears (see MAKER_FAMILIES); models of other makers take the general pool. */
export function modelFamily(model: string): Provider | null {
  const maker = modelMaker(model);
  return maker ? MAKER_FAMILIES[maker] : null;
}

const mode = (): Mode => (store.dark ? "dark" : "light");

/** A value's place in the general pool: its dimension's fixed first value, then the ranking; unranked values hash. */
function poolColor(dim: string, key: string): string | null {
  const pool = generalPool(mode());
  const first = FIRST[dim];
  if (key === first) return pool[0]!;
  const offset = first ? 1 : 0;
  const list = ranking[dim]?.filter((k) => k !== first && k !== NONE && (dim !== "model" || !modelFamily(k)));
  const idx = list?.indexOf(key) ?? -1;
  const at = offset + (idx >= 0 ? idx : hashIndex(key, pool.length - offset));
  return pool[at] ?? null;
}

/** The color of a dimension value, or null when it belongs to "Other". */
function paint(dim: string, key: string): string | null {
  if (key === "__other__" || key === "other") return null;
  // "(none)" (no project, no skill, …) is an absence rather than an entity: the neutral data ink, never a hue.
  if (key === NONE) return cssVar("--data");
  const m = mode();
  if (dim === "provider" && PROVIDERS.includes(key as Provider)) return FAMILIES[RESERVED[key as Provider]][m][0];
  if (dim === "type") {
    const i = TOKEN_TYPES.indexOf(key as (typeof TOKEN_TYPES)[number]);
    return i >= 0 ? FAMILIES[RESERVED.tokenType][m][i]! : null;
  }
  // A maker's models take its provider's shades, ranked within the maker: the top model wears the provider's
  // own color. There is a shade for every model; values not ranked yet go after the ranked ones.
  const maker = dim === "model" ? modelFamily(key) : null;
  if (maker) {
    const peers = ranking.model?.filter((k) => modelFamily(k) === maker) ?? [];
    const idx = peers.indexOf(key);
    return modelShade(maker, m, idx >= 0 ? idx : peers.length + hashIndex(key, 4));
  }
  return poolColor(dim, key);
}

/** Whether a value has a color of its own (otherwise it is drawn as, or folded into, "Other"). */
export function isColored(dim: string, key: string): boolean {
  return dim === "none" || paint(dim, key) != null;
}

/** Reads the current value of a CSS custom property (theme aware). */
export function cssVar(name: string): string {
  void store.dark;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function colorFor(dim: string, key: string): string {
  if (dim === "none") return cssVar("--data");
  return paint(dim, key) ?? OTHER[mode()][0]!;
}

export function seqRamp(): string[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => cssVar(`--seq-${i}`));
}
