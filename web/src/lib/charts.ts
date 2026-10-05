import type { BreakdownRow, TimeSeries } from "./api.svelte.ts";
import { colorFor, cssVar, seqRamp } from "./colors.svelte.ts";
import type { EChartsOption } from "./echarts.ts";
import { bucketLabel, compact, metricValue, percent, usd } from "./format.ts";
import { t } from "./i18n.svelte.ts";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Shared chrome: recessive hairline grid, muted axis text, surface-colored tooltip. */
function chrome() {
  const ink = cssVar("--ink");
  const ink2 = cssVar("--ink-2");
  const muted = cssVar("--muted");
  const grid = cssVar("--grid");
  const axis = cssVar("--axis");
  const surface = cssVar("--surface");
  return {
    ink, ink2, muted, grid, axis, surface,
    text: { fontFamily: getComputedStyle(document.body).fontFamily, color: ink2, fontSize: 11 },
    tooltip: {
      backgroundColor: surface,
      borderColor: cssVar("--border"),
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: ink, fontSize: 12 },
      extraCssText: "border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.12);",
      confine: true,
    },
    axisLabel: { color: muted, fontSize: 11, hideOverlap: true },
    splitLine: { lineStyle: { color: grid, width: 1, type: "solid" as const } },
    axisLine: { lineStyle: { color: axis } },
  };
}

function lineKey(color: string): string {
  return `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color};margin-right:6px;vertical-align:middle"></span>`;
}

function tooltipRows(header: string, rows: { color: string; name: string; value: string }[], total?: string): string {
  const body = rows
    .map((r) => `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">${lineKey(r.color)}<b style="font-variant-numeric:tabular-nums">${r.value}</b><span style="opacity:.7">${escapeHtml(r.name)}</span></div>`)
    .join("");
  const foot = total ? `<div style="margin-top:4px;padding-top:4px;border-top:1px solid ${cssVar("--grid")}"><b>${total}</b> <span style="opacity:.7">${t("common.total")}</span></div>` : "";
  return `<div style="font-size:11px;opacity:.7;margin-bottom:2px">${escapeHtml(header)}</div>${body}${foot}`;
}

export function seriesLabel(dim: string, s: { key: string; name: string }): string {
  if (s.key === "__other__") return t("chart.other");
  if (dim === "type") return t(`tok.${s.key}` as "tok.input");
  return s.name;
}

/** Stacked columns over time (one series per entity), or a single area when there's one series. */
export function timeSeriesChart(
  ts: TimeSeries,
  opts: { dim: string; metric: "tokens" | "cost"; bucket: string; kind?: "bar" | "area"; valueKind?: "tokens" | "cost" },
): EChartsOption {
  const c = chrome();
  const valueKind = opts.valueKind ?? opts.metric;
  const kind = opts.kind ?? (ts.buckets.length > 60 ? "area" : "bar");
  const fmt = (v: number) => metricValue(v, valueKind);
  const labels = ts.series.map((s) => seriesLabel(opts.dim, s));
  const colors = ts.series.map((s) => colorFor(opts.dim, s.key));
  const single = ts.series.length === 1;

  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 12, top: single ? 12 : 40, bottom: 4, containLabel: true },
    legend: single
      ? undefined
      : { top: 0, left: 0, icon: kind === "bar" ? "roundRect" : undefined, itemWidth: 12, itemHeight: 8, textStyle: { color: c.ink2, fontSize: 12 }, data: labels },
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: kind === "bar" ? "shadow" : "line", lineStyle: { color: c.axis }, shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const rows = ts.series
          .map((s, si) => ({ color: colors[si]!, name: labels[si]!, raw: s.data[i] ?? 0, value: fmt(s.data[i] ?? 0) }))
          .filter((r) => r.raw > 0)
          .reverse();
        const total = ts.series.reduce((a, s) => a + (s.data[i] ?? 0), 0);
        return tooltipRows(bucketLabel(ts.buckets[i]!, opts.bucket), rows, rows.length > 1 ? fmt(total) : undefined);
      },
    },
    xAxis: {
      type: "category",
      data: ts.buckets.map((b) => bucketLabel(b, opts.bucket)),
      axisLine: c.axisLine,
      axisTick: { show: false },
      axisLabel: c.axisLabel,
      boundaryGap: kind === "bar",
    },
    yAxis: {
      type: "value",
      splitLine: c.splitLine,
      axisLabel: { ...c.axisLabel, formatter: (v: number) => fmt(v) },
    },
    series: ts.series.map((s, si) => ({
      name: labels[si],
      type: kind === "bar" ? "bar" : "line",
      stack: "total",
      data: s.data,
      color: colors[si],
      barMaxWidth: 24,
      showSymbol: false,
      symbolSize: 8,
      smooth: 0.15,
      lineStyle: { width: 2 },
      areaStyle: kind === "area" ? { opacity: single ? 0.12 : 0.1 } : undefined,
      itemStyle:
        kind === "bar"
          ? { borderColor: c.surface, borderWidth: 1, borderRadius: si === ts.series.length - 1 ? [4, 4, 0, 0] : 0 }
          : undefined,
      emphasis: { focus: "series" },
    })),
  };
}

/** Horizontal ranked bars for a breakdown (top N), value label at the bar tip. */
export function rankedBars(rows: BreakdownRow[], opts: { dim: string; metric: "tokens" | "cost"; limit?: number }): EChartsOption {
  const c = chrome();
  const data = rows.slice(0, opts.limit ?? 10).reverse();
  const val = (r: BreakdownRow) => (opts.metric === "cost" ? r.cost : r.tokens);
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 64, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { dataIndex: number }) => {
        const r = data[p.dataIndex]!;
        return tooltipRows(r.label, [
          { color: colorFor(opts.dim, r.key), name: t("col.cost"), value: usd(r.cost) },
          { color: colorFor(opts.dim, r.key), name: t("col.tokens"), value: compact(r.tokens) },
          { color: colorFor(opts.dim, r.key), name: t("col.share"), value: percent(opts.metric === "cost" ? r.share : r.tokenShare, 1) },
        ]);
      },
    },
    xAxis: { type: "value", show: false },
    yAxis: {
      type: "category",
      data: data.map((r) => r.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.ink2, fontSize: 12, width: 150, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        data: data.map((r) => ({ value: val(r), itemStyle: { color: colorFor(opts.dim, r.key) } })),
        barMaxWidth: 18,
        itemStyle: { borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: c.ink2, fontSize: 11, formatter: (p: { value: number }) => metricValue(p.value, opts.metric) },
      },
    ],
  };
}

/** Day-of-week × hour heatmap on the single-hue sequential ramp. */
export function weekHeatmap(cells: readonly (readonly [number, number, number, number])[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  const max = Math.max(1, ...cells.map((x) => x[2]));
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`dow.${d}` as "dow.0"));
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 8, top: 4, bottom: 28, containLabel: true },
    tooltip: {
      ...c.tooltip,
      formatter: (p: { value: [number, number, number, number] }) =>
        tooltipRows(`${days[p.value[1]]} ${String(p.value[0]).padStart(2, "0")}:00`, [
          { color: cssVar("--seq-5"), name: t(metric === "cost" ? "metric.cost" : "metric.tokens"), value: metricValue(p.value[2], metric) },
          { color: cssVar("--seq-5"), name: t("kpi.messages"), value: compact(p.value[3]) },
        ]),
    },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")), splitArea: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...c.axisLabel, interval: 2 } },
    yAxis: { type: "category", data: days, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: c.axisLabel },
    visualMap: { dimension: 2, min: 0, max, show: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, itemWidth: 10, calculable: false, inRange: { color: seqRamp().slice(0, 8) }, textStyle: { color: c.muted, fontSize: 10 }, formatter: (v: number) => metricValue(v, metric) },
    series: [{ type: "heatmap", data: cells.map((x) => [...x]), itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 3 }, emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 1 } } }],
  };
}

/** GitHub-style daily calendar. */
export function calendarHeatmap(days: { day: string; tokens: number; cost: number }[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  if (!days.length) return {};
  const val = (d: { tokens: number; cost: number }) => (metric === "cost" ? d.cost : d.tokens);
  const max = Math.max(1, ...days.map(val));
  const first = days[0]!.day;
  const last = days[days.length - 1]!.day;
  return {
    animationDuration: 300,
    textStyle: c.text,
    tooltip: {
      ...c.tooltip,
      formatter: (p: { value: [string, number] }) => tooltipRows(p.value[0], [{ color: cssVar("--seq-5"), name: t(metric === "cost" ? "metric.cost" : "metric.tokens"), value: metricValue(p.value[1], metric) }]),
    },
    visualMap: { show: false, min: 0, max, inRange: { color: seqRamp().slice(1, 8) } },
    calendar: {
      range: [first, last],
      top: 22,
      left: 32,
      right: 8,
      cellSize: ["auto", 14],
      splitLine: { show: false },
      itemStyle: { color: cssVar("--seq-0"), borderColor: c.surface, borderWidth: 3 },
      yearLabel: { show: false },
      dayLabel: { color: c.muted, fontSize: 10, firstDay: 1, nameMap: [0, 1, 2, 3, 4, 5, 6].map((d) => t(`dow.${(d + 6) % 7}` as "dow.0")) },
      monthLabel: { color: c.muted, fontSize: 10 },
    },
    series: [{ type: "heatmap", coordinateSystem: "calendar", data: days.map((d) => [d.day, val(d)]), itemStyle: { borderRadius: 3 } }],
  };
}

/** Generic matrix heatmap (tools × projects, tools × hour). */
export function matrixHeatmap(xs: string[], ys: string[], cells: readonly (readonly [number, number, number])[], valueLabel: string): EChartsOption {
  const c = chrome();
  const max = Math.max(1, ...cells.map((x) => x[2]));
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 24, top: 4, bottom: 28, containLabel: true },
    tooltip: {
      ...c.tooltip,
      formatter: (p: { value: [number, number, number] }) => tooltipRows(`${ys[p.value[1]]} · ${xs[p.value[0]]}`, [{ color: cssVar("--seq-5"), name: valueLabel, value: compact(p.value[2]) }]),
    },
    xAxis: { type: "category", data: xs, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...c.axisLabel, interval: 0, rotate: xs.some((x) => x.length > 3) && xs.length > 3 ? 30 : 0, width: 110, overflow: "truncate", hideOverlap: false } },
    yAxis: { type: "category", data: ys, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...c.axisLabel, width: 150, overflow: "truncate" } },
    visualMap: { dimension: 2, min: 0, max, show: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, itemWidth: 10, inRange: { color: seqRamp().slice(0, 8) }, textStyle: { color: c.muted, fontSize: 10 }, formatter: (v: number) => compact(v) },
    series: [{ type: "heatmap", data: cells.map((x) => [...x]), itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 3 } }],
  };
}

/** One line per series on a shared percentage axis (e.g. cache hit rate). */
export function percentLine(buckets: string[], values: (number | null)[], bucket: string, name: string): EChartsOption {
  const c = chrome();
  const color = cssVar("--series-3");
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 12, top: 12, bottom: 4, containLabel: true },
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        return tooltipRows(bucketLabel(buckets[i]!, bucket), [{ color, name, value: percent(values[i], 1) }]);
      },
    },
    xAxis: { type: "category", data: buckets.map((b) => bucketLabel(b, bucket)), axisLine: c.axisLine, axisTick: { show: false }, axisLabel: c.axisLabel, boundaryGap: false },
    yAxis: { type: "value", min: 0, max: 1, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => percent(v) } },
    series: [{ type: "line", data: values, color, connectNulls: false, showSymbol: false, symbolSize: 8, lineStyle: { width: 2 }, areaStyle: { opacity: 0.1 }, smooth: 0.15 }],
  };
}

/** Running total of a single series. */
export function cumulativeLine(ts: TimeSeries, metric: "tokens" | "cost", bucket: string): EChartsOption {
  const totals = ts.buckets.map((_, i) => ts.series.reduce((a, s) => a + (s.data[i] ?? 0), 0));
  let run = 0;
  const cum = totals.map((v) => (run += v));
  return timeSeriesChart({ buckets: ts.buckets, series: [{ key: "total", name: t("chart.cumulative"), data: cum }] }, { dim: "none", metric, bucket, kind: "area" });
}

/** Mini sparkline (no axes) for KPI tiles. */
export function sparkline(values: number[]): EChartsOption {
  const color = cssVar("--accent");
  return {
    animation: false,
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: "category", show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: "value", show: false, min: 0 },
    series: [{ type: "line", data: values, showSymbol: false, smooth: 0.2, lineStyle: { width: 2, color }, areaStyle: { color, opacity: 0.1 }, silent: true }],
  };
}

export interface CallRow {
  ts: number;
  model: string | null;
  agent?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Per-model-call columns (stacked by token type) — shows how context grows through a session/prompt. */
export function callTimeline(rows: CallRow[], metric: "tokens" | "cost", timeFmt: (ts: number) => string): EChartsOption {
  const c = chrome();
  const keys = ["input", "cacheRead", "cacheWrite", "output"] as const;
  const colors = keys.map((k) => colorFor("type", k));
  const names = keys.map((k) => t(`tok.${k}`));
  const isCost = metric === "cost";
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 12, top: isCost ? 12 : 40, bottom: rows.length > 80 ? 40 : 4, containLabel: true },
    legend: isCost ? undefined : { top: 0, left: 0, icon: "roundRect", itemWidth: 12, itemHeight: 8, textStyle: { color: c.ink2, fontSize: 12 }, data: names },
    dataZoom: rows.length > 80 ? [{ type: "slider", height: 18, bottom: 6, borderColor: "transparent", fillerColor: cssVar("--accent-wash"), textStyle: { color: c.muted } }, { type: "inside" }] : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const r = rows[params[0]?.dataIndex ?? 0]!;
        const header = `${timeFmt(r.ts)} · ${r.model ?? ""}${r.agent && r.agent !== "main" ? ` · ${r.agent}` : ""}`;
        const lines = keys.filter((k) => r[k] > 0).map((k, i) => ({ color: colors[keys.indexOf(k)]!, name: names[keys.indexOf(k)]!, value: compact(r[k]), i })).reverse();
        return tooltipRows(header, [...lines, { color: cssVar("--accent"), name: t("col.cost"), value: usd(r.cost) }]);
      },
    },
    xAxis: { type: "category", data: rows.map((r) => timeFmt(r.ts)), axisLine: c.axisLine, axisTick: { show: false }, axisLabel: c.axisLabel },
    yAxis: { type: "value", splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => (isCost ? usd(v, { compact: true }) : compact(v)) } },
    series: isCost
      ? [{ type: "bar", data: rows.map((r) => r.cost), color: cssVar("--accent"), barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } }]
      : keys.map((k, i) => ({
          name: names[i],
          type: "bar",
          stack: "t",
          data: rows.map((r) => r[k]),
          color: colors[i],
          barMaxWidth: 24,
          itemStyle: { borderColor: c.surface, borderWidth: rows.length > 150 ? 0 : 1, borderRadius: i === keys.length - 1 ? [4, 4, 0, 0] : 0 },
        })),
  };
}
