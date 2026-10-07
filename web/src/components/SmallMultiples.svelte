<script lang="ts">
  import type { TimeSeries } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { metricValue } from "../lib/format.ts";
  import { smallMultipleChart, type Tile } from "../lib/smallMultiples.ts";
  import { store } from "../lib/state.svelte.ts";
  import Chart from "./Chart.svelte";

  interface Props {
    tiles: Tile[];
    ts: TimeSeries;
    dim: string;
    bucket: string;
    metric: "tokens" | "cost";
    max: number;
    onselect?: (key: string) => void;
    loading?: boolean;
  }
  let { tiles, ts, dim, bucket, metric, max, onselect, loading = false }: Props = $props();

  const options = $derived.by(() => {
    void store.dark;
    return tiles.map((tile) => smallMultipleChart(tile, ts.buckets, { dim, metric, bucket, max }));
  });
</script>

<!-- One tile per project: the name and total on top, the series below. A tile is a button that filters by it. -->
<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
  {#each tiles as tile, i (tile.key)}
    <button
      type="button"
      class="flex min-w-0 flex-col gap-1 rounded-lg border border-line p-3 text-left transition-colors hover:bg-surface-2"
      title={tile.label}
      onclick={() => onselect?.(tile.key)}
    >
      <div class="flex items-baseline justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink">
          <span class="h-2 w-2 shrink-0 rounded-full" style:background={colorFor(dim, tile.key)}></span>
          <span class="truncate">{tile.label}</span>
        </span>
        <span class="shrink-0 text-sm tabular-nums text-ink-2">{metricValue(tile.total, metric)}</span>
      </div>
      <Chart option={options[i]!} height={72} dim={loading} label={tile.label} />
    </button>
  {/each}
</div>
