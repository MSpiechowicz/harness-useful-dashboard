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
    /** What the dials show: the share used or the share left. Older servers send none, which is used. */
    bars?: "used" | "left";
    /** Whether the dials draw where each limit is heading by the reset. Older servers send none, which is yes. */
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

  /** The name for a narrow dial: the scope alone when there is one ("Fable"), otherwise the length of the window ("Week"). */
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
  import Pager from "./Pager.svelte";

  let { data, now }: { data: LimitsResult; now: number } = $props();

  // One provider per page. The page is kept by the provider's key, so a refresh stays on it, and one that has gone falls
  // back to the first.
  let current = $state<string | null>(null);
  const index = $derived(Math.max(0, data.reports.findIndex((r) => r.key === current)));
  const shownKey = $derived(data.reports[index]?.key);

  // The dial shows the share used or the share left, always in the provider's color. Only the red end of the dial says
  // where the limit runs out: the 100% end when counting up, the 0% end when counting down.
  const mode = $derived(data.bars ?? "used");
  const showForecast = $derived(data.forecast ?? true);
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

  // The chip under a dial. None when there is nothing to say: used, but no window to measure the pace against.
  type Chip = { kind: "ok" | "out" | "idle"; text: string };
  function chipOf(w: LimitWindow, p: ReturnType<typeof pace>): Chip | null {
    if (w.usedFraction < 0.02) return { kind: "idle", text: t("live.chip.idle") };
    if (w.usedFraction >= 1) return { kind: "out", text: t("live.chip.reached") };
    if (p) return p.projected > 1 ? { kind: "out", text: t("live.chip.out", { time: clock(p.outAt) }) } : { kind: "ok", text: t("live.chip.ok") };
    if (tooEarly(w)) return { kind: "idle", text: t("live.chip.early") };
    return null;
  }

  // What the dial draws, as fractions of its sweep from the left end. The solid arc ends at the needle. With the forecast,
  // used: a pale arc runs on from the needle to where the use will have got by the reset. Left: the solid arc stops where
  // the reset will leave what is left, and the pale arc fills in up to the needle. Both end at the red end when it runs out.
  const MIN_ARC = 0.005;
  function dialOf(w: LimitWindow, p: ReturnType<typeof pace>): { value: number; solid: number; ahead: { from: number; to: number } | null } {
    const value = mode === "used" ? used(w) : 1 - used(w);
    if (!showForecast || !p) return { value, solid: value, ahead: null };

    if (mode === "used") {
      const to = Math.min(1, p.projected);
      return { value, solid: value, ahead: to - value > MIN_ARC ? { from: value, to } : null };
    }

    const to = Math.max(0, 1 - p.projected);
    return value - to > MIN_ARC ? { value, solid: to, ahead: { from: to, to: value } } : { value, solid: value, ahead: null };
  }

  // The dial's geometry in a 120 by 106 box: a half circle round the hub at (60, 60), the left end at 0% and the right at 100%.
  const CX = 60;
  const CY = 60;
  const RADIUS = 44;
  const point = (f: number, radius = RADIUS): [number, number] => [CX + radius * Math.cos(Math.PI * (1 + f)), CY + radius * Math.sin(Math.PI * (1 + f))];
  const xy = (pt: [number, number]) => `${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`;
  const arc = (from: number, to: number) => `M${xy(point(from))} A${RADIUS} ${RADIUS} 0 0 1 ${xy(point(to))}`;

  // Ticks at every quarter, the middle one longer.
  const TICKS = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ from: point(f, RADIUS - 12), to: point(f, RADIUS - (f === 0.5 ? 5 : 7)) }));

  // A pointer tapering from the hub towards the share f, as the points of a polygon.
  function needle(f: number): string {
    const angle = Math.PI * (1 + f);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const tip: [number, number] = [CX + ux * (RADIUS - 15), CY + uy * (RADIUS - 15)];
    const back: [number, number] = [CX - ux * 6, CY - uy * 6];
    return [
      [tip[0] - uy * 0.9, tip[1] + ux * 0.9],
      [tip[0] + uy * 0.9, tip[1] - ux * 0.9],
      [back[0] + uy * 3.2, back[1] - ux * 3.2],
      [back[0] - uy * 3.2, back[1] + ux * 3.2],
    ]
      .map(([x, y]) => `${x!.toFixed(2)},${y!.toFixed(2)}`)
      .join(" ");
  }

  // A reading is only dated when it's old (Codex logs it only while in use): a fresh one needs no note.
  const STALE_MS = 5 * 60_000;
  const PROBLEM_SOURCES = { claude: "Claude Code", omp: "omp", codex: "Codex", pi: "pi", opencode: "OpenCode", copilot: "Copilot CLI" };
</script>

{#snippet reset(w: LimitWindow)}
  {#if w.reset}{t("live.resetSince")}{:else if w.resetsAt}<span title={new Date(w.resetsAt).toLocaleString()}>{t("live.resetsIn", { time: until(w.resetsAt, now) })}</span>{:else}{t("live.noReset")}{/if}
{/snippet}

{#snippet chip(c: Chip | null)}
  {#if c}<span class="limit-chip {c.kind}">{c.text}</span>{/if}
{/snippet}

<!-- One dial: the track, the red end, the solid arc, the pale forecast arc, the ticks, the needle and the number. -->
{#snippet dial(provider: string, w: LimitWindow, d: { value: number; solid: number; ahead: { from: number; to: number } | null }, label: string, small: boolean)}
  {@const color = colorFor("provider", provider)}
  <svg viewBox="0 0 120 106" width={small ? 92 : 112} height={small ? 81 : 99} class="shrink-0" role="img" aria-label={label}>
    <path d={arc(0, 1)} fill="none" class="stroke-surface-3" stroke-width="8" />
    <path d={mode === "used" ? arc(0.9, 1) : arc(0, 0.1)} fill="none" stroke="var(--bad-ink)" stroke-opacity=".55" stroke-width="8" />
    {#if d.ahead}<path d={arc(d.ahead.from, d.ahead.to)} fill="none" stroke={color} stroke-opacity=".35" stroke-width="8" />{/if}
    {#if d.solid > 0.003}<path d={arc(0, d.solid)} fill="none" stroke={color} stroke-width="8" />{/if}
    {#each TICKS as tick, i (i)}
      <line x1={tick.from[0]} y1={tick.from[1]} x2={tick.to[0]} y2={tick.to[1]} class="stroke-muted" stroke-width="1.5" stroke-linecap="round" />
    {/each}
    <text x={CX - RADIUS} y={CY + 12} text-anchor="middle" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-ink-2" : "fill-bad"}>0%</text>
    <text x={CX + RADIUS} y={CY + 12} text-anchor="middle" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-bad" : "fill-ink-2"}>100%</text>
    <polygon points={needle(d.value)} class="fill-ink stroke-ink" stroke-width=".8" stroke-linejoin="round" />
    <circle cx={CX} cy={CY} r="6.5" class="fill-ink" />
    <circle cx={CX} cy={CY} r="2.2" class="fill-surface" />
    <text x={CX} y="81" text-anchor="middle" dominant-baseline="central" font-size="17" font-weight="650" class="fill-ink">{Math.round(d.value * 100)}%</text>
    <text x={CX} y="99" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="500" class="fill-ink-2">{t(mode === "used" ? "live.dial.used" : "live.dial.left")}</text>
  </svg>
{/snippet}

<!-- A limit: its dial, name, status chip and reset line, in rows of fixed height so a missing chip moves nothing. A lone
     limit sits beside its details, several sit in a column each. -->
{#snippet limit(r: LimitReport, w: LimitWindow, solo: boolean, dense: boolean)}
  {@const p = pace(w)}
  {@const c = chipOf(w, p)}
  {@const d = dialOf(w, p)}
  {@const label = [windowName(w), t(mode === "used" ? "live.used" : "live.left", { pct: Math.round(d.value * 100) }), c?.text].filter(Boolean).join(", ")}
  {#snippet counted()}{#if w.used != null && w.limit != null}{t("live.counted", { used: compact(w.used), limit: compact(w.limit) })} · {/if}{@render reset(w)}{/snippet}
  {#if solo}
    <div class="flex items-center gap-[22px] px-1 py-0.5">
      {@render dial(r.provider, w, d, label, false)}
      <div class="mb-1.5 flex min-w-0 flex-col items-start gap-1.5">
        <span class="text-[13px] text-ink">{windowName(w)}</span>
        <span class="flex h-6 items-center">{@render chip(c)}</span>
        <span class="text-xs text-muted">{@render counted()}</span>
      </div>
    </div>
  {:else}
    <div class="flex w-full min-w-0 flex-col items-center gap-1.5 text-center">
      <div class="mb-1.5">{@render dial(r.provider, w, d, label, dense)}</div>
      <span class="h-[18px] max-w-full truncate text-xs leading-[18px] text-ink" title={windowName(w)}>{dense ? shortName(w) : windowName(w)}</span>
      <span class="flex h-6 max-w-full items-center justify-center">{@render chip(c)}</span>
      <span class="min-h-4 text-[11px] leading-4 text-balance text-muted">{@render counted()}</span>
    </div>
  {/if}
{/snippet}

<div class="flex h-[296px] flex-col">
  <!-- The card is as tall as the chart beside it: more limits than fit scroll here, the pager stays below. -->
  <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 {data.reports.length > 1 ? '' : 'pb-4'}">
    {#if data.reports.length}
      <!-- Every provider sits in the same grid cell, so the card stays as tall as the tallest one and the pager doesn't
           jump while paging. The others are hidden. -->
      <div class="grid">
        {#each data.reports as r (r.key)}
          {@const n = r.windows.length}
          <section class="flex flex-col gap-2.5 [grid-area:1/1] {r.key === shownKey ? '' : 'invisible'}" inert={r.key !== shownKey}>
            <header class="flex items-center gap-2.5">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" style:background={colorFor("provider", r.provider)}></span>
              <span class="text-[13px] font-semibold text-ink">{NAMES[r.provider] ?? r.provider}</span>
              {#if r.plan}<span class="rounded-full border border-line px-2 py-px text-[11px] text-ink-2">{planName(r.plan)}</span>{/if}
              {#if r.account}<span class="truncate font-mono text-[11px] text-muted">{r.account}</span>{/if}
              {#if now - r.observedAt > STALE_MS}<span class="ml-auto shrink-0 text-[11px] text-muted">{t("live.asOf", { ago: relative(r.observedAt) })}</span>{/if}
            </header>
            {#if n === 1}
              {@render limit(r, r.windows[0]!, true, false)}
            {:else if n > 1}
              <!-- Up to four to a row in columns of one width, so a short row doesn't spread out. Four or more get smaller dials. -->
              <div class="grid justify-items-center gap-x-2 gap-y-3 {n >= 4 ? 'limit-dense' : ''}" style:grid-template-columns="repeat({Math.min(n, 4)}, minmax(0, 1fr))">
                {#each r.windows as w (w.id)}
                  {@render limit(r, w, false, n >= 4)}
                {/each}
              </div>
            {/if}
            {#if showForecast && r.windows.some((w) => pace(w))}
              <div class="flex justify-center gap-4 border-t border-line pt-1.5 text-[11px] text-muted">
                <span><i class="limit-swatch" style:background={colorFor("provider", r.provider)}></i>{t(mode === "used" ? "live.legend.usedNow" : "live.legend.leftNow")}</span>
                <span><i class="limit-swatch" style:background={colorFor("provider", r.provider)} style:opacity="0.35"></i>{t(mode === "used" ? "live.legend.pacedUsed" : "live.legend.pacedLeft")}</span>
              </div>
            {/if}
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
