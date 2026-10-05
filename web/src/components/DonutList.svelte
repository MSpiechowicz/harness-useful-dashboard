<script lang="ts">
  import { donutChart, topWithOther, type ShareItem } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { percent } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import Chart from "./Chart.svelte";

  interface Item extends ShareItem {
    /** Secondary line under the name, e.g. the other metric and session count. */
    detail?: string;
  }
  interface Props {
    items: Item[];
    dim: string;
    format: (v: number) => string;
    /** Clicking a slice or row selects that item, e.g. to apply it as a filter. */
    onselect?: (key: string) => void;
    loading?: boolean;
  }
  let { items, dim, format, onselect, loading = false }: Props = $props();

  const total = $derived(items.reduce((a, i) => a + i.value, 0));
  // The legend lists what the donut draws: the top slices, the rest folded into "Other".
  const shown = $derived(topWithOther(items, 7) as Item[]);
  const option = $derived.by(() => (void store.dark, donutChart(shown, dim, format)));
</script>

{#snippet row(it: Item)}
  {@const share = total ? it.value / total : 0}
  <span class="flex min-w-0 items-center gap-2.5">
    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style:background={colorFor(dim, it.key)}></span>
    <span class="min-w-0">
      <span class="block truncate text-[13px] font-medium text-ink">{it.label}</span>
      {#if it.detail}<span class="block truncate text-xs text-muted">{it.detail}</span>{/if}
    </span>
  </span>
  <span class="text-right">
    <span class="tabular block text-[13px] font-medium text-ink">{format(it.value)}</span>
    <span class="tabular block text-xs text-muted">{percent(share, share < 0.1 ? 1 : 0)}</span>
  </span>
{/snippet}

<!-- Sized by its card, not the window: the legend moves beside the donut only when the card is wide enough. -->
<div class="@container">
<div class="grid items-center gap-x-6 gap-y-4 transition-opacity @sm:grid-cols-[11rem_minmax(0,1fr)]" class:loading-dim={loading}>
  <div class="relative mx-auto h-44 w-44">
    <Chart
      {option}
      height={176}
      onclick={onselect ? (p) => { const key = (p.data as { key?: string } | undefined)?.key; if (key && key !== "__other__") onselect(key); } : undefined}
    />
    <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
      <span class="tabular text-lg leading-tight font-semibold tracking-tight text-ink">{format(total)}</span>
      <span class="text-[11px] text-muted">{t("common.total")}</span>
    </div>
  </div>
  <ul class="-mx-2 flex min-w-0 flex-col">
    {#each shown as it (it.key)}
      <li>
        {#if onselect && it.key !== "__other__"}
          <button type="button" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2" onclick={() => onselect(it.key)}>
            {@render row(it)}
          </button>
        {:else}
          <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-2 py-1.5">{@render row(it)}</div>
        {/if}
      </li>
    {/each}
  </ul>
</div>
</div>
