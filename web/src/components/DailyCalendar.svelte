<script lang="ts">
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { type ActivityDay, addDays, dayKey, parseDay, spanMonths } from "../lib/activity.ts";
  import { compact, usd } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  interface Props {
    days: ActivityDay[];
    /** The days the range covers (see daySpan). */
    span: { start: string; end: string };
    /** The busiest day, which glows. */
    peak?: string | null;
    /** The months to draw (first days, see spanMonths), e.g. one page of a long range. Every month of the span by default. */
    visible?: Date[];
    loading?: boolean;
    /**
     * Paging through a long range: buttons left and right of the months, centred on them, so the card header keeps only
     * its legend. A function pages, null shows the button disabled (an end of the range), undefined hides it.
     */
    onearlier?: (() => void) | null;
    onlater?: (() => void) | null;
  }
  let { days, span, peak = null, visible, loading = false, onearlier, onlater }: Props = $props();

  const value = (d: ActivityDay | undefined) => (d ? (store.metric === "cost" ? d.cost : d.tokens) : 0);
  const byDay = $derived(new Map(days.map((d) => [d.day, d])));
  const today = dayKey(new Date());
  const inSpan = (k: string) => k >= span.start && k <= span.end;
  const max = $derived(Math.max(0, ...days.filter((d) => inSpan(d.day)).map(value)));
  // Seven steps of the sequential ramp, as in the hour-of-week heatmap beside it; no usage is seq-0.
  const step = (v: number) => (v > 0 && max > 0 ? 1 + Math.min(6, Math.floor((v / max) * 7)) : 0);

  interface Cell {
    key: string;
    date: number;
    inRange: boolean;
    step: number;
    day: ActivityDay | undefined;
    order: number;
  }
  const months = $derived.by(() => {
    const out: { label: string; lead: number; cells: Cell[] }[] = [];
    const shown = visible ?? spanMonths(span);
    // The year shows once it isn't obvious: months of two years, or paged back into an earlier one.
    const years = new Set(shown.map((m) => m.getFullYear()));
    const withYear = years.size > 1 || !years.has(new Date().getFullYear());
    const fmt = new Intl.DateTimeFormat(i18n.locale, withYear ? { month: "long", year: "numeric" } : { month: "long" });
    let order = 0;
    for (const m of shown) {
      const cells: Cell[] = [];
      for (let d = m; d.getMonth() === m.getMonth(); d = addDays(d, 1)) {
        const key = dayKey(d);
        const day = byDay.get(key);
        cells.push({ key, date: d.getDate(), inRange: inSpan(key), step: inSpan(key) ? step(value(day)) : 0, day, order: order++ });
      }
      out.push({ label: fmt.format(m), lead: (m.getDay() + 6) % 7, cells });
    }
    return out;
  });
  // As many week rows as the longest month needs, so no month ends in an empty row.
  const weeks = $derived(Math.max(4, ...months.map((m) => Math.ceil((m.lead + m.cells.length) / 7))));
  // 2024-01-01 was a Monday: weeks start on Monday, as in the heatmap.
  const weekdays = $derived(Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(i18n.locale, { weekday: "short" }).format(new Date(2024, 0, 1 + i))));

  // Day numbers stay readable on every step. The ramp runs light → dark on light and dark → light on dark, so the
  // surface color (the inverse of the ink) goes on the steps that are far from the surface.
  const ink = (s: number) => (s === 0 ? "var(--muted)" : (store.dark ? s >= 5 : s >= 4) ? "var(--surface)" : "var(--ink)");
  const fullDate = (k: string) => new Intl.DateTimeFormat(i18n.locale, { weekday: "long", month: "long", day: "numeric" }).format(parseDay(k));

  let hover = $state<{ cell: Cell; x: number; y: number } | null>(null);
  let box: HTMLDivElement;
  function show(cell: Cell, el: HTMLElement) {
    const r = box.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    hover = { cell, x: c.left - r.left + c.width / 2, y: c.top - r.top };
  }
  /** Zooms the whole dashboard into one day. */
  function open(cell: Cell) {
    if (!cell.inRange) return;
    store.customFrom = cell.key;
    store.customTo = cell.key;
    store.setRange("custom");
  }
</script>

{#snippet pager(go: (() => void) | null | undefined, label: string, back: boolean)}
  {#if go !== undefined}
    <!-- A bare chevron at the card's edge, not a boxed button: it shouldn't compete with the day cells. -->
    <button type="button" class="pager {back ? '-ml-2' : '-mr-2'}" disabled={!go} aria-label={label} title={label} onclick={() => go?.()}>
      {#if back}<ChevronLeft size={18} />{:else}<ChevronRight size={18} />{/if}
    </button>
  {/if}
{/snippet}

<div class="flex h-full items-stretch gap-1">
  {@render pager(onearlier, t("calendar.earlier"), true)}
  <div class="months relative min-w-0 flex-1" class:loading-dim={loading} bind:this={box} role="presentation" onmouseleave={() => (hover = null)}>
    {#each months as month (month.label)}
      <div class="flex min-w-0 flex-col">
        <div class="mb-1.5 text-xs font-medium capitalize text-ink-2">{month.label}</div>
        <div class="weeks grid flex-1 grid-cols-7 gap-1" style:--weeks={weeks}>
          {#each weekdays as w, i (i)}<div class="truncate pb-0.5 text-center text-[11px] text-muted">{w}</div>{/each}
          {#each { length: month.lead } as _, i (i)}<div></div>{/each}
          {#each month.cells as cell (cell.key)}
            <button
              type="button"
              class="day"
              class:out={!cell.inRange}
              class:today={cell.key === today}
              class:peak={peak === cell.key}
              style:background={`var(--seq-${cell.step})`}
              style:color={cell.inRange ? ink(cell.step) : "var(--muted)"}
              style:animation-delay="{Math.min(cell.order * 8, 600)}ms"
              aria-label={fullDate(cell.key)}
              disabled={!cell.inRange}
              onmouseenter={(e) => show(cell, e.currentTarget)}
              onfocus={(e) => show(cell, e.currentTarget)}
              onclick={() => open(cell)}
            >
              {cell.date}
            </button>
          {/each}
          <!-- Every month gets the same number of week rows, so cells are the same height in every month. -->
          {#each { length: weeks * 7 - month.lead - month.cells.length } as _, i (i)}<div></div>{/each}
        </div>
      </div>
    {/each}

    {#if hover && hover.cell.inRange}
      <div class="tip" style:left="{hover.x}px" style:top="{hover.y}px">
        <div class="text-[11px] text-muted">{fullDate(hover.cell.key)}</div>
        {#if hover.cell.day && value(hover.cell.day) > 0}
          <div class="mt-0.5 flex items-baseline gap-2">
            <b class="text-sm text-ink tabular">{usd(hover.cell.day.cost)}</b>
            <span class="text-xs text-ink-2 tabular">{compact(hover.cell.day.tokens)} {t("metric.tokens").toLowerCase()}</span>
          </div>
        {:else}
          <div class="mt-0.5 text-xs text-ink-2">{t("chart.noUsage")}</div>
        {/if}
      </div>
    {/if}
  </div>
  {@render pager(onlater, t("calendar.later"), false)}
</div>

<style>
  /* Months share the card's width and fill its height; more months than fit side by side wrap onto more rows. */
  .months {
    display: grid;
    height: 100%;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
    grid-auto-rows: 1fr;
    gap: 1rem 1.5rem;
  }
  /* Weekday names, then the week rows sharing whatever height the card has. */
  .weeks {
    grid-template-rows: auto repeat(var(--weeks), minmax(30px, 1fr));
  }
  /* Month paging: a slim chevron centred on the months, highlighted on hover only. */
  .pager {
    flex-shrink: 0;
    align-self: center;
    display: grid;
    place-items: center;
    width: 24px;
    height: 32px;
    border-radius: 6px;
    color: var(--ink-2);
    transition:
      background 120ms ease,
      color 120ms ease;
  }
  .pager:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--ink);
  }
  .pager:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .pager:disabled {
    opacity: 0.3;
    cursor: default;
  }
  /* Cells take the heatmap's look: corners and gaps. */
  .day {
    min-height: 30px;
    border-radius: 4px;
    font-size: 10px;
    line-height: 1;
    display: flex;
    align-items: flex-start;
    justify-content: flex-start;
    padding: 4px 5px;
    font-variant-numeric: tabular-nums;
    transition:
      transform 120ms ease,
      box-shadow 120ms ease;
    animation: pop 420ms cubic-bezier(0.2, 0.9, 0.3, 1.25) both;
    cursor: pointer;
  }
  .day:hover:not(.out),
  .day:focus-visible {
    transform: scale(1.08);
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--ink-2);
    z-index: 1;
    outline: none;
  }
  /* Days outside the range keep a faint empty tile, so the month reads as a whole. */
  .day.out {
    cursor: default;
    opacity: 0.4;
  }
  .day.today {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent);
  }
  .day.peak {
    box-shadow: 0 0 14px 2px var(--seq-5);
  }
  .day.today.peak {
    box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--accent), 0 0 16px 3px var(--seq-5);
  }
  .tip {
    position: absolute;
    transform: translate(-50%, calc(-100% - 8px));
    pointer-events: none;
    z-index: 10;
    white-space: nowrap;
    background: var(--popover);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px 10px;
    box-shadow: var(--shadow-pop);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.6);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .day {
      animation: none;
      transition: none;
    }
  }
</style>
