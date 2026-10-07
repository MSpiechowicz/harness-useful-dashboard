<script lang="ts">
  import { ArrowDownRight, ArrowUpRight } from "@lucide/svelte";
  import { cubicOut } from "svelte/easing";
  import { Tween } from "svelte/motion";
  import { percent } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import Chart from "./Chart.svelte";
  import { sparkBars } from "../lib/charts.ts";
  import { store } from "../lib/state.svelte.ts";

  interface Props {
    label: string;
    /** The value as shown, for tiles that aren't a single number. Ignored while `amount` is set. */
    value?: string;
    /** The value as a number, with `format` to show it: it counts up to it, and from the old value to a new one. */
    amount?: number | null;
    format?: (v: number) => string;
    current?: number;
    previous?: number | null;
    /** Whether an increase is good (green) or bad (red). Usage growth is neutral → null. */
    upIsGood?: boolean | null;
    hint?: string;
    /** Per-bucket values for the mini column chart, with matching bucket labels. */
    trend?: number[];
    trendLabels?: string[];
    trendFormat?: (v: number) => string;
  }
  let { label, value, amount, format = String, current, previous, upIsGood = null, hint, trend, trendLabels = [], trendFormat = String }: Props = $props();

  // From 0 when the tile first shows, then from the old value to the new one when the range or the data changes.
  // At once for those who asked for less motion: the CSS rule for that doesn't reach a tween.
  const shown = new Tween(0, { duration: 600, easing: cubicOut });
  const numeric = $derived(amount != null && Number.isFinite(amount));
  $effect(() => {
    if (amount == null || !Number.isFinite(amount)) return;
    shown.set(amount, { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
  });
  /** The final value, for the tooltip, so it doesn't show a number on its way there. */
  const text = $derived(numeric ? format(amount!) : (value ?? "–"));

  const delta = $derived(current != null && previous ? (current - previous) / previous : null);
  const tone = $derived(
    delta == null || upIsGood == null || Math.abs(delta) < 0.005 ? "neutral" : (delta > 0) === upIsGood ? "good" : "bad",
  );
  const sparkOption = $derived.by(() => {
    void store.dark;
    return trend && trend.length > 1 ? sparkBars(trend, trendLabels, label, trendFormat) : null;
  });
</script>

<div class="card flex min-w-0 flex-col gap-2 px-4 py-3.5">
  <div class="truncate text-xs font-medium text-muted">{label}</div>
  <!-- Fixed-height value row and an always-reserved line under the number: every tile, with or without
       a mini chart, delta or hint, is the same height and the numbers share a baseline across pages. -->
  <div class="flex h-14 items-end justify-between gap-3">
    <div class="min-w-0">
      <!-- Tabular figures: a counting number keeps its width. -->
      <div class="tabular truncate text-2xl leading-tight font-semibold tracking-tight text-ink" title={text}>
        {numeric ? format(shown.current) : text}
      </div>
      {#if delta != null}
        <div
          class="mt-1 flex h-4 items-center gap-1 text-xs whitespace-nowrap"
          title={t("kpi.vsPrevHint")}
          class:text-good={tone === "good"}
          class:text-bad={tone === "bad"}
          class:text-ink-2={tone === "neutral"}
        >
          {#if delta >= 0}<ArrowUpRight size={13} />{:else}<ArrowDownRight size={13} />{/if}
          <span class="tabular">{delta > 0 ? "+" : ""}{percent(delta, Math.abs(delta) < 0.1 ? 1 : 0)}</span>
          <span class="truncate text-muted">{t("kpi.vsPrev")}</span>
        </div>
      {:else}
        <div class="mt-1 h-4 truncate text-xs leading-4 text-muted" title={hint}>{hint ?? ""}</div>
      {/if}
    </div>
    {#if sparkOption}
      <div class="w-32 shrink-0"><Chart option={sparkOption} height={48} {label} /></div>
    {/if}
  </div>
</div>
