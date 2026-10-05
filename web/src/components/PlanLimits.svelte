<script lang="ts" module>
  export interface LimitWindow {
    id: string;
    windowMs: number | null;
    scope: string | null;
    label: string | null;
    usedFraction: number;
    resetsAt: number | null;
    used?: number;
    limit?: number;
    unit?: string;
    reset?: boolean;
  }
  export interface LimitReport {
    key: string;
    provider: string;
    plan: string | null;
    account: string | null;
    source: Source;
    observedAt: number;
    windows: LimitWindow[];
  }
  type Source = "claude" | "omp" | "codex" | "pi" | "opencode";
  export interface LimitsResult {
    reports: LimitReport[];
    problems: { source: Source; code: string; retryAt?: number }[];
    fetchedAt: number;
    /** The plans the sessions in the window ran on, when the limits were asked for a window. */
    active: { provider: string; source: Source }[] | null;
  }
</script>

<script lang="ts">
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, relative, until } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";

  let { data, now }: { data: LimitsResult; now: number } = $props();

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "GitHub Copilot", "google-gemini-cli": "Gemini", xai: "xAI", deepseek: "DeepSeek" };
  const PLANS: Record<string, string> = { prolite: "Pro Lite", max: "Max", pro: "Pro", plus: "Plus", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
  const planName = (p: string) => PLANS[p.toLowerCase()] ?? p.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  function windowName(w: LimitWindow): string {
    const ms = w.windowMs;
    const base =
      w.id === "premium" ? t("live.window.premium")
      : ms === 5 * HOUR ? t("live.window.5h")
      : ms === 7 * DAY ? t("live.window.week")
      : ms === DAY ? t("live.window.day")
      : ms && ms % DAY === 0 ? t("live.window.days", { n: ms / DAY })
      : ms && ms % HOUR === 0 ? t("live.window.hours", { n: ms / HOUR })
      : (w.label ?? w.id);
    return w.scope ? `${base} · ${w.scope}` : base;
  }

  // The bar is what's left, like a battery, in the provider's color. Only when little is left does it turn to a
  // warning color, and the number with it.
  const left = (w: LimitWindow) => Math.max(0, Math.min(1, 1 - w.usedFraction));
  const fill = (l: number, provider: string) => (l >= 0.25 ? colorFor("provider", provider) : l >= 0.1 ? "var(--status-serious)" : "var(--status-critical)");
  const ink = (l: number) => (l >= 0.25 ? "text-ink" : l >= 0.1 ? "text-warn" : "text-bad");

  // A reading is only dated when it's old (Codex logs it only while in use): a fresh one needs no note.
  const STALE_MS = 5 * 60_000;
  const PROBLEM_SOURCES = { claude: "Claude Code", omp: "omp", codex: "Codex", pi: "pi", opencode: "OpenCode" };
</script>

{#snippet reset(w: LimitWindow)}
  {#if w.reset}{t("live.resetSince")}{:else if w.resetsAt}<span title={new Date(w.resetsAt).toLocaleString()}>{t("live.resetsIn", { time: until(w.resetsAt, now) })}</span>{:else}{t("live.noReset")}{/if}
{/snippet}

<div class="flex flex-col gap-5">
  {#each data.reports as r (r.key)}
    <section class="flex flex-col gap-3">
      <header class="flex items-center gap-2.5">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" style:background={colorFor("provider", r.provider)}></span>
        <span class="text-[13px] font-semibold text-ink">{NAMES[r.provider] ?? r.provider}</span>
        {#if r.plan}<span class="rounded-full border border-line px-2 py-px text-[11px] text-ink-2">{planName(r.plan)}</span>{/if}
        {#if r.account}<span class="truncate font-mono text-[11px] text-muted">{r.account}</span>{/if}
        {#if now - r.observedAt > STALE_MS}<span class="ml-auto shrink-0 text-[11px] text-muted">{t("live.asOf", { ago: relative(r.observedAt) })}</span>{/if}
      </header>
      {#each r.windows as w (w.id)}
        {@const l = left(w)}
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between gap-3 text-xs">
            <span class="truncate text-ink-2">{windowName(w)}</span>
            <span class="shrink-0 tabular">
              <span class="font-semibold {ink(l)}">{t("live.left", { pct: Math.round(l * 100) })}</span>
              {#if w.used != null && w.limit != null}<span class="text-muted"> · {t("live.counted", { used: compact(w.used), limit: compact(w.limit) })}</span>{/if}
              <span class="text-muted"> · {@render reset(w)}</span>
            </span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-surface-3">
            <div class="h-full rounded-full transition-[width] duration-500" style:width={l > 0 ? `max(${l * 100}%, 4px)` : "0"} style:background={fill(l, r.provider)}></div>
          </div>
        </div>
      {/each}
    </section>
  {/each}
  {#each data.problems as p (p.source)}
    <p class="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{t(`live.problem.${p.code}` as "live.problem.failed", { source: PROBLEM_SOURCES[p.source], time: p.retryAt ? until(p.retryAt, now) : "" })}</p>
  {/each}
</div>
