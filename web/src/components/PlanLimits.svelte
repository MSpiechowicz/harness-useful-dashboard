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
    /** When Refresh next asks a provider; before it the button is off. Older servers send none. */
    refreshAt?: number;
    /** The plans the sessions in the window ran on, when the limits were asked for a window. */
    active: { provider: string; source: Source }[] | null;
    /** What the gauges show: the share used or the share left. Older servers send none, which is used. */
    bars?: "used" | "left";
    /** Whether the gauges draw where each limit is heading by the reset. Older servers send none, which is yes. */
    forecast?: boolean;
  }

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  export const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", copilot: "GitHub Copilot", "google-gemini-cli": "Gemini", xai: "xAI", deepseek: "DeepSeek" };
  const PLANS: Record<string, string> = { prolite: "Pro Lite", max: "Max", pro: "Pro", plus: "Plus", free: "Free", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
  export const planName = (p: string) => PLANS[p.toLowerCase()] ?? p.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  // Older Codex builds log their windows a minute short (299 and 10079 minutes): a length within a few minutes of a whole
  // hour is that hour.
  function windowSpan(w: LimitWindow): number | null {
    const hours = w.windowMs != null ? Math.round(w.windowMs / HOUR) : 0;
    return hours && Math.abs(w.windowMs! - hours * HOUR) <= 5 * 60_000 ? hours * HOUR : w.windowMs;
  }

  export function windowName(w: LimitWindow): string {
    const ms = windowSpan(w);
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

  /** The name for a narrow gauge: the scope alone when there is one ("Fable"), otherwise the length of the window ("Week"). */
  export function shortName(w: LimitWindow): string {
    if (w.scope) return w.scope;

    const ms = windowSpan(w);
    return w.id === "premium" ? t("live.short.premium")
      : ms === 5 * HOUR ? t("live.short.5h")
      : ms === 7 * DAY ? t("live.short.week")
      : ms === DAY ? t("live.short.day")
      : ms && ms % DAY === 0 ? t("live.short.days", { n: ms / DAY })
      : ms && ms % HOUR === 0 ? t("live.short.hours", { n: ms / HOUR })
      : (w.label ?? w.id);
  }
</script>

<script lang="ts">
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, relative, until } from "../lib/format.ts";
  import type { LimitGauge as GaugeStyle } from "../lib/state.svelte.ts";
  import LimitBar from "./LimitBar.svelte";
  import LimitGauge, { type Dial, type GaugeKind } from "./LimitGauge.svelte";
  import Pager from "./Pager.svelte";

  /** `gauge` is how the limits are drawn: the viewer's pick on Live. */
  let { data, now, gauge = "bars" }: { data: LimitsResult; now: number; gauge?: GaugeStyle } = $props();

  // One provider per page. The page is kept by the provider's key, so a refresh stays on it, and one that has gone falls
  // back to the first.
  let current = $state<string | null>(null);
  const index = $derived(Math.max(0, data.reports.findIndex((r) => r.key === current)));
  const shownKey = $derived(data.reports[index]?.key);

  // The gauge shows the share used or the share left, always in the provider's color. Only the red end of the scale says
  // where the limit runs out: the 100% end when counting up, the 0% end when counting down.
  // The bars are laid out apart from the others, which are one gauge to a limit.
  const kind = $derived<GaugeKind>(gauge === "bars" ? "tach" : gauge);
  const mode = $derived(data.bars ?? "used");
  const showForecast = $derived(data.forecast ?? true);
  // With one provider there is no pager under the gauges, and they take the room it would have used.
  const roomy = $derived(data.reports.length <= 1);
  const used = (w: LimitWindow) => Math.max(0, Math.min(1, w.usedFraction));

  // Where the use is heading: the use so far, kept up, over the whole window. Above 1 it runs out before the reset.
  // Too early in a window, or with next to nothing used, the projection would be noise: then none.
  function pace(w: LimitWindow): { projected: number; outAt: number } | null {
    if (w.reset || w.windowMs == null || w.resetsAt == null || w.resetsAt <= now) return null;
    const elapsed = w.windowMs - (w.resetsAt - now);
    if (elapsed < w.windowMs * 0.05 || w.usedFraction < 0.02) return null;
    return { projected: w.usedFraction / (elapsed / w.windowMs), outAt: now + ((1 - w.usedFraction) * elapsed) / w.usedFraction };
  }

  // Used some, but the window has only just begun: the pace says nothing yet.
  function tooEarly(w: LimitWindow): boolean {
    if (w.reset || w.windowMs == null || w.resetsAt == null || w.resetsAt <= now) return false;
    return w.windowMs - (w.resetsAt - now) < w.windowMs * 0.05;
  }

  const clock = (ts: number) =>
    new Intl.DateTimeFormat(i18n.locale, ts - now > 20 * HOUR ? { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

  // The chip under a gauge. None when there is nothing to say: used, but no window to measure the pace against.
  type Chip = { kind: "ok" | "out" | "idle"; text: string };
  function chipOf(w: LimitWindow, p: ReturnType<typeof pace>): Chip | null {
    if (w.usedFraction < 0.02) return { kind: "idle", text: t("live.chip.idle") };
    if (w.usedFraction >= 1) return { kind: "out", text: t("live.chip.reached") };
    if (p) return p.projected > 1 ? { kind: "out", text: t("live.chip.out", { time: clock(p.outAt) }) } : { kind: "ok", text: t("live.chip.ok") };
    if (tooEarly(w)) return { kind: "idle", text: t("live.chip.early") };
    return null;
  }

  // What the gauge draws, as fractions of its scale from the 0% end. The solid arc ends at the needle. With the forecast,
  // used: a pale arc runs on from the needle to where the use will have got by the reset. Left: the solid arc stops where
  // the reset will leave what is left, and the pale arc fills in up to the needle. Both end at the red end when it runs out.
  const MIN_ARC = 0.005;
  function dialOf(w: LimitWindow, p: ReturnType<typeof pace>): Dial {
    const value = mode === "used" ? used(w) : 1 - used(w);
    if (!showForecast || !p) return { value, solid: value, ahead: null };

    if (mode === "used") {
      const to = Math.min(1, p.projected);
      return { value, solid: value, ahead: to - value > MIN_ARC ? { from: value, to } : null };
    }

    const to = Math.max(0, 1 - p.projected);
    return value - to > MIN_ARC ? { value, solid: to, ahead: { from: to, to: value } } : { value, solid: value, ahead: null };
  }

  // The name read out for a limit: what it is, how much, and how it is heading.
  function labelOf(w: LimitWindow, d: Dial, c: Chip | null): string {
    return [windowName(w), t(mode === "used" ? "live.used" : "live.left", { pct: Math.round(d.value * 100) }), c?.text].filter(Boolean).join(", ");
  }

  // A reading is only dated when it's old (Codex logs it only while in use): a fresh one needs no note.
  const STALE_MS = 5 * 60_000;
  const PROBLEM_SOURCES = { claude: "Claude Code", omp: "omp", codex: "Codex", pi: "pi", opencode: "OpenCode", copilot: "Copilot CLI" };
</script>

{#snippet reset(w: LimitWindow)}
  {#if w.reset}{t("live.resetSince")}{:else if w.resetsAt}<span title={new Date(w.resetsAt).toLocaleString()}>{t("live.resetsIn", { time: until(w.resetsAt, now) })}</span>{:else}{t("live.noReset")}{/if}
{/snippet}

{#snippet counted(w: LimitWindow)}{#if w.used != null && w.limit != null}{t("live.counted", { used: compact(w.used), limit: compact(w.limit) })}{" · "}{/if}{@render reset(w)}{/snippet}

{#snippet chip(c: Chip | null)}
  {#if c}<span class="limit-chip {c.kind}" title={c.text}><span class="min-w-0 truncate">{c.text}</span></span>{/if}
{/snippet}

<!-- A limit: its gauge, name, status chip and reset line, in rows of fixed height so a missing chip moves nothing. A lone
     limit sits beside its details, several sit in a column each. -->
{#snippet limit(r: LimitReport, w: LimitWindow, solo: boolean, dense: boolean)}
  {@const p = pace(w)}
  {@const c = chipOf(w, p)}
  {@const d = dialOf(w, p)}
  {@const label = labelOf(w, d, c)}
  {#if solo}
    <div class="flex items-center gap-[22px] px-1 py-0.5">
      <LimitGauge {kind} color={colorFor("provider", r.provider)} dial={d} {mode} {label} small={false} {roomy} />
      <div class="mb-1.5 flex min-w-0 flex-col items-start gap-1.5">
        <span class="text-[13px] font-medium text-ink">{windowName(w)}</span>
        <span class="flex h-5 items-center">{@render chip(c)}</span>
        <span class="text-[11px] text-muted">{@render counted(w)}</span>
      </div>
    </div>
  {:else}
    <div class="flex w-full min-w-0 flex-col items-center gap-1.5 text-center">
      <LimitGauge {kind} color={colorFor("provider", r.provider)} dial={d} {mode} {label} small={dense} {roomy} />
      <span class="mt-1.5 h-[18px] max-w-full truncate text-[13px] leading-[18px] font-medium text-ink" title={windowName(w)}>{dense ? shortName(w) : windowName(w)}</span>
      <span class="flex h-5 max-w-full items-center justify-center">{@render chip(c)}</span>
      <span class="min-h-3.5 text-[10.5px] leading-[14px] text-balance text-muted">{@render counted(w)}</span>
    </div>
  {/if}
{/snippet}

<!-- A provider's limits as bars, any number: side by side under the chart, one row each spread over the card's height beside
     it (see .limit-bars). Up to three get a header with the number, the bar and a line for the chip and the reset. Four or more get a one-line header and a thinner bar. Each row
     carries its text as one label, the bar itself is only a picture. -->
{#snippet bars(r: LimitReport)}
  {@const color = colorFor("provider", r.provider)}
  {@const dense = r.windows.length >= 4}
  <div class="limit-bars px-1 {dense ? 'limit-dense' : ''} {r.windows.length < 3 ? 'limit-few' : ''}">
    {#each r.windows as w (w.id)}
      {@const p = pace(w)}
      {@const c = chipOf(w, p)}
      {@const d = dialOf(w, p)}
      {@const pct = `${Math.round(d.value * 100)}%`}
      <div class="min-w-0" role="img" aria-label={labelOf(w, d, c)}>
        {#if dense}
          <div class="mb-1 flex h-5 min-w-0 items-center gap-2">
            <span class="max-w-[35%] shrink-0 truncate text-[13px] leading-5 font-medium text-ink" title={windowName(w)}>{shortName(w)}</span>
            <span class="min-w-0 truncate text-[11px] text-muted">{@render reset(w)}</span>
            {#if c}<span class="ml-auto shrink-0">{@render chip(c)}</span>{/if}
            <span class="w-[38px] shrink-0 text-right text-[15px] leading-5 font-bold tracking-[-0.02em] text-ink tabular-nums {c ? '' : 'ml-auto'}">{pct}</span>
          </div>
          <LimitBar {color} dial={d} {mode} small />
        {:else}
          <div class="mb-1 flex min-w-0 items-baseline gap-2">
            <span class="min-w-0 truncate text-[13px] leading-5 font-medium text-ink" title={windowName(w)}>{windowName(w)}</span>
            <span class="ml-auto shrink-0 text-[18px] leading-5 font-bold tracking-[-0.02em] text-ink tabular-nums">{pct}</span>
            <span class="shrink-0 text-[11px] font-medium text-ink-2">{t(mode === "used" ? "live.dial.used" : "live.dial.left")}</span>
          </div>
          <LimitBar {color} dial={d} {mode} small={false} />
          <div class="mt-2 flex h-5 min-w-0 items-center gap-2.5">
            {#if c}<span class="shrink-0">{@render chip(c)}</span>{/if}
            <span class="min-w-0 truncate text-[11px] text-muted">{@render counted(w)}</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/snippet}

<div class="flex flex-col 2xl:h-[296px]">
  <!-- Beside the chart (2xl), the card is as tall as the chart: more limits than fit scroll here, the pager stays below.
       Under the chart, on narrower screens, it is as tall as its gauges. -->
  <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 {data.reports.length > 1 ? '' : 'pb-4'}">
    {#if data.reports.length}
      <!-- Every provider sits in the same grid cell, so the card stays as tall as the tallest one and the pager doesn't
           jump while paging. The others are hidden. The cell takes the body's spare height, and the gauges sit in its middle. The section
           may be narrower than its text (min-w-0), which then truncates, rather than widening the cell. -->
      <div class="grid flex-1">
        {#each data.reports as r (r.key)}
          {@const n = r.windows.length}
          <section class="flex min-w-0 flex-col gap-2 [grid-area:1/1] {r.key === shownKey ? '' : 'invisible'}" inert={r.key !== shownKey}>
            <header class="flex items-center gap-2.5">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style:background={colorFor("provider", r.provider)}></span>
              <span class="text-[13px] font-semibold text-ink">{NAMES[r.provider] ?? r.provider}</span>
              {#if r.plan}<span class="rounded-full border border-line px-2 py-px text-[11px] text-ink-2">{planName(r.plan)}</span>{/if}
              {#if r.account}<span class="truncate font-mono text-[11px] text-muted">{r.account}</span>{/if}
              {#if now - r.observedAt > STALE_MS}<span class="ml-auto shrink-0 text-[11px] text-muted">{t("live.asOf", { ago: relative(r.observedAt) })}</span>{/if}
              <!-- The key to the gauges, beside the provider rather than under the gauges, where it read as part of them. The
                   battery always draws what is left, so its solid cells are what is left at the reset, not the use so far. -->
              {#if showForecast && r.windows.some((w) => pace(w))}
                <span class="ml-auto flex shrink-0 items-center gap-3 text-[11px] text-muted {now - r.observedAt > STALE_MS ? '!ml-3' : ''}">
                  <span><i class="limit-swatch" style:background={colorFor("provider", r.provider)}></i>{t(gauge === "battery" ? "live.legend.chargeReset" : mode === "used" ? "live.legend.usedNow" : "live.legend.leftNow")}</span>
                  <span><i class="limit-swatch" style:background={colorFor("provider", r.provider)} style:opacity="0.35"></i>{t(mode === "used" ? "live.legend.pacedUsed" : "live.legend.pacedLeft")}</span>
                </span>
              {/if}
            </header>
            <div class="flex flex-1 flex-col {gauge === 'bars' && n > 0 ? 'justify-start' : 'justify-center'}">
              {#if gauge === "bars" && n > 0}
                {@render bars(r)}
              {:else if n === 1}
                {@render limit(r, r.windows[0]!, true, false)}
              {:else if n > 1}
                <!-- Up to four to a row in columns of one width, so a short row doesn't spread out. Four or more get smaller gauges. -->
                <div class="grid justify-items-center gap-x-2 gap-y-3 {n >= 4 ? 'limit-dense' : ''}" style:grid-template-columns="repeat({Math.min(n, 4)}, minmax(0, 1fr))">
                  {#each r.windows as w (w.id)}
                    {@render limit(r, w, false, n >= 4)}
                  {/each}
                </div>
              {/if}
            </div>
          </section>
        {/each}
      </div>
    {/if}
    {#each data.problems as p (p.source)}
      <p class="rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">{t(`live.problem.${p.code}` as "live.problem.failed", { source: PROBLEM_SOURCES[p.source], time: p.retryAt ? until(p.retryAt, now) : "" })}</p>
    {/each}
  </div>
  {#if data.reports.length > 1}
    <div class="limit-pager shrink-0">
      <Pager page={index + 1} total={data.reports.length} size={1} onpage={(p) => (current = data.reports[p - 1]!.key)} />
    </div>
  {/if}
</div>
