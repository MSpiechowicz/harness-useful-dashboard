<script lang="ts">
  import { CalendarCheck, Flame, Mountain, Sigma, Sun, Trophy } from "@lucide/svelte";
  import { type ActivityDay, type ActivityStats, parseDay } from "../lib/activity.ts";
  import { days, metricValue, percent } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  let { stats, loading = false }: { stats: ActivityStats; loading?: boolean } = $props();

  const value = (d: ActivityDay) => (store.metric === "cost" ? d.cost : d.tokens);
  const date = (k: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.locale, opts).format(parseDay(k));
  // 2024-01-01 was a Monday, so day i of that week is weekday i (0 = Monday).
  const weekday = (i: number) => new Intl.DateTimeFormat(i18n.locale, { weekday: "long" }).format(new Date(2024, 0, 1 + i));

  interface Tile {
    icon: typeof Flame;
    label: string;
    value: string;
    hint?: string;
  }
  const tiles = $derived<Tile[]>([
    {
      icon: CalendarCheck,
      label: t("calendar.activeDays"),
      value: String(stats.active),
      hint: t("calendar.ofDays", { total: stats.total }),
    },
    {
      icon: Flame,
      label: t("calendar.currentStreak"),
      value: days(stats.current),
      hint: stats.currentSince ? t("calendar.since", { date: date(stats.currentSince, { month: "short", day: "numeric" }) }) : t("calendar.noStreak"),
    },
    {
      icon: Mountain,
      label: t("calendar.longestStreak"),
      value: days(stats.longest),
      hint:
        stats.longestFrom && stats.longestTo
          ? stats.longestFrom === stats.longestTo
            ? date(stats.longestFrom, { month: "short", day: "numeric" })
            : `${date(stats.longestFrom, { month: "short", day: "numeric" })} – ${date(stats.longestTo, { month: "short", day: "numeric" })}`
          : t("calendar.noStreak"),
    },
    {
      icon: Trophy,
      label: t("calendar.busiestDay"),
      value: stats.busiest ? metricValue(value(stats.busiest), store.metric) : "–",
      hint: stats.busiest ? date(stats.busiest.day, { weekday: "short", month: "short", day: "numeric" }) : undefined,
    },
    { icon: Sigma, label: t("calendar.average"), value: metricValue(stats.average, store.metric), hint: t("calendar.perActiveDay") },
    {
      icon: Sun,
      label: t("calendar.busiestWeekday"),
      value: stats.busiestWeekday != null ? weekday(stats.busiestWeekday) : "–",
      hint: stats.busiestWeekday != null ? t("calendar.ofUsage", { share: percent(stats.busiestWeekdayShare, 0) }) : undefined,
    },
  ]);
</script>

<!-- Tiles keep their natural height: beside a taller calendar the card has room to spare below them, not inside them. -->
<div class="grid grid-cols-2 content-start gap-3 sm:grid-cols-3" class:loading-dim={loading}>
  {#each tiles as tile (tile.label)}
    <div class="flex flex-col gap-2 rounded-xl bg-surface-2 p-3.5">
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <tile.icon size={13} class="shrink-0 text-ink-2" />
        {tile.label}
      </div>
      <div>
        <div class="truncate text-xl font-semibold tracking-tight text-ink tabular">{tile.value}</div>
        {#if tile.hint}<div class="mt-1 truncate text-xs text-muted">{tile.hint}</div>{/if}
      </div>
    </div>
  {/each}
</div>
