/**
 * Model ids as harnesses report them vary for the same model: router prefixes ("github-copilot/…",
 * "openrouter/anthropic/…"), cloud prefixes, snapshot dates, and Claude versions written with dots by some
 * routers ("claude-opus-5.5") but dashes by Anthropic ("claude-opus-5-5"). Pricing and the web app's maker
 * colors both read them through here, so they always agree. No Node or DOM APIs: the web app imports it too.
 */

/** Normalizes a model id for pricing and maker detection. */
export function normalizeModel(model: string | null | undefined): string {
  if (!model) return "unknown";
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, ""); // "claude-opus-4-6[1m]"
  m = m.replace(/^(us|eu|apac|global)\.(?=anthropic\.)/, "");
  m = m.replace(/^anthropic\./, "");
  m = m.slice(m.lastIndexOf("/") + 1); // router and vendor prefixes: "github-copilot/", "openrouter/anthropic/", "models/"
  m = m.replace(/@\d{8}$/, "").replace(/-v\d+:\d+$/, ""); // Bedrock's "-v1:0"
  if (m.startsWith("claude")) m = m.replace(/-v\d+$/, ""); // "claude-3-5-sonnet-v2", but "deepseek-v3" keeps its version
  m = m.replace(/-(\d{8})$/, ""); // date-suffixed snapshot ids
  if (m.startsWith("claude-")) m = m.replaceAll(".", "-"); // "claude-opus-5.5" → "claude-opus-5-5"
  return m || "unknown";
}

/**
 * A model id without its snapshot date ("claude-haiku-4-5-20251001", Vertex's "claude-haiku-4-5@20251001"), as it is
 * stored and shown: the date tells two releases of one model apart, never two models, and harnesses that report the
 * plain alias would otherwise split one model in two. Everything else stays as the harness wrote it.
 */
export function withoutSnapshotDate<T extends string | null | undefined>(model: T): T {
  return (typeof model === "string" ? model.replace(/[-@]\d{8}$/, "") : model) as T;
}

export type Maker = "anthropic" | "openai";

const MAKERS: [RegExp, Maker][] = [
  [/^claude/, "anthropic"],
  [/^(gpt|o\d|codex|chatgpt)/, "openai"],
];

/** Who made a model, whichever harness or plan it ran under; null for makers without a color of their own. */
export function modelMaker(model: string | null | undefined): Maker | null {
  const m = normalizeModel(model);
  return MAKERS.find(([re]) => re.test(m))?.[1] ?? null;
}
