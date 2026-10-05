<script lang="ts">
  import { onMount } from "svelte";
  import { echarts, type EChartsOption } from "../lib/echarts.ts";

  interface Props {
    option: EChartsOption;
    height?: number | string;
    dim?: boolean;
    onclick?: (params: { name: string; dataIndex: number; seriesName?: string; value: unknown }) => void;
  }
  let { option, height = 280, dim = false, onclick }: Props = $props();

  let el: HTMLDivElement;
  let chart: ReturnType<typeof echarts.init> | null = null;

  onMount(() => {
    chart = echarts.init(el, undefined, { renderer: "canvas" });
    chart.setOption(option, { notMerge: true });
    chart.on("click", (p) => onclick?.(p as never));
    const ro = new ResizeObserver(() => chart?.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart?.dispose();
      chart = null;
    };
  });

  $effect(() => {
    const opt = option;
    chart?.setOption(opt, { notMerge: true });
  });
</script>

<div
  bind:this={el}
  class="w-full transition-opacity"
  class:loading-dim={dim}
  class:cursor-pointer={!!onclick}
  style:height={typeof height === "number" ? `${height}px` : height}
></div>
