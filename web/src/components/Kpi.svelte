<script lang="ts">
  import { ArrowDownRight, ArrowUpRight } from "@lucide/svelte";
  import { percent } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import Chart from "./Chart.svelte";
  import { sparkline } from "../lib/charts.ts";
  import { store } from "../lib/state.svelte.ts";

  interface Props {
    label: string;
    value: string;
    current?: number;
    previous?: number | null;
    /** Whether an increase is good (green) or bad (red). Usage growth is neutral → null. */
    upIsGood?: boolean | null;
    hint?: string;
    trend?: number[];
    hero?: boolean;
  }
  let { label, value, current, previous, upIsGood = null, hint, trend, hero = false }: Props = $props();

  const delta = $derived(current != null && previous ? (current - previous) / previous : null);
  const tone = $derived(
    delta == null || upIsGood == null || Math.abs(delta) < 0.005 ? "neutral" : (delta > 0) === upIsGood ? "good" : "bad",
  );
  const sparkOption = $derived.by(() => {
    void store.dark;
    return trend && trend.length > 1 ? sparkline(trend) : null;
  });
</script>

<div class="card flex min-w-0 flex-col justify-between gap-2 px-4 py-3.5" class:hero>
  <div class="text-xs font-medium text-muted">{label}</div>
  <div class="flex items-end justify-between gap-3">
    <div class="min-w-0">
      <div class="truncate font-semibold tracking-tight text-ink {hero ? 'text-[2.15rem] leading-none' : 'text-2xl leading-tight'}" title={value}>
        {value}
      </div>
      {#if delta != null}
        <div
          class="mt-1 flex items-center gap-1 text-xs whitespace-nowrap"
          class:text-good={tone === "good"}
          class:text-bad={tone === "bad"}
          class:text-ink-2={tone === "neutral"}
        >
          {#if delta >= 0}<ArrowUpRight size={13} />{:else}<ArrowDownRight size={13} />{/if}
          <span class="tabular">{delta > 0 ? "+" : ""}{percent(delta, Math.abs(delta) < 0.1 ? 1 : 0)}</span>
          <span class="truncate text-muted">{t("kpi.vsPrev")}</span>
        </div>
      {:else if hint}
        <div class="mt-1 truncate text-xs text-muted" title={hint}>{hint}</div>
      {/if}
    </div>
    {#if sparkOption}
      <div class="w-24 shrink-0"><Chart option={sparkOption} height={36} /></div>
    {/if}
  </div>
</div>
