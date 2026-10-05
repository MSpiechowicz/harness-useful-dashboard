import { getJson } from "./api.svelte.ts";
import { store } from "./state.svelte.ts";

/**
 * Color follows the entity, never its rank in the current view: each dimension value gets a fixed slot
 * from its all-time ranking, so filtering never repaints the surviving series.
 */
const FIXED: Record<string, Record<string, number>> = {
  type: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  provider: { codex: 1, claude: 2, cursor: 7 },
  agent: { main: 1 },
};

const SLOTS = 8;
let ranking = $state<Record<string, string[]>>({});

export async function loadColorRanking(): Promise<void> {
  try {
    const f = await getJson<Record<string, { value: string }[]>>("/api/filters");
    const r: Record<string, string[]> = {};
    for (const dim of ["project", "user", "model", "skill", "agent"]) r[dim] = (f[dim] ?? []).map((o) => o.value);
    ranking = r;
  } catch {
    /* colors fall back to hashing */
  }
}

function hashSlot(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % SLOTS) + 1;
}

export function slotFor(dim: string, key: string): number | null {
  if (key === "__other__" || key === "other") return null;
  const fixed = FIXED[dim]?.[key];
  if (fixed) return fixed;
  const list = ranking[dim];
  if (list) {
    // Skip slots already reserved by fixed assignments in this dimension.
    const reserved = new Set(Object.values(FIXED[dim] ?? {}));
    const free = Array.from({ length: SLOTS }, (_, i) => i + 1).filter((s) => !reserved.has(s));
    const idx = list.filter((k) => !(FIXED[dim] && k in FIXED[dim]!)).indexOf(key);
    if (idx >= 0 && idx < free.length) return free[idx]!;
    if (idx >= free.length) return null;
  }
  return hashSlot(key);
}

/** Reads the current value of a CSS custom property (theme aware). */
export function cssVar(name: string): string {
  void store.dark;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function colorFor(dim: string, key: string): string {
  if (dim === "none") return cssVar("--accent");
  const slot = slotFor(dim, key);
  return cssVar(slot ? `--series-${slot}` : "--series-other");
}

export function seqRamp(): string[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => cssVar(`--seq-${i}`));
}
