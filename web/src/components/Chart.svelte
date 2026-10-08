<script lang="ts">
  import { getContext, onMount, untrack } from "svelte";
  import { echarts, type EChartsOption } from "../lib/echarts.ts";
  import { store } from "../lib/state.svelte.ts";

  interface Props {
    option: EChartsOption;
    height?: number | string;
    /** Grow to fill the card's height (`height` is then the least it gets), e.g. to match the card beside it. */
    fill?: boolean;
    dim?: boolean;
    /** `componentType` tells what was clicked ("series", "markLine"…), `data` is the clicked item as the option gave it. */
    onclick?: (params: { name: string; dataIndex: number; seriesName?: string; value: unknown; data?: unknown; componentType?: string; componentIndex?: number }) => void;
    /** A click anywhere in the plot of a category chart, even on empty space: the index of the category under it. */
    onpoint?: (index: number) => void;
    /**
     * For charts whose legend entries aren't ECharts series of their own (e.g. custom-drawn groups):
     * the parent hides entries by rebuilding the option, and tells the legend which ones are off.
     */
    legendOff?: string[];
    onlegend?: (name: string) => void;
    /**
     * The text alternative, read by screen readers. Defaults to the title of the card the chart is in. Not ECharts'
     * own aria description: its generated text isn't localized.
     */
    label?: string;
  }
  let { option, height = 280, fill = false, dim = false, onclick, onpoint, legendOff, onlegend, label }: Props = $props();
  const cardTitle = getContext<(() => string | undefined) | undefined>("card-title");
  const name = $derived(label ?? cardTitle?.());
  /** Highlight-one charts mark their highlighted entry (see htmlLegend); the others read as selectable. */
  const active = $derived((option.legend as { active?: string } | undefined)?.active);

  let el = $state<HTMLDivElement>();
  let chart: ReturnType<typeof echarts.init> | null = null;
  /** Series switched off through the legend. They stay off when new data comes in, while their names are still there. */
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

  /**
   * The option as drawn: with the legend entries the user switched off kept off, and without motion for those who
   * asked for less (no grow-in, no ripple on the Live chart). A print takes the chart as it is drawn, so it has no
   * motion either: it would catch the bars still growing.
   */
  function prepared(opt: EChartsOption, hidden: string[]): EChartsOption {
    let out = opt;
    const lg = opt.legend as { data?: (string | { name: string })[]; selected?: Record<string, boolean> } | unknown[] | undefined;
    if (hidden.length && lg && !Array.isArray(lg) && !legendOff) {
      const names = new Set([...(lg.data ?? []).map((d) => (typeof d === "string" ? d : d.name)), ...((opt.series ?? []) as SeriesLike[]).map((x) => x.name)]);
      const keep = hidden.filter((n) => names.has(n));
      if (keep.length) out = { ...out, legend: { ...lg, selected: { ...lg.selected, ...Object.fromEntries(keep.map((n) => [n, false])) } } };
    }
    if (store.printing || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const series = ((out.series ?? []) as { type?: string }[]).map((x) => (x.type === "effectScatter" ? { ...x, type: "scatter" } : x));
      out = { ...out, animation: false, series: series as EChartsOption["series"] };
    }
    return out;
  }

  onMount(() => {
    chart = echarts.init(el!, undefined, { renderer: "canvas" });
    chart.setOption(prepared(option, []), { notMerge: true });
    chart.on("click", (p) => onclick?.(p as never));
    chart.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      if (!onpoint || !chart) return;
      const at = [e.offsetX, e.offsetY];
      if (!chart.containPixel("grid", at)) return;
      const index = chart.convertFromPixel({ gridIndex: 0 }, at)[0];
      if (index !== undefined && Number.isFinite(index)) onpoint(Math.round(index));
    });
    chart.on("legendselectchanged", (e) => {
      const selected = (e as { selected: Record<string, boolean> }).selected;
      off = Object.fromEntries(Object.entries(selected).map(([k, v]) => [k, !v]));
    });
    // Resizes are batched to one per frame and skipped while the box has no size (a collapsed column on a narrow
    // window). Resizing straight from the observer can land while ECharts is still drawing, and the new size can
    // move the layout and fire the observer again: an endless loop that froze the page.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (chart && el && el.clientWidth > 0 && el.clientHeight > 0) chart.resize();
      });
    });
    ro.observe(el!);
    // The print layout is narrower than the screen (no sidebar, the paper's width), and a ResizeObserver doesn't
    // run before the browser takes the page: the canvas would be cut off at the paper's edge. It is resized as soon
    // as the print layout applies, and again once it is gone.
    const print = matchMedia("print");
    const fit = () => chart?.resize({ animation: { duration: 0 } });
    print.addEventListener("change", fit);
    window.addEventListener("afterprint", fit);
    return () => {
      print.removeEventListener("change", fit);
      window.removeEventListener("afterprint", fit);
      ro.disconnect();
      cancelAnimationFrame(frame);
      chart?.dispose();
      chart = null;
    };
  });

  $effect(() => {
    const opt = option;
    if (!chart || chart.isDisposed()) return;
    const hidden = untrack(() => Object.keys(off).filter((k) => off[k]));
    const drawn = prepared(opt, hidden);
    chart.setOption(drawn, { notMerge: true });
    const selected = (drawn.legend as { selected?: Record<string, boolean> } | undefined)?.selected ?? {};
    off = Object.fromEntries(Object.entries(selected).filter(([, v]) => !v).map(([k]) => [k, true]));
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
      <div bind:this={el} class="absolute inset-0" class:cursor-pointer={!!onclick || !!onpoint} role={name ? "img" : undefined} aria-label={name}></div>
    </div>
  {:else}
    <div bind:this={el} class="w-full" class:cursor-pointer={!!onclick || !!onpoint} role={name ? "img" : undefined} aria-label={name} style:height={typeof height === "number" ? `${height}px` : height}></div>
  {/if}
</div>
