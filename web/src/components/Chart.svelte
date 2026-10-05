<script lang="ts">
  import { onMount } from "svelte";
  import { echarts, type EChartsOption } from "../lib/echarts.ts";

  interface Props {
    option: EChartsOption;
    height?: number | string;
    /** Grow to fill the card's height (`height` is then the least it gets), e.g. to match the card beside it. */
    fill?: boolean;
    dim?: boolean;
    onclick?: (params: { name: string; dataIndex: number; seriesName?: string; value: unknown; data?: unknown }) => void;
    /**
     * For charts whose legend entries aren't ECharts series of their own (e.g. custom-drawn groups):
     * the parent hides entries by rebuilding the option, and tells the legend which ones are off.
     */
    legendOff?: string[];
    onlegend?: (name: string) => void;
  }
  let { option, height = 280, fill = false, dim = false, onclick, legendOff, onlegend }: Props = $props();
  /** Highlight-one charts mark their highlighted entry (see htmlLegend); the others read as selectable. */
  const active = $derived((option.legend as { active?: string } | undefined)?.active);

  let el = $state<HTMLDivElement>();
  let chart: ReturnType<typeof echarts.init> | null = null;
  /** Series switched off through the legend; reset whenever a new option replaces the old one. */
  let off = $state<Record<string, boolean>>({});

  interface SeriesLike {
    name?: string;
    color?: string;
    lineStyle?: { color?: string };
  }
  // A hidden ECharts legend (see htmlLegend in charts.ts) asks for the HTML row rendered here.
  const legend = $derived.by(() => {
    const lg = option.legend as { show?: boolean; data?: string[]; colors?: string[] } | undefined;
    if (!lg?.data || lg.show !== false) return [];
    const series = (option.series ?? []) as SeriesLike[];
    return lg.data.map((name, i) => {
      const s = series.find((x) => x.name === name);
      return { name, color: lg.colors?.[i] ?? s?.color ?? s?.lineStyle?.color ?? "var(--muted)" };
    });
  });
  const isOff = (name: string) => (legendOff ? legendOff.includes(name) : !!off[name]);

  function toggle(name: string) {
    if (onlegend) onlegend(name);
    else chart?.dispatchAction({ type: "legendToggleSelect", name });
  }

  onMount(() => {
    chart = echarts.init(el!, undefined, { renderer: "canvas" });
    chart.setOption(option, { notMerge: true });
    chart.on("click", (p) => onclick?.(p as never));
    chart.on("legendselectchanged", (e) => {
      const selected = (e as { selected: Record<string, boolean> }).selected;
      off = Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, !v]));
    });
    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(el!);
    return () => {
      ro.disconnect();
      chart?.dispose();
      chart = null;
    };
  });

  $effect(() => {
    const opt = option;
    chart?.setOption(opt, { notMerge: true });
    off = {};
  });
</script>

<!-- Filling, it takes the whole card body, or in a column with other content (a headline) whatever is left. -->
<div class="transition-opacity {fill ? 'flex h-full min-h-0 flex-1 flex-col' : ''}" class:loading-dim={dim}>
  {#if legend.length}
    <ul class="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {#each legend as item (item.name)}
        <li>
          <button
            type="button"
            class="flex max-w-56 items-center gap-1.5 transition-opacity hover:text-ink {active && active !== item.name ? 'text-muted' : 'text-ink-2'}"
            class:opacity-40={isOff(item.name)}
            class:font-medium={active === item.name}
            class:!text-ink={active === item.name}
            aria-pressed={active ? active === item.name : !isOff(item.name)}
            title={item.name}
            onclick={() => toggle(item.name)}
          >
            <span class="h-2 w-2 shrink-0 rounded-full" style:background={item.color}></span>
            <span class="truncate">{item.name}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if fill}
    <!-- The chart is drawn in a layer that takes the space the card gives it but adds none: otherwise its canvas
         would push the card taller, which would grow the canvas again. -->
    <div class="relative min-h-0 w-full flex-1" style:min-height={typeof height === "number" ? `${height}px` : height}>
      <div bind:this={el} class="absolute inset-0" class:cursor-pointer={!!onclick}></div>
    </div>
  {:else}
    <div bind:this={el} class="w-full" class:cursor-pointer={!!onclick} style:height={typeof height === "number" ? `${height}px` : height}></div>
  {/if}
</div>
