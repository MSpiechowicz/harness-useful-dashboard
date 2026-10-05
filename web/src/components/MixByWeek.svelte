<script lang="ts">
  import type { TimeSeries } from "../lib/api.svelte.ts";
  import { seriesLabel } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { metricValue, parseBucket, percent } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";

  interface Props {
    ts: TimeSeries;
    dim: string;
    metric: "tokens" | "cost";
    /** The most recent weeks with any usage, at most this many. */
    weeks?: number;
  }
  let { ts, dim, metric, weeks = 6 }: Props = $props();

  // Calendar weeks start on Monday, as in the calendar and the hour heatmap.
  const monday = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  const span = $derived(new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric" }));

  const rows = $derived.by(() => {
    const byWeek = new Map<number, { start: Date; values: number[] }>();
    ts.buckets.forEach((b, i) => {
      const start = monday(parseBucket(b));
      const week = byWeek.get(start.getTime()) ?? { start, values: ts.series.map(() => 0) };
      ts.series.forEach((s, si) => (week.values[si]! += s.data[i] ?? 0));
      byWeek.set(start.getTime(), week);
    });
    return [...byWeek.values()]
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .filter((w) => w.values.some((v) => v > 0))
      .slice(-weeks)
      .map((w) => {
        const total = w.values.reduce((a, b) => a + b, 0);
        const end = new Date(w.start.getFullYear(), w.start.getMonth(), w.start.getDate() + 6);
        const parts = ts.series
          .map((s, si) => ({ key: s.key, name: seriesLabel(dim, s), color: colorFor(dim, s.key), share: total ? w.values[si]! / total : 0 }))
          .filter((p) => p.share > 0);
        return { key: w.start.getTime(), label: span.formatRange(w.start, end), total, parts };
      });
  });
</script>

<!-- How the mix changed: one 100% bar per week, split in the same colors as the donut above. -->
<div class="flex flex-col gap-2.5">
  <div class="border-t border-line pt-4 text-[11px] font-medium tracking-wide text-muted uppercase">{t("breakdown.mixByWeek")}</div>
  {#each rows as w (w.key)}
    <div class="grid grid-cols-[7rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-xs">
      <span class="truncate text-ink-2 tabular">{w.label}</span>
      <div class="flex h-2.5 gap-[2px]" title={w.parts.map((p) => `${p.name} ${percent(p.share, 1)}`).join(" · ")}>
        {#each w.parts as part (part.key)}
          <span class="h-full min-w-[2px] basis-0 first:rounded-l-full last:rounded-r-full" style:flex-grow={part.share} style:background={part.color}></span>
        {/each}
      </div>
      <span class="text-right text-ink-2 tabular">{metricValue(w.total, metric)}</span>
    </div>
  {/each}
</div>
