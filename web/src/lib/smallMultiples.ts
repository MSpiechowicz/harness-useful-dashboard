import type { TimeSeries } from "./api.svelte.ts";
import { chrome, escapeHtml } from "./charts.ts";
import { colorFor } from "./colors.svelte.ts";
import type { EChartsOption } from "./echarts.ts";
import { bucketLabel, entityLabel, metricValue } from "./format.ts";

export interface Tile {
  key: string;
  label: string;
  total: number;
  data: number[];
}

/** The top series of a time series as tiles, biggest first. "Other" and, when asked, "(none)" are left out. */
export function tilesOf(ts: TimeSeries, dim: string, limit: number, skipNone: boolean): Tile[] {
  return ts.series
    .filter((s) => s.key !== "__other__" && !(skipNone && s.key === "(none)"))
    .map((s) => ({ key: s.key, label: entityLabel(dim, s.key, s.name), total: s.data.reduce((a, b) => a + b, 0), data: s.data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

/** The biggest value in any tile, so every tile can share one y scale. */
export function sharedMax(tiles: Tile[]): number {
  return Math.max(0, ...tiles.map((x) => Math.max(0, ...x.data)));
}

/**
 * One tile of the small multiples: an area in the project's own color on the shared scale, with no axes beyond a
 * faint baseline, so the tiles compare by shape and height alone.
 */
export function smallMultipleChart(tile: Tile, buckets: string[], opts: { dim: string; metric: "tokens" | "cost"; bucket: string; max: number }): EChartsOption {
  const c = chrome();
  const color = colorFor(opts.dim, tile.key);
  const fmt = (v: number) => metricValue(v, opts.metric);
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 2, right: 2, top: 4, bottom: 2 },
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        return `<div style="font-size:11px;opacity:.7;margin-bottom:2px">${escapeHtml(bucketLabel(buckets[i]!, opts.bucket))}</div><b style="font-variant-numeric:tabular-nums">${fmt(tile.data[i] ?? 0)}</b>`;
      },
    },
    xAxis: { type: "category", data: buckets, boundaryGap: false, axisLine: c.axisLine, axisTick: { show: false }, axisLabel: { show: false } },
    yAxis: { type: "value", min: 0, max: opts.max || 1, show: false },
    series: [{ type: "line", data: tile.data, color, showSymbol: false, smooth: 0.15, lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.14 }, emphasis: { disabled: true } }],
  };
}
