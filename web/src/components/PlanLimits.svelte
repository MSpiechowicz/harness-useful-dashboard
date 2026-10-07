<script lang="ts" module>
  import { i18n, t } from "../lib/i18n.svelte.ts";
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
  type Source = "claude" | "omp" | "codex" | "pi" | "opencode" | "copilot";
  export interface LimitsResult {
    reports: LimitReport[];
    problems: { source: Source; code: string; retryAt?: number }[];
    fetchedAt: number;
    /** The plans the sessions in the window ran on, when the limits were asked for a window. */
    active: { provider: string; source: Source }[] | null;
  }

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  export const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "GitHub Copilot", "google-gemini-cli": "Gemini", xai: "xAI", deepseek: "DeepSeek" };
  const PLANS: Record<string, string> = { prolite: "Pro Lite", max: "Max", pro: "Pro", plus: "Plus", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
  export const planName = (p: string) => PLANS[p.toLowerCase()] ?? p.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  export function windowName(w: LimitWindow): string {
    // Older Codex builds log their windows a minute short (299 and 10079 minutes): a length within a few minutes of
    // a whole hour is that hour.
    const hours = w.windowMs != null ? Math.round(w.windowMs / HOUR) : 0;
    const ms = hours && Math.abs(w.windowMs! - hours * HOUR) <= 5 * 60_000 ? hours * HOUR : w.windowMs;
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
</script>

<script lang="ts">
  import { Check, TrendingDown } from "@lucide/svelte";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, relative, until } from "../lib/format.ts";

  let { data, now }: { data: LimitsResult; now: number } = $props();

  // The bar is what's left, like a battery, in the provider's color. Only when little is left does it turn to a
  // warning color, and the number with it.
  const left = (w: LimitWindow) => Math.max(0, Math.min(1, 1 - w.usedFraction));
  const fill = (l: number, provider: string) => (l >= 0.25 ? colorFor("provider", provider) : l >= 0.1 ? "var(--status-serious)" : "var(--status-critical)");
  const ink = (l: number) => (l >= 0.25 ? "text-ink" : l >= 0.1 ? "text-warn" : "text-bad");

  // Where the window stands in time, and where its use is heading: the use so far, kept up, against the time left.
  // Too early in a window, or with next to nothing used, the projection would be noise: then only the time mark.
  function pace(w: LimitWindow): { timeLeft: number; outAt: number | null } | null {
    if (w.reset || w.windowMs == null || w.resetsAt == null || w.resetsAt <= now) return null;
    const timeLeft = Math.min(1, (w.resetsAt - now) / w.windowMs);
    const elapsed = w.windowMs - (w.resetsAt - now);
    if (elapsed < w.windowMs * 0.05 || w.usedFraction < 0.02) return { timeLeft, outAt: null };
    return { timeLeft, outAt: now + ((1 - w.usedFraction) * elapsed) / w.usedFraction };
  }
  const clock = (ts: number) =>
    new Intl.DateTimeFormat(i18n.locale, ts - now > 20 * HOUR ? { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

  // A reading is only dated when it's old (Codex logs it only while in use): a fresh one needs no note.
  const STALE_MS = 5 * 60_000;
  const PROBLEM_SOURCES = { claude: "Claude Code", omp: "omp", codex: "Codex", pi: "pi", opencode: "OpenCode", copilot: "Copilot CLI" };
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
        {@const p = pace(w)}
        {@const short = p != null && l < p.timeLeft}
        <div class="flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between gap-3 text-xs">
            <span class="truncate text-ink-2">{windowName(w)}</span>
            <span class="shrink-0 tabular">
              <span class="font-semibold {ink(l)}">{t("live.left", { pct: Math.round(l * 100) })}</span>
              {#if w.used != null && w.limit != null}<span class="text-muted"> · {t("live.counted", { used: compact(w.used), limit: compact(w.limit) })}</span>{/if}
              <span class="text-muted"> · {@render reset(w)}</span>
            </span>
          </div>
          <!-- What's left ending short of the time left means the limit runs out before the window does: the gap between
               them is hatched, and the tick and the note share the warning colour. -->
          <div class="relative">
            <div class="relative h-2 overflow-hidden rounded-full bg-surface-3">
              <div class="h-full rounded-full transition-[width] duration-500" style:width={l > 0 ? `max(${l * 100}%, 4px)` : "0"} style:background={fill(l, r.provider)}></div>
              {#if p && short}
                <span class="pace-gap absolute inset-y-0" style:left="{l * 100}%" style:width="{(p.timeLeft - l) * 100}%"></span>
              {/if}
            </div>
            <!-- The time left in the window as a tick with a small ripple. -->
            {#if p}
              <span class="absolute top-1/2 h-0 w-0" style:left="{p.timeLeft * 100}%" style:color={short ? "var(--warn-ink)" : "var(--ink)"} title={t("live.pace.marker")}>
                <span class="pace-mark absolute h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"></span>
              </span>
            {/if}
          </div>
          {#if p?.outAt != null}
            {@const out = p.outAt < (w.resetsAt ?? 0)}
            <div class="flex items-center gap-1.5 text-[11px] {out ? 'text-warn' : 'text-muted'}">
              {#if out}<TrendingDown class="size-3.5 shrink-0" aria-hidden="true" />{:else}<Check class="size-3.5 shrink-0" aria-hidden="true" />{/if}
              <span>{out ? t("live.pace.out", { time: clock(p.outAt) }) : t("live.pace.lasts")}</span>
            </div>
          {/if}
        </div>
      {/each}
    </section>
  {/each}
  {#each data.problems as p (p.source)}
    <p class="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{t(`live.problem.${p.code}` as "live.problem.failed", { source: PROBLEM_SOURCES[p.source], time: p.retryAt ? until(p.retryAt, now) : "" })}</p>
  {/each}
</div>
