/**
 * The design palette: every data color the app paints with, grouped in hue families.
 *
 * Colors are OKLCH steps inside sRGB (chroma up to 0.17); light and dark are stepped separately, not flipped.
 * A main color sits at L 0.64 (light) / 0.71 (dark).
 *
 * Some families carry a fixed meaning and are reserved for it: each provider has one color, from which the
 * shades of its models are generated (modelShade), and the token types have four shades of their own.
 * Everything else - projects, users, skills, agents, sources, models of other makers - takes colors from the
 * general pool: first the main color of
 * every general family, so the top values are told apart by hue, then each family's variant (deep on light,
 * pale on dark: L 0.44 / 0.83), then "Other". tests/palette.test.ts checks the whole palette: no color is
 * used twice, no general color can pass for a reserved one, and colors shown together stay apart.
 */

import type { Maker } from "../../../src/core/models.ts";
import { contrast, deltaE, oklch, oklchToHex, visionLabs, worstDeltaE } from "./colorMath.ts";

export type Mode = "light" | "dark";

export interface Family {
  light: readonly string[];
  dark: readonly string[];
}

export const FAMILIES = {
  orange: { light: ["#de602c"], dark: ["#f77745"] },
  blue: { light: ["#3c8cf0"], dark: ["#5da3ff"] },
  gold: { light: ["#9e8d00"], dark: ["#b6a300"] },
  // Deeper than the general pool's violet and pink it sits between (L 0.54 / 0.56).
  plum: { light: ["#9e3db0"], dark: ["#ab40ad"] },
  // The last two hues with room left between the pool, the token types and the other providers' model shades:
  // a deep teal below sky and cache read, and a crimson past Claude's orange and the pool's pink.
  teal: { light: ["#007973"], dark: ["#159085"] },
  crimson: { light: ["#bd004b"], dark: ["#e60357"] },
  // With the middle lightness band full, the editors' harnesses sit at its edges and in the gaps left: a deep
  // indigo, a green that is vivid on light and pale on dark, a bright magenta and a deep amber, all clear of every
  // color above and of each other.
  indigo: { light: ["#3f00c3"], dark: ["#4923d6"] },
  lime: { light: ["#1cd135"], dark: ["#bde9bb"] },
  magenta: { light: ["#f648ca"], dark: ["#ff56d2"] },
  amber: { light: ["#532e01"], dark: ["#6f4005"] },
  // The CLIs that came last found room only where the lightness changes between themes, as lime's does: a bright
  // cyan on light that turns slate blue on dark (no cyan is left on dark), and a wine that stays one hue.
  cyan: { light: ["#2ac4cc"], dark: ["#464979"] },
  wine: { light: ["#5e014a"], dark: ["#9c0451"] },
  // Token types in TOKEN_TYPES order: cache read in teal (the big part of every column), cache write olive,
  // input lilac, output purple. Each keeps its hue in both themes; the four are as far apart as the rest of the
  // palette allows, for normal vision and red-green deficiencies alike, so even thin slivers read apart.
  tokens: { light: ["#00a57b", "#606300", "#c086f1", "#5c3c77"], dark: ["#00be8e", "#6e7200", "#cf98ff", "#a07ebe"] },
  green: { light: ["#47a438", "#136400"], dark: ["#5ebb4f", "#85e276"] },
  sky: { light: ["#009cbc", "#005c70"], dark: ["#00b4d7", "#51dbff"] },
  violet: { light: ["#8279ee", "#4c3bab"], dark: ["#9791ff", "#c0c0ff"] },
  pink: { light: ["#d65895", "#92125a"], dark: ["#ef6fab", "#ffaacd"] },
} as const satisfies Record<string, Family>;

export type FamilyName = keyof typeof FAMILIES;

/** Families with a fixed meaning, each owned by exactly one thing. */
export const RESERVED = {
  claude: "orange",
  codex: "blue",
  cursor: "gold",
  omp: "plum",
  pi: "teal",
  opencode: "crimson",
  zed: "indigo",
  cline: "lime",
  roo: "magenta",
  kilo: "amber",
  gemini: "cyan",
  copilot: "wine",
  tokenType: "tokens",
} as const satisfies Record<string, FamilyName>;

export type Provider = "claude" | "codex" | "cursor" | "omp" | "pi" | "opencode" | "zed" | "cline" | "roo" | "kilo" | "gemini" | "copilot";
export const PROVIDERS: readonly Provider[] = ["claude", "codex", "cursor", "omp", "pi", "opencode", "zed", "cline", "roo", "kilo", "gemini", "copilot"];
/** How each provider (harness) is named in the UI. */
export const PROVIDER_NAMES: Record<Provider, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", omp: "omp", pi: "pi", opencode: "OpenCode", zed: "Zed", cline: "Cline", roo: "Roo Code", kilo: "Kilo Code", gemini: "Gemini CLI", copilot: "Copilot CLI" };

/**
 * Models wear their maker's color - the family of the provider that makes them - whichever harness or plan
 * they ran under: a Claude model through omp or Copilot is still Claude. Only these providers hand out model
 * shades. Harnesses without models of their own (Cursor, omp, pi, OpenCode, Zed, Cline, Roo Code,
 * Kilo Code, Copilot CLI) have just their one color. Gemini CLI has one too: no shades of it are left clear of the
 * rest, so Gemini models take the general pool's colors like other makers'.
 */
export const MAKER_FAMILIES: Record<Maker, Provider> = { anthropic: "claude", openai: "codex" };
/** In the order their model shades are generated: a maker added at the end never repaints the ones before it. */
export const MODEL_PROVIDERS: readonly Provider[] = Object.values(MAKER_FAMILIES);

/**
 * Where a provider's model shades come from: around the provider's color, in a lightness range that stays
 * readable on the surface (on dark it stops short of the pale end, which belongs to the general pool's
 * variants), with chroma down to 60% of the provider's and hue within ±8°.
 */
const SHADE_SPACE: Record<Mode, { l: readonly [number, number]; chroma: readonly [number, number]; hue: number }> = {
  light: { l: [0.4, 0.78], chroma: [0.6, 1], hue: 8 },
  dark: { l: [0.47, 0.8], chroma: [0.6, 1], hue: 8 },
};
/** A model shade keeps this ΔE from every general, token-type and other provider's color, and from "Other". */
const SHADE_MARGIN = 7;
const SHADE_FROM_OTHER = 9;
/** How many shades of an earlier provider are off limits to the providers after it. */
const SHADE_GUARD = 12;

interface ShadeSequence {
  picks: string[];
  rest: { hex: string; labs: ReturnType<typeof visionLabs>; dist: number }[];
}
const sequences = new Map<string, ShadeSequence>();

function shadeSequence(provider: Provider, mode: Mode): ShadeSequence {
  const key = `${provider}:${mode}`;
  const known = sequences.get(key);
  if (known) return known;
  const base = FAMILIES[RESERVED[provider]][mode][0];
  const { l, c, h } = oklch(base);
  const space = SHADE_SPACE[mode];
  // Everything a model shade must not be mistaken for. Earlier providers' shades count, so adding a provider
  // never repaints the ones before it.
  const taken = [
    ...GENERAL.flatMap((f) => FAMILIES[f][mode]),
    ...FAMILIES[RESERVED.tokenType][mode],
    ...PROVIDERS.filter((p) => p !== provider).map((p) => FAMILIES[RESERVED[p]][mode][0]),
    ...MODEL_PROVIDERS.slice(0, MODEL_PROVIDERS.indexOf(provider)).flatMap((p) => modelShades(p, mode, SHADE_GUARD)),
  ];
  const baseLabs = visionLabs(base);
  const rest: ShadeSequence["rest"] = [];
  for (let L = space.l[0]; L <= space.l[1] + 1e-9; L += 0.02)
    for (const cf of [space.chroma[0], (space.chroma[0] + space.chroma[1]) / 2, space.chroma[1]])
      for (const dh of [-space.hue, -space.hue / 2, 0, space.hue / 2, space.hue]) {
        const hex = oklchToHex(L, c * cf, h + dh);
        if (contrast(hex, SURFACE[mode]) < 2 || oklch(hex).c < 0.075 || deltaE(hex, OTHER[mode][0]!) < SHADE_FROM_OTHER) continue;
        if (hex === base || rest.some((r) => r.hex === hex) || taken.some((t) => deltaE(hex, t) < SHADE_MARGIN)) continue;
        const labs = visionLabs(hex);
        rest.push({ hex, labs, dist: worstDeltaE(labs, baseLabs) });
      }
  const seq = { picks: [base], rest };
  sequences.set(key, seq);
  return seq;
}

/**
 * The n-th model shade of a provider; shade 0 is the provider's own color. Each next shade is the candidate
 * most different from all shades before it - for normal vision and both red-green deficiencies alike - so the
 * first models are far apart and later ones fill in between. It never runs out: past the last candidate
 * (hundreds in) the shades repeat.
 */
export function modelShade(provider: Provider, mode: Mode, n: number): string {
  const seq = shadeSequence(provider, mode);
  while (seq.picks.length <= n && seq.rest.length) {
    let best = 0;
    for (let i = 1; i < seq.rest.length; i++) if (seq.rest[i]!.dist > seq.rest[best]!.dist) best = i;
    const [pick] = seq.rest.splice(best, 1);
    seq.picks.push(pick!.hex);
    for (const r of seq.rest) r.dist = Math.min(r.dist, worstDeltaE(r.labs, pick!.labs));
  }
  return seq.picks[n % seq.picks.length]!;
}

/** A provider's first `count` model shades. */
export function modelShades(provider: Provider, mode: Mode, count: number): string[] {
  return Array.from({ length: count }, (_, n) => modelShade(provider, mode, n));
}

/** The general pool's families, in the order their colors are handed out. Each has a main color and a variant. */
export const GENERAL: readonly FamilyName[] = ["green", "sky", "violet", "pink"];

/** Token types, in the order they take their family's shades (and stack, bottom-up). */
export const TOKEN_TYPES = ["cacheRead", "cacheWrite", "input", "output"] as const;

/** "Other" and anything past the pool: a neutral gray outside every family. */
export const OTHER: Family = { light: ["#b5b3ab"], dark: ["#5f5e59"] };

/** Chart surfaces the palette is checked against (the --surface token in app.css). */
export const SURFACE: Record<Mode, string> = { light: "#fcfcfb", dark: "#1a1a19" };

/** The general pool in hand-out order: every family's main color, then every family's variant. */
export function generalPool(mode: Mode): string[] {
  return [0, 1].flatMap((shade) => GENERAL.map((f) => FAMILIES[f][mode][shade]!));
}
