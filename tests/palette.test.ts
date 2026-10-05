import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrast, cvdDeltaE, deltaE, isHex, oklch } from "../web/src/lib/colorMath.ts";
import { FAMILIES, GENERAL, MODEL_PROVIDERS, OTHER, PROVIDERS, RESERVED, SURFACE, TOKEN_TYPES, generalPool, modelShade, modelShades, type FamilyName, type Mode } from "../web/src/lib/palette.ts";

// ΔE is OKLab distance ×100; CVD is the worse of protanopia and deuteranopia (see colorMath.ts).
/** A general color next to any reserved one: never mistaken for it. */
const MIN_FROM_RESERVED = 7;
/** The general pool's main colors go to the top values of a view and sit side by side, so they differ by hue. */
const MIN_MAINS_APART = 15;
const MIN_MAINS_APART_CVD = 6;
/** Any two colors of the general pool, variants included. */
const MIN_POOL_APART = 10;
/** Provider colors are often shown together (provider split, models). */
const MIN_PROVIDERS_APART = 15;
const MIN_PROVIDER_FROM_TOKEN_TYPE = 12;
/** Model shades of different providers share the model charts. */
const MIN_MODELS_APART = 9;
/**
 * A provider's model shades never run out, so they can't all be far apart; the checks are graded. The second
 * model is far from the first, the first three and the first six stay apart (also with colour blindness), and
 * the first CHECKED_MODELS go through every other check.
 */
const CHECKED_MODELS = 12;
const MIN_SECOND_MODEL = 20;
const MIN_FIRST_THREE_MODELS = 12;
const MIN_FIRST_SIX_MODELS = 6;
/** Token types sit next to each other in every stack, the small ones as thin slivers. */
const MIN_TOKENS_APART = 11;
/** Every color against the chart surface; legends, tooltips and the table view carry the exact values. */
const MIN_CONTRAST = 2;
/** Below this chroma a color reads as gray, i.e. as "Other". Deep cyan tops out near 0.077 inside sRGB. */
const MIN_CHROMA = 0.075;
const MIN_FROM_OTHER = 9;

const MODES: Mode[] = ["light", "dark"];
const NAMES = Object.keys(FAMILIES) as FamilyName[];
const RESERVED_FAMILIES: FamilyName[] = Object.values(RESERVED);
const PROVIDER_FAMILIES: FamilyName[] = PROVIDERS.map((p) => RESERVED[p]);
/** Families that hand out model shades (makers); other providers have one color. */
const MODEL_FAMILIES: FamilyName[] = MODEL_PROVIDERS.map((p) => RESERVED[p]);
const ROOT = join(import.meta.dir, "..");

type Swatch = { label: string; hex: string };
/** Every color a family hands out: its own shades, or for a provider its first model shades. */
function familyShades(family: FamilyName, mode: Mode): string[] {
  const provider = MODEL_PROVIDERS.find((p) => RESERVED[p] === family);
  return provider ? modelShades(provider, mode, CHECKED_MODELS) : [...FAMILIES[family][mode]];
}
const swatches = (mode: Mode, families: FamilyName[]): Swatch[] =>
  families.flatMap((f) => familyShades(f, mode).map((hex, i) => ({ label: `${f}${i + 1} ${hex}`, hex })));
const mains = (mode: Mode, families: FamilyName[]): Swatch[] => families.map((f) => ({ label: `${f}1 ${FAMILIES[f][mode][0]}`, hex: FAMILIES[f][mode][0]! }));

/** Pairs closer than `min` (ΔE, or CVD ΔE), described for the failure message. */
function tooClose(mode: Mode, a: Swatch[], b: Swatch[] | null, min: number, cvd = false): string[] {
  const out: string[] = [];
  a.forEach((x, i) =>
    (b ?? a.slice(i + 1)).forEach((y) => {
      const d = cvd ? cvdDeltaE(x.hex, y.hex) : deltaE(x.hex, y.hex);
      if (d < min) out.push(`${mode} ${x.label} / ${y.label}: ${cvd ? "CVD " : ""}ΔE ${d.toFixed(1)} < ${min}`);
    }),
  );
  return out;
}

describe("palette structure", () => {
  test("every color is #rrggbb, with as many shades in both themes", () => {
    for (const name of NAMES) {
      expect(FAMILIES[name].light.length).toBe(FAMILIES[name].dark.length);
      for (const mode of MODES) for (const c of FAMILIES[name][mode]) expect(isHex(c)).toBe(true);
    }
  });

  test("a reserved family has exactly one owner", () => {
    expect(new Set(RESERVED_FAMILIES).size).toBe(RESERVED_FAMILIES.length);
  });

  test("the general pool never includes a reserved family", () => {
    expect(GENERAL.filter((f) => RESERVED_FAMILIES.includes(f))).toEqual([]);
    expect(new Set(GENERAL).size).toBe(GENERAL.length);
    for (const mode of MODES) {
      const taken = new Set<string>(RESERVED_FAMILIES.flatMap((f) => FAMILIES[f][mode]));
      expect(generalPool(mode).filter((c) => taken.has(c))).toEqual([]);
    }
  });

  test("every family is either reserved or in the general pool", () => {
    expect(NAMES.filter((f) => !RESERVED_FAMILIES.includes(f) && !GENERAL.includes(f))).toEqual([]);
  });

  test("each family has the shades its role needs", () => {
    for (const f of PROVIDER_FAMILIES) expect(FAMILIES[f].light.length).toBe(1);
    for (const p of MODEL_PROVIDERS) for (const mode of MODES) expect(modelShade(p, mode, 0)).toBe(FAMILIES[RESERVED[p]][mode][0]);
    expect(FAMILIES[RESERVED.tokenType].light.length).toBe(TOKEN_TYPES.length);
    for (const f of GENERAL) expect(FAMILIES[f].light.length).toBe(2);
  });
});

describe("palette colors", () => {
  test("no color is used twice", () => {
    for (const mode of MODES) {
      const all = [...NAMES.flatMap((f) => familyShades(f, mode)), ...OTHER[mode]].map((c) => c.toLowerCase());
      expect(all.filter((c, i) => all.indexOf(c) !== i)).toEqual([]);
    }
  });

  test("no general color can pass for a reserved one", () => {
    expect(MODES.flatMap((m) => tooClose(m, swatches(m, [...GENERAL]), swatches(m, RESERVED_FAMILIES), MIN_FROM_RESERVED))).toEqual([]);
  });

  test("the general pool's colors are told apart when shown together", () => {
    const close = MODES.flatMap((m) => {
      return [
        ...tooClose(m, mains(m, [...GENERAL]), null, MIN_MAINS_APART),
        ...tooClose(m, mains(m, [...GENERAL]), null, MIN_MAINS_APART_CVD, true),
        ...tooClose(m, swatches(m, [...GENERAL]), null, MIN_POOL_APART),
      ];
    });
    expect(close).toEqual([]);
  });

  test("reserved colors are told apart from each other", () => {
    const close = MODES.flatMap((m) => [
      ...tooClose(m, mains(m, PROVIDER_FAMILIES), null, MIN_PROVIDERS_APART),
      ...tooClose(m, mains(m, PROVIDER_FAMILIES), swatches(m, [RESERVED.tokenType]), MIN_PROVIDER_FROM_TOKEN_TYPE),
      ...PROVIDER_FAMILIES.flatMap((f, i) => PROVIDER_FAMILIES.slice(i + 1).flatMap((g) => tooClose(m, swatches(m, [f]), swatches(m, [g]), MIN_MODELS_APART))),
      ...tooClose(m, swatches(m, PROVIDER_FAMILIES), swatches(m, [RESERVED.tokenType]), MIN_FROM_RESERVED),
    ]);
    expect(close).toEqual([]);
  });

  test("token types stay distinguishable, also with colour blindness", () => {
    const close = MODES.flatMap((m) => {
      const tokens = swatches(m, [RESERVED.tokenType]);
      return [...tooClose(m, tokens, null, MIN_TOKENS_APART), ...tooClose(m, tokens, null, MIN_TOKENS_APART, true)];
    });
    expect(close).toEqual([]);
  });

  test("a provider's models are told apart, the first ones most", () => {
    const close = MODES.flatMap((m) =>
      MODEL_FAMILIES.flatMap((f) => {
        const s = swatches(m, [f]);
        return [
          ...tooClose(m, s.slice(0, 2), null, MIN_SECOND_MODEL),
          ...tooClose(m, s.slice(0, 3), null, MIN_FIRST_THREE_MODELS),
          ...tooClose(m, s.slice(0, 6), null, MIN_FIRST_SIX_MODELS),
          ...tooClose(m, s.slice(0, 6), null, MIN_FIRST_SIX_MODELS, true),
          ...tooClose(m, s, null, 0.01),
        ];
      }),
    );
    expect(close).toEqual([]);
  });

  test("a provider's model shades never run out", () => {
    for (const p of MODEL_PROVIDERS) for (const m of MODES) expect(isHex(modelShade(p, m, 500))).toBe(true);
  });

  test("every color stands out from the surface and from Other", () => {
    const weak: string[] = [];
    for (const mode of MODES)
      for (const { label, hex } of swatches(mode, NAMES)) {
        const k = contrast(hex, SURFACE[mode]);
        const chroma = oklch(hex).c;
        const fromOther = deltaE(hex, OTHER[mode][0]!);
        if (k < MIN_CONTRAST) weak.push(`${mode} ${label}: contrast ${k.toFixed(2)} < ${MIN_CONTRAST}`);
        if (chroma < MIN_CHROMA) weak.push(`${mode} ${label}: chroma ${chroma.toFixed(3)} < ${MIN_CHROMA}`);
        if (fromOther < MIN_FROM_OTHER) weak.push(`${mode} ${label}: ΔE from Other ${fromOther.toFixed(1)} < ${MIN_FROM_OTHER}`);
      }
    expect(weak).toEqual([]);
  });
});

describe("palette usage", () => {
  const css = readFileSync(join(ROOT, "web/src/app.css"), "utf8");

  test("the checks run against the real chart surfaces", () => {
    for (const mode of MODES) expect(css).toContain(`--surface: ${SURFACE[mode]};`);
  });

  test("app.css defines no data colors of its own", () => {
    expect(css.match(/--(series|claude|codex|cursor|type)-[\w-]+\s*:/g) ?? []).toEqual([]);
  });

  test("no component hard-codes a palette color", () => {
    const palette = new Set(MODES.flatMap((m) => [...NAMES.flatMap((f) => familyShades(f, m)), ...OTHER[m]]).map((c) => c.toLowerCase()));
    const hits: string[] = [];
    for (const file of new Bun.Glob("web/src/**/*.{ts,svelte,css}").scanSync(ROOT)) {
      if (file.endsWith("lib/palette.ts")) continue;
      for (const hex of readFileSync(join(ROOT, file), "utf8").match(/#[0-9a-fA-F]{6}\b/g) ?? [])
        if (palette.has(hex.toLowerCase())) hits.push(`${file}: ${hex}`);
    }
    expect(hits).toEqual([]);
  });
});
