import type { BreakdownRow, TimeSeries } from "./api.svelte.ts";
import { colorFor, cssVar, isColored, seqRamp } from "./colors.svelte.ts";
import type { EChartsOption } from "./echarts.ts";
import { bucketLabel, compact, entityLabel, integer, metricValue, percent, usd } from "./format.ts";
import { i18n, t } from "./i18n.svelte.ts";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Column width cap for time-series columns. */
const BAR_WIDTH = 36;
/** Surface-colored gap between the stacked parts of a column, and the least height of a part, in CSS pixels. */
const STACK_GAP = 2;
const STACK_MIN = 2;

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
    data: cssVar("--data"),
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

/**
 * Legends are drawn by Chart.svelte as an HTML row above the canvas, where long lists wrap without
 * running into the plot. The hidden ECharts legend stays so clicking an item can still toggle its series.
 */
export function htmlLegend(names: string[], colors?: string[], active?: string) {
  // Chart.svelte reads `colors` for entries that aren't an ECharts series of their own, and `active` for the
  // highlighted entry of a highlight-one chart.
  return { show: false, data: names, colors, active };
}

function lineKey(color: string): string {
  return `<span style="display:inline-block;width:10px;height:2px;border-radius:1px;background:${color};margin-right:6px;vertical-align:middle"></span>`;
}

type TooltipRow = { color: string; name: string; value: string };

function tooltipRow(r: TooltipRow): string {
  return `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">${lineKey(r.color)}<b style="font-variant-numeric:tabular-nums">${r.value}</b><span style="opacity:.7">${escapeHtml(r.name)}</span></div>`;
}

/**
 * The trend line drawn over a usage chart: the trailing average of a week of days, a month of weeks or a quarter of
 * months. Only once the chart has twice that many intervals, so the line smooths the bars rather than repeating them.
 */
export function trendAverage(bucket: string, intervals: number): { window: number; label: string } | undefined {
  const spans = { day: [7, "chart.movingAvg"], week: [4, "chart.movingAvgWeeks"], month: [3, "chart.movingAvgMonths"] } as const;
  const span = spans[bucket as keyof typeof spans];
  return span && intervals >= span[0] * 2 ? { window: span[0], label: t(span[1]) } : undefined;
}

/** Header, one row per series, then an optional total and reference rows (e.g. a moving average) below a rule. */
function tooltipRows(header: string, rows: TooltipRow[], total?: string, notes: TooltipRow[] = []): string {
  const body = rows.map(tooltipRow).join("");
  const sum = total ? `<div style="line-height:1.7"><b>${total}</b> <span style="opacity:.7">${t("common.total")}</span></div>` : "";
  const foot = sum || notes.length ? `<div style="margin-top:4px;padding-top:4px;border-top:1px solid ${cssVar("--grid")}">${sum}${notes.map(tooltipRow).join("")}</div>` : "";
  return `<div style="font-size:11px;opacity:.7;margin-bottom:2px">${escapeHtml(header)}</div>${body}${foot}`;
}

export function seriesLabel(dim: string, s: { key: string; name: string }): string {
  return entityLabel(dim, s.key, s.name);
}

/**
 * Series without a hue of their own (past the dimension's color slots) would all render the same gray as
 * "Other" and be indistinguishable from it, so they are summed into the "Other" series instead.
 */
function foldUncolored(ts: TimeSeries, dim: string): TimeSeries {
  if (dim === "type" || dim === "none") return ts;
  const keep = ts.series.filter((s) => s.key === "__other__" || isColored(dim, s.key));
  const fold = ts.series.filter((s) => !keep.includes(s));
  if (!fold.length) return ts;
  const other = ts.series.find((s) => s.key === "__other__");
  const data = ts.buckets.map((_, i) => fold.reduce((a, s) => a + (s.data[i] ?? 0), other?.data[i] ?? 0));
  return { ...ts, series: [...keep.filter((s) => s !== other), { key: "__other__", name: "other", data }] };
}

/** Columns up to 60 buckets; longer ranges are drawn as an area. */
export function timeSeriesKind(ts: TimeSeries, kind?: "bar" | "area"): "bar" | "area" {
  return kind ?? (ts.buckets.length > 60 ? "area" : "bar");
}

/**
 * Usage over time. Columns stack every series in its own colour, in series order (biggest at the base, "Other"
 * on top); legend entries switch series off. Long ranges draw the total as a neutral area with the highlighted
 * series as a line.
 */
export function timeSeriesChart(
  ts: TimeSeries,
  opts: {
    dim: string;
    metric: "tokens" | "cost";
    bucket: string;
    kind?: "bar" | "area";
    valueKind?: "tokens" | "cost";
    /** Adds a trailing moving average of the day's total, over this many buckets. */
    average?: { window: number; label: string };
    /** Label of the highlighted series; defaults to the biggest. */
    highlight?: string | null;
    /** Legend entries switched off: the average, and in columns any series. */
    hidden?: string[];
  },
): EChartsOption {
  const c = chrome();
  ts = foldUncolored(ts, opts.dim);
  const hidden = new Set(opts.hidden ?? []);
  const valueKind = opts.valueKind ?? opts.metric;
  const bar = timeSeriesKind(ts, opts.kind) === "bar";
  const fmt = (v: number) => metricValue(v, valueKind);
  const labels = ts.series.map((s) => seriesLabel(opts.dim, s));
  const colors = ts.series.map((s) => colorFor(opts.dim, s.key));
  const shown = ts.series.map((s, si) => ({ s, label: labels[si]!, color: colors[si]! }));
  const visible = bar ? shown.filter((x) => !hidden.has(x.label)) : shown;
  const totals = ts.buckets.map((_, i) => visible.reduce((a, x) => a + (x.s.data[i] ?? 0), 0));
  // Trailing average of the total. Inside long idle stretches it is left out (null) rather than drawn along the
  // baseline; the zero at each edge stays, so the line visibly runs down to 0 and climbs back from it.
  const rawAvg = opts.average
    ? totals.map((_, i) => {
        const win = totals.slice(Math.max(0, i - opts.average!.window + 1), i + 1);
        return win.reduce((a, b) => a + b, 0) / win.length;
      })
    : null;
  const avg = rawAvg?.map((v, i) => (v > 0 || (rawAvg[i - 1] ?? 0) > 0 || (rawAvg[i + 1] ?? 0) > 0 ? v : null)) ?? null;
  const legendNames = [...labels, ...(avg ? [opts.average!.label] : [])];
  const legendColors = [...colors, ...(avg ? [c.ink2] : [])];
  const showAvg = avg && !hidden.has(opts.average!.label);
  const hi = shown.find((x) => x.label === opts.highlight) ?? shown[0];
  // Daily columns are labelled once a week; denser axes fall back to overlap hiding.
  const labelEvery = opts.bucket === "day" && ts.buckets.length > 14 ? 6 : "auto";

  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
    legend: legendNames.length > 1 ? htmlLegend(legendNames, legendColors, !bar && shown.length > 1 ? hi?.label : undefined) : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: bar ? "shadow" : "line", lineStyle: { color: c.axis }, shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const rows = visible
          .map((x) => ({ color: x.color, name: x.label, raw: x.s.data[i] ?? 0, value: fmt(x.s.data[i] ?? 0) }))
          .filter((r) => r.raw > 0)
          .sort((a, b) => b.raw - a.raw);
        const notes = showAvg && avg?.[i] != null ? [{ color: c.ink2, name: opts.average!.label, value: fmt(avg[i]!) }] : [];
        const header = bucketLabel(ts.buckets[i]!, opts.bucket);
        if (!rows.length && !notes.length) return `<div style="font-size:11px;opacity:.7">${escapeHtml(header)}</div><div style="line-height:1.7;opacity:.7">${t("chart.noUsage")}</div>`;
        return tooltipRows(header, rows, rows.length > 1 ? fmt(rows.reduce((a, r) => a + r.raw, 0)) : undefined, notes);
      },
    },
    xAxis: {
      type: "category",
      data: ts.buckets.map((b) => bucketLabel(b, opts.bucket)),
      axisLine: c.axisLine,
      axisTick: { show: bar, alignWithLabel: true, interval: labelEvery, length: 4, lineStyle: { color: c.axis } },
      axisLabel: { ...c.axisLabel, interval: labelEvery, margin: 10 },
      boundaryGap: bar,
    },
    yAxis: {
      type: "value",
      splitNumber: 4,
      splitLine: c.splitLine,
      axisLabel: { ...c.axisLabel, formatter: (v: number) => fmt(v) },
    },
    series: [
      ...(bar
        ? [
            {
              // Columns are drawn here rather than as ECharts bars: every edge is snapped to a whole device pixel,
              // so stacked parts meet the gap between them on a hard line instead of an anti-aliased blend.
              type: "custom",
              name: "columns",
              data: totals.map((v, i) => [i, v]),
              encode: { x: 0, y: 1 },
              renderItem: (_: unknown, api: { value: (d: number) => number; coord: (p: number[]) => number[]; size: (p: number[]) => number[] }) => {
                const i = api.value(0);
                const parts = visible.filter((x) => (x.s.data[i] ?? 0) > 0);
                if (!parts.length) return null;
                const dpr = window.devicePixelRatio || 1;
                const snap = (v: number) => Math.round(v * dpr) / dpr;
                const w = snap(Math.min(BAR_WIDTH, api.size([1, 0])[0]! * 0.65));
                const x = snap(api.coord([i, 0])[0]! - w / 2);
                // Every part is at least STACK_MIN tall and set apart from the next by STACK_GAP. The room for both
                // comes out of the parts with height to spare, in proportion, so the column keeps its true total;
                // only a column too short to hold its parts grows past it.
                const gap = snap(STACK_GAP);
                const min = snap(STACK_MIN);
                const base = api.coord([i, 0])[1]!;
                const own = parts.map((p) => base - api.coord([i, p.s.data[i] ?? 0])[1]!);
                const heights = own.map((h) => Math.max(h, min));
                const spare = heights.map((h) => h - min);
                const spareSum = spare.reduce((a, b) => a + b, 0);
                const excess = heights.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) - own.reduce((a, b) => a + b, 0);
                const take = Math.min(Math.max(excess, 0), spareSum);
                // Edges are snapped from the running total, so rounding never piles up and every part keeps its least height.
                const children = [];
                let bottom = snap(base);
                let cum = 0;
                for (const [k, p] of parts.entries()) {
                  cum += heights[k]! - (spareSum > 0 ? (take * spare[k]!) / spareSum : 0);
                  const top = Math.min(snap(base - cum), bottom - min);
                  children.push({ type: "rect", shape: { x, y: top, width: w, height: bottom - top }, style: { fill: p.color } });
                  cum += gap;
                  bottom = top - gap;
                }
                return children.length ? { type: "group", children } : null;
              },
            },
          ]
        : [
            ...(shown.length > 1
              ? [{ name: t("common.total"), type: "line", data: totals, color: c.data, showSymbol: false, smooth: 0.15, lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.1 }, emphasis: { disabled: true } }]
              : []),
            ...(hi
              ? [{ name: hi.label, type: "line", data: hi.s.data, color: hi.color, showSymbol: false, smooth: 0.15, lineStyle: { width: 2 }, areaStyle: { opacity: shown.length === 1 ? 0.12 : 0.06 }, emphasis: { disabled: true } }]
              : []),
          ]),
      ...(showAvg
        ? [
            {
              name: opts.average!.label,
              type: "line",
              data: avg,
              color: c.ink2,
              // A reference, not data: dashed, no markers, and monotone smoothing so it never overshoots.
              lineStyle: { width: 1.5, type: "dashed", color: c.ink2 },
              showSymbol: false,
              smooth: 0.3,
              smoothMonotone: "x",
              z: 10,
              emphasis: { disabled: true },
            },
          ]
        : []),
    ],
  };
}

/**
 * Every cell of an x × y grid, zero-filled so empty slots still draw and rows and columns stay traceable.
 * Each cell gets one of seven steps of the sequential ramp (seq-1…seq-7), appended as its last dimension;
 * empty cells get step 0, the recessive seq-0 tile. HeatLegend renders the matching key.
 */
function heatSeries(xs: number, ys: number, cells: readonly (readonly number[])[], empty: number[]) {
  const max = heatMax(cells);
  const at = new Map(cells.map((c) => [`${c[0]}:${c[1]}`, c]));
  const data: number[][] = [];
  for (let y = 0; y < ys; y++) {
    for (let x = 0; x < xs; x++) {
      const c = at.get(`${x}:${y}`) ?? [x, y, ...empty];
      const v = c[2] ?? 0;
      data.push([...c, v > 0 ? 1 + Math.min(6, Math.floor((v / max) * 7)) : 0]);
    }
  }
  const stepDim = 2 + empty.length;
  const ramp = seqRamp();
  return { data, visualMap: { type: "piecewise", show: false, dimension: stepDim, pieces: ramp.map((color, step) => ({ value: step, color })) } };
}

export function heatMax(cells: readonly (readonly number[])[]): number {
  return Math.max(1e-9, ...cells.map((x) => x[2]!));
}

/** Day-of-week × hour heatmap on the single-hue sequential ramp. */
export function weekHeatmap(cells: readonly (readonly [number, number, number, number])[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => t(`dow.${d}` as "dow.0"));
  const heat = heatSeries(24, 7, cells, [0, 0]);
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 4, right: 4, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      ...c.tooltip,
      formatter: (p: { value: [number, number, number, number] }) =>
        tooltipRows(`${days[p.value[1]]} ${String(p.value[0]).padStart(2, "0")}:00`, [
          { color: cssVar("--seq-5"), name: t(metric === "cost" ? "metric.cost" : "metric.tokens"), value: metricValue(p.value[2], metric) },
          { color: cssVar("--seq-5"), name: t("kpi.messages"), value: compact(p.value[3]) },
        ]),
    },
    xAxis: { type: "category", data: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { ...c.axisLabel, interval: 2 } },
    yAxis: { type: "category", data: days, inverse: true, axisLine: { show: false }, axisTick: { show: false }, axisLabel: c.axisLabel },
    visualMap: heat.visualMap,
    series: [{ type: "heatmap", data: heat.data, itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: c.ink, borderWidth: 1 } } }],
  };
}

export interface PromptCost {
  cost: number;
  tokens: number;
  provider: string;
}

/** Band edges for the cost-per-prompt histogram: the bands below the first edge, between edges, and above the last. */
const PROMPT_BANDS = { cost: [0.1, 0.25, 0.5, 1, 2.5, 5, 10], tokens: [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000] };

/** How many prompts fall in each cost (or token) band, stacked by provider. */
export function promptHistogram(rows: PromptCost[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  const edges = PROMPT_BANDS[metric];
  // Bands are named by their upper limit, short enough that every one gets its label.
  const fmt = (v: number) => (metric === "cost" ? (Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`) : compact(v));
  const labels = [...edges.map((e) => `≤ ${fmt(e)}`), `> ${fmt(edges[edges.length - 1]!)}`];
  const band = (v: number) => {
    const i = edges.findIndex((e) => v < e);
    return i < 0 ? edges.length : i;
  };
  const providers = [...new Set(rows.map((r) => r.provider))];
  const counts = providers.map(() => labels.map(() => 0));
  for (const r of rows) counts[providers.indexOf(r.provider)]![band(metric === "cost" ? r.cost : r.tokens)]!++;
  // Biggest provider at the base, as in the other stacks.
  const order = providers.map((_, i) => i).sort((a, b) => counts[b]!.reduce((x, y) => x + y, 0) - counts[a]!.reduce((x, y) => x + y, 0));
  return {
    animationDuration: 500,
    textStyle: c.text,
    grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
    legend: providers.length > 1 ? htmlLegend(order.map((i) => providers[i]!), order.map((i) => colorFor("provider", providers[i]!))) : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const rowsAt = order
          .map((k) => ({ color: colorFor("provider", providers[k]!), name: providers[k]!, raw: counts[k]![i]!, value: compact(counts[k]![i]!) }))
          .filter((r) => r.raw > 0);
        const n = rowsAt.reduce((a, r) => a + r.raw, 0);
        return tooltipRows(labels[i]!, rowsAt, rowsAt.length > 1 ? t("prompts.nPrompts", { n: compact(n) }) : undefined);
      },
    },
    xAxis: { type: "category", data: labels, axisLine: c.axisLine, axisTick: { show: false }, axisLabel: { ...c.axisLabel, interval: 0, hideOverlap: false } },
    yAxis: { type: "value", splitNumber: 4, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => compact(v) } },
    series: order.map((k, j) => ({
      name: providers[k]!,
      type: "bar",
      stack: "prompts",
      data: counts[k],
      color: colorFor("provider", providers[k]!),
      barMaxWidth: 44,
      // A thin surface line between stacked parts; the top part gets the rounded corners.
      itemStyle: { borderColor: c.surface, borderWidth: 1, borderRadius: j === order.length - 1 ? [4, 4, 0, 0] : 0 },
      emphasis: { disabled: true },
    })),
  };
}

/**
 * Pareto curve: prompts from most to least expensive along x, the share of all cost they add up to along y.
 * The diagonal is an even spread; how far the curve bows above it is how concentrated the spend is.
 */
export function paretoChart(values: number[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  const sorted = [...values].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0) || 1;
  // At most ~200 points, always including the first and the last prompt.
  const step = Math.max(1, Math.floor(sorted.length / 200));
  const points: [number, number][] = [[0, 0]];
  let run = 0;
  sorted.forEach((v, i) => {
    run += v;
    if ((i + 1) % step === 0 || i === sorted.length - 1) points.push([((i + 1) / sorted.length) * 100, (run / total) * 100]);
  });
  const top10 = topShare(values, 0.1);
  const data = c.data;
  return {
    animationDuration: 700,
    textStyle: c.text,
    grid: { left: 4, right: 12, top: 16, bottom: 26, containLabel: true },
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { data: [number, number] }[]) => {
        const [x, y] = params[0]?.data ?? [0, 0];
        return tooltipRows(t("prompts.topPercent", { share: percent(x / 100, 0) }), [{ color: data, name: t(`metric.${metric}`), value: percent(y / 100, 0) }]);
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: 100,
      interval: 20,
      name: t("prompts.shareOfPrompts"),
      nameLocation: "middle",
      nameGap: 26,
      nameTextStyle: { color: c.muted, fontSize: 11 },
      axisLine: c.axisLine,
      axisTick: { show: false },
      splitLine: c.splitLine,
      axisLabel: { ...c.axisLabel, formatter: (v: number) => `${v}%` },
    },
    yAxis: { type: "value", min: 0, max: 100, interval: 25, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => `${v}%` } },
    series: [
      {
        type: "line",
        data: points,
        color: data,
        smooth: 0.2,
        showSymbol: false,
        lineStyle: { width: 2 },
        areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(data, 0.45) }, { offset: 1, color: withAlpha(data, 0.04) }] } },
        emphasis: { disabled: true },
        markLine: {
          silent: true,
          symbol: "none",
          lineStyle: { color: c.ink2, type: "dashed", width: 1 },
          label: { color: c.ink2, fontSize: 11 },
          data: [
            // The even spread, for reference.
            [{ coord: [0, 0], label: { show: false } }, { coord: [100, 100] }],
            { xAxis: 10, label: { formatter: `${percent(top10, 0)}`, position: "end" } },
          ],
        },
      },
    ],
  };
}

/** The share of the total that the largest `fraction` of the values make up. */
export function topShare(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const n = Math.max(1, Math.round(sorted.length * fraction));
  return sorted.slice(0, n).reduce((a, b) => a + b, 0) / total;
}

/** The value at a percentile (0–1) of the values. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** One line per series on a shared percentage axis (e.g. cache hit rate). */
export function percentLine(buckets: string[], values: (number | null)[], bucket: string, name: string): EChartsOption {
  const c = chrome();
  const color = colorFor("type", "cacheRead");
  // Rates cluster near the top, so the axis starts a step below the lowest value instead of at 0.
  const known = values.filter((v): v is number => v != null);
  const floor = known.length ? Math.max(0, Math.floor(Math.min(...known) * 10) / 10 - 0.1) : 0;
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
        return values[i] == null ? "" : tooltipRows(bucketLabel(buckets[i]!, bucket), [{ color, name, value: percent(values[i], 1) }]);
      },
    },
    xAxis: { type: "category", data: buckets.map((b) => bucketLabel(b, bucket)), axisLine: c.axisLine, axisTick: { show: false }, axisLabel: c.axisLabel, boundaryGap: false },
    yAxis: { type: "value", min: floor, max: 1, splitNumber: 4, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => percent(v) } },
    // Idle buckets have no rate: the line bridges them, and a dot marks each bucket that was measured.
    series: [{ type: "line", data: values, color, connectNulls: true, showSymbol: true, symbol: "circle", symbolSize: 6, itemStyle: { borderColor: c.surface, borderWidth: 1.5 }, lineStyle: { width: 2 }, smooth: 0.15 }],
  };
}

/**
 * One model metric day by day, over the range it usually spreads in (shaded band), with the recent window it is
 * judged on tinted and client updates marked as dashed lines.
 */
export function driftLine(o: {
  days: string[];
  values: (number | null)[];
  counts: number[];
  band: { lo: number; hi: number } | null;
  recentFrom: string;
  versions: { day: string; label: string }[];
  name: string;
  format: (v: number) => string;
  labels: { samples: string; usual: string; update: string; recent: string; baselineWindow: string; recentWindow: string };
}): EChartsOption {
  const c = chrome();
  const color = cssVar("--accent");
  const recentIdx = o.days.findIndex((d) => d >= o.recentFrom);
  const updates = new Map<string, string[]>();
  for (const v of o.versions) updates.set(v.day, [...(updates.get(v.day) ?? []), v.label]);
  const known = [...o.values.filter((v): v is number => v != null), ...(o.band ? [o.band.lo, o.band.hi] : [])];
  const lo = known.length ? Math.min(...known) : 0;
  const hi = known.length ? Math.max(...known) : 1;
  // Rounded to a step of 1, 2 or 5 × 10ⁿ so the axis labels stay even, also when shown as whole numbers.
  // A flat line (all zeros, say) still gets an axis at least one unit tall.
  const span = Math.max(hi - lo, 1);
  const pad = span * 0.1;
  const raw = (span + 2 * pad) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const extent = { min: Math.max(0, Math.floor((lo - pad) / step) * step), max: Math.ceil((hi + pad) / step) * step, step };
  const areas: unknown[] = [];
  if (o.band) areas.push([{ yAxis: o.band.lo, itemStyle: { color: withAlpha(color, 0.1) } }, { yAxis: o.band.hi }]);
  // Each window named at the top of the plot, so it's clear which days are compared with which.
  // Above the plot, clear of the update lines: the baseline's from its left edge, the recent window's centered.
  const windowLabel = (text: string, position: [number, number] | "top") => ({ show: true, position, distance: 4, color: c.muted, fontSize: 11, formatter: text });
  if (recentIdx > 0) areas.push([{ xAxis: 0, itemStyle: { color: "transparent" }, label: windowLabel(o.labels.baselineWindow, [0, -16]) }, { xAxis: recentIdx }]);
  if (recentIdx >= 0) areas.push([{ xAxis: recentIdx, itemStyle: { color: withAlpha(cssVar("--ink-2"), 0.1) }, label: windowLabel(o.labels.recentWindow, "top") }, { xAxis: o.days.length - 1 }]);
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 12, top: 24, bottom: 4, containLabel: true },
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const v = o.values[i];
        const notes: TooltipRow[] = [{ color: "transparent", name: o.labels.samples, value: integer(o.counts[i]) }];
        if (o.band) notes.push({ color: withAlpha(color, 0.35), name: o.labels.usual, value: `${o.format(o.band.lo)} – ${o.format(o.band.hi)}` });
        for (const u of updates.get(o.days[i]!) ?? []) notes.push({ color: c.muted, name: o.labels.update, value: u });
        const head = bucketLabel(o.days[i]!, "day") + (recentIdx >= 0 && i >= recentIdx ? ` · ${o.labels.recent}` : "");
        return tooltipRows(head, v == null ? [] : [{ color, name: o.name, value: o.format(v) }], undefined, notes);
      },
    },
    xAxis: { type: "category", data: o.days.map((d) => bucketLabel(d, "day")), axisLine: c.axisLine, axisTick: { show: false }, axisLabel: c.axisLabel, boundaryGap: false },
    // The axis spans the values and the usual range, so the band's edges stay in view.
    yAxis: { type: "value", min: extent.min, max: extent.max, interval: extent.step, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => o.format(v) } },
    series: [
      {
        type: "line",
        name: o.name,
        data: o.values,
        color,
        connectNulls: true,
        showSymbol: true,
        symbol: "circle",
        symbolSize: 5,
        itemStyle: { borderColor: c.surface, borderWidth: 1.5 },
        lineStyle: { width: 2 },
        smooth: 0.15,
        markArea: { silent: true, data: areas },
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color: c.muted, type: "dashed", width: 1 },
          data: [...updates.keys()].map((d) => ({ xAxis: o.days.indexOf(d) })).filter((d) => d.xAxis >= 0),
        },
      },
    ],
  };
}

/** Running total of a single series. */
/** A #rrggbb color with an alpha channel, for gradient fills. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * Running total over the range, stacked by a grouping: each series is a band in its own color over a soft
 * gradient, and one neutral line traces the overall total along the top. Bands carry no line of their own: a
 * band that is still empty would draw its line along the edge of the one below and take its color. The biggest
 * contributors sit at the base, "Other" on top; each one's running total is in its legend entry. The grid and the
 * day slots match timeSeriesChart's columns, so a day sits at the same x as in the usage chart above it.
 */
export function cumulativeChart(ts: TimeSeries, opts: { dim: string; metric: "tokens" | "cost"; bucket: string }): EChartsOption {
  const c = chrome();
  ts = foldUncolored(ts, opts.dim);
  const fmt = (v: number) => metricValue(v, opts.metric);
  const runs = ts.series.map((s) => {
    let run = 0;
    return ts.buckets.map((_, i) => (run += s.data[i] ?? 0));
  });
  const finals = runs.map((r) => r[r.length - 1] ?? 0);
  const isOther = (i: number) => ts.series[i]!.key === "__other__";
  const shown = ts.series
    .map((_, i) => i)
    .filter((i) => finals[i]! > 0)
    .sort((a, b) => Number(isOther(a)) - Number(isOther(b)) || finals[b]! - finals[a]!)
    .map((i) => {
      const label = seriesLabel(opts.dim, ts.series[i]!);
      // Legend entries name the series with its total; they toggle the series by this name.
      return { label, name: `${label} · ${fmt(finals[i]!)}`, color: colorFor(opts.dim, ts.series[i]!.key), run: runs[i]!, final: finals[i]! };
    });
  const labelEvery = opts.bucket === "day" && ts.buckets.length > 14 ? 6 : "auto";
  const total = ts.buckets.map((_, i) => shown.reduce((a, x) => a + (x.run[i] ?? 0), 0));

  return {
    animationDuration: 700,
    textStyle: c.text,
    grid: { left: 4, right: 8, top: 12, bottom: 4, containLabel: true },
    legend: shown.length > 1 ? htmlLegend(shown.map((x) => x.name), shown.map((x) => x.color)) : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const rows = shown
          .map((x) => ({ color: x.color, name: x.label, raw: x.run[i] ?? 0, value: fmt(x.run[i] ?? 0) }))
          .filter((r) => r.raw > 0)
          .sort((a, b) => b.raw - a.raw);
        return tooltipRows(bucketLabel(ts.buckets[i]!, opts.bucket), rows, rows.length > 1 ? fmt(rows.reduce((a, r) => a + r.raw, 0)) : undefined);
      },
    },
    xAxis: {
      type: "category",
      data: ts.buckets.map((b) => bucketLabel(b, opts.bucket)),
      boundaryGap: true,
      axisLine: c.axisLine,
      axisTick: { show: true, alignWithLabel: true, interval: labelEvery, length: 4, lineStyle: { color: c.axis } },
      axisLabel: { ...c.axisLabel, interval: labelEvery, margin: 10 },
    },
    yAxis: { type: "value", splitNumber: 4, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => fmt(v) } },
    series: [
      ...shown.map((x) => ({
      name: x.name,
      type: "line",
      stack: "cumulative",
      data: x.run,
      color: x.color,
      smooth: 0.3,
      smoothMonotone: "x",
      showSymbol: false,
      lineStyle: { width: 0 },
      areaStyle: {
        color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(x.color, 0.85) }, { offset: 1, color: withAlpha(x.color, 0.25) }] },
      },
      emphasis: { focus: "series" },
      })),
      ...(shown.length > 1
        ? [{ name: t("common.total"), type: "line", data: total, color: c.ink2, smooth: 0.3, smoothMonotone: "x", showSymbol: false, lineStyle: { width: 1.5 }, emphasis: { disabled: true }, z: 5 }]
        : []),
    ],
  };
}

export type RateKind = "area" | "bars" | "lines" | "dots" | "steps" | "total";

/**
 * Tokens per minute over the last minutes, live, drawn six ways:
 *  - "area": a band per provider stacked over a soft gradient, under a neutral line along the total
 *  - "bars": a stacked column per minute
 *  - "lines": each provider on its own line
 *  - "dots": a dot per provider and minute with use, like a dotted trace
 *  - "steps": stacked steps that hold each minute's value flat, as it was counted
 *  - "total": the running total over the window, stacked by provider
 * A pulsing point marks the latest minute. Minutes without use are zero, so quiet stretches drop to the floor.
 */
export function rateChart(series: { key: string; data: number[] }[], from: number, kind: RateKind = "area"): EChartsOption {
  const c = chrome();
  const minutes = series[0]?.data.length ?? 0;
  const time = new Intl.DateTimeFormat(i18n.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const labels = Array.from({ length: minutes }, (_, i) => time.format(from + i * 60_000));
  // The running total adds each minute to the ones before: the same stacks, counted up.
  const values = (data: number[]) => {
    if (kind !== "total") return data;
    let run = 0;
    return data.map((v) => (run += v));
  };
  const shown = series
    .map((s) => ({ key: s.key, data: values(s.data), label: entityLabel("provider", s.key, s.key), color: colorFor("provider", s.key), sum: s.data.reduce((a, v) => a + v, 0) }))
    .filter((s) => s.sum > 0)
    .sort((a, b) => b.sum - a.sum);
  const total = labels.map((_, i) => shown.reduce((a, s) => a + (s.data[i] ?? 0), 0));
  const fmt = (v: number) => (kind === "total" ? compact(v) : `${compact(v)}/min`);
  const gradient = (color: string, top: number, bottom: number) => ({
    color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(color, top) }, { offset: 1, color: withAlpha(color, bottom) }] },
  });
  const seriesOf = (s: (typeof shown)[number]) => {
    const base = { name: s.label, data: s.data, color: s.color, emphasis: { focus: "series" } };
    switch (kind) {
      case "bars":
        // A surface-colored edge keeps a gap between stacked segments, as in the other stacked bars.
        return { ...base, type: "bar", stack: "rate", barMaxWidth: 14, barCategoryGap: "30%", itemStyle: { borderColor: c.surface, borderWidth: 1, borderRadius: 2 } };
      case "lines":
        return { ...base, type: "line", smooth: 0.25, smoothMonotone: "x", showSymbol: false, lineStyle: { width: 2 } };
      case "dots":
        // Quiet minutes have no dot, so the trace shows where the work was.
        return { ...base, type: "scatter", data: s.data.map((v) => (v > 0 ? v : null)), symbolSize: 6 };
      case "steps":
        return { ...base, type: "line", stack: "rate", step: "middle", showSymbol: false, lineStyle: { width: 1.5 }, areaStyle: gradient(s.color, 0.45, 0.06) };
      default:
        return { ...base, type: "line", stack: "rate", smooth: 0.25, smoothMonotone: "x", showSymbol: false, lineStyle: { width: 0 }, areaStyle: gradient(s.color, 0.8, kind === "total" ? 0.3 : 0.15) };
    }
  };
  const stacked = kind === "area" || kind === "bars" || kind === "steps" || kind === "total";
  return {
    animationDuration: 500,
    textStyle: c.text,
    grid: { left: 4, right: 12, top: 12, bottom: 4, containLabel: true },
    legend: shown.length > 1 ? htmlLegend(shown.map((s) => s.label), shown.map((s) => s.color)) : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: c.axis } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        const rows = shown.map((s) => ({ color: s.color, name: s.label, raw: s.data[i] ?? 0, value: fmt(s.data[i] ?? 0) })).filter((r) => r.raw > 0);
        return tooltipRows(labels[i]!, rows, rows.length > 1 ? fmt(total[i]!) : undefined);
      },
    },
    xAxis: {
      type: "category",
      data: labels,
      boundaryGap: kind === "bars" || kind === "dots",
      axisLine: c.axisLine,
      axisTick: { show: false },
      axisLabel: { ...c.axisLabel, margin: 10 },
    },
    yAxis: { type: "value", splitNumber: 4, splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => compact(v) } },
    series: [
      ...shown.map(seriesOf),
      ...(kind === "area" || kind === "total"
        ? [{ name: t("common.total"), type: "line", data: total, color: c.ink2, smooth: 0.25, smoothMonotone: "x", showSymbol: false, lineStyle: { width: 1.5 }, emphasis: { disabled: true }, z: 5 }]
        : []),
      {
        name: "now",
        type: "effectScatter",
        // On the top of the stack where there is one, on the busiest provider otherwise.
        data: minutes ? [[minutes - 1, stacked ? (total[minutes - 1] ?? 0) : (shown[0]?.data[minutes - 1] ?? 0)]] : [],
        symbolSize: 7,
        color: shown[0]?.color ?? c.ink2,
        rippleEffect: { scale: 3, brushType: "stroke" },
        tooltip: { show: false },
        silent: true,
        z: 6,
      },
    ],
  };
}

/**
 * Mini column chart for KPI tiles: one bar per bucket on a visible baseline, with the first and last
 * bucket labelled so the period it covers is readable at a glance.
 */
export function sparkBars(values: number[], labels: string[], name: string, fmt: (v: number) => string): EChartsOption {
  const c = chrome();
  const color = cssVar("--data");
  const last = values.length - 1;
  return {
    animation: false,
    textStyle: c.text,
    grid: { left: 0, right: 0, top: 2, bottom: 18 },
    tooltip: {
      ...c.tooltip,
      confine: false,
      appendTo: "body",
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.12)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const i = params[0]?.dataIndex ?? 0;
        return tooltipRows(labels[i] ?? "", [{ color, name, value: fmt(values[i] ?? 0) }]);
      },
    },
    xAxis: {
      type: "category",
      data: labels,
      axisLine: c.axisLine,
      axisTick: { show: false },
      axisLabel: { color: c.muted, fontSize: 10, margin: 6, hideOverlap: false, interval: (i: number) => i === 0 || i === last, alignMinLabel: "left", alignMaxLabel: "right" },
    },
    yAxis: { type: "value", show: false, min: 0 },
    series: [{ type: "bar", data: values.map((v) => v || null), color, barCategoryGap: "30%", itemStyle: { borderRadius: [2, 2, 0, 0] } }],
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
  // Same bottom-up order as the token-type series, so stacks and colors match the overview.
  const keys = ["cacheRead", "cacheWrite", "input", "output"] as const;
  const colors = keys.map((k) => colorFor("type", k));
  const names = keys.map((k) => t(`tok.${k}`));
  const isCost = metric === "cost";
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 8, right: 12, top: 12, bottom: rows.length > 80 ? 40 : 4, containLabel: true },
    legend: isCost ? undefined : htmlLegend(names),
    dataZoom: rows.length > 80 ? [{ type: "slider", height: 18, bottom: 6, borderColor: "transparent", fillerColor: cssVar("--accent-wash"), textStyle: { color: c.muted } }, { type: "inside" }] : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow", shadowStyle: { color: "rgba(127,127,127,0.08)" } },
      formatter: (params: { dataIndex: number }[]) => {
        const r = rows[params[0]?.dataIndex ?? 0]!;
        const header = `${timeFmt(r.ts)} · ${r.model ?? ""}${r.agent && r.agent !== "main" ? ` · ${r.agent}` : ""}`;
        const lines = keys.filter((k) => r[k] > 0).map((k, i) => ({ color: colors[keys.indexOf(k)]!, name: names[keys.indexOf(k)]!, value: compact(r[k]), i })).reverse();
        return tooltipRows(header, [...lines, { color: cssVar("--data"), name: t("col.cost"), value: usd(r.cost) }]);
      },
    },
    xAxis: { type: "category", data: rows.map((r) => timeFmt(r.ts)), axisLine: c.axisLine, axisTick: { show: false }, axisLabel: c.axisLabel },
    yAxis: { type: "value", splitLine: c.splitLine, axisLabel: { ...c.axisLabel, formatter: (v: number) => (isCost ? usd(v, { compact: true }) : compact(v)) } },
    series: isCost
      ? [{ type: "bar", data: rows.map((r) => r.cost), color: cssVar("--data"), barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } }]
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

export interface ShareItem {
  key: string;
  label: string;
  value: number;
}

/** Breakdown rows as share items for donuts and treemaps; the detail line carries the metric not shown. */
export function breakdownItems(rows: BreakdownRow[], dim: string, metric: "tokens" | "cost"): (ShareItem & { detail: string; detailMore: string })[] {
  return rows.map((r) => ({
    key: r.key,
    label: entityLabel(dim, r.key, r.label),
    value: metric === "cost" ? r.cost : r.tokens,
    detail: metric === "cost" ? t("common.tokensN", { n: compact(r.tokens) }) : usd(r.cost),
    detailMore: t("common.sessionsN", { n: compact(r.sessions) }),
  }));
}

/** Keeps the first `max - 1` items and folds the rest into one "Other" item, so the tail doesn't turn into slivers. */
export function topWithOther<T extends ShareItem>(items: T[], max: number): ShareItem[] {
  if (items.length <= max) return items;
  const rest = items.slice(max - 1).reduce((a, i) => a + i.value, 0);
  return [...items.slice(0, max - 1), { key: "__other__", label: t("chart.other"), value: rest }];
}

/** Black or white, whichever reads better on a filled tile (WCAG relative luminance). */
function inkOn(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return "#ffffff";
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? "#ffffff" : "#0b0b0b";
}

/** Donut for parts of a whole; DonutList puts the total in the hole and the legend beside it. */
export function donutChart(items: ShareItem[], dim: string, fmt: (v: number) => string): EChartsOption {
  const c = chrome();
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  return {
    animationDuration: 300,
    textStyle: c.text,
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { dataIndex: number }) => {
        const it = items[p.dataIndex]!;
        return tooltipRows(it.label, [{ color: colorFor(dim, it.key), name: percent(it.value / total, 1), value: fmt(it.value) }]);
      },
    },
    series: [
      {
        type: "pie",
        radius: ["68%", "94%"],
        padAngle: 1.5,
        minAngle: 3,
        itemStyle: { borderRadius: 4 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 3 },
        data: items.map((it) => ({ name: it.label, value: it.value, key: it.key, itemStyle: { color: colorFor(dim, it.key) } })),
      },
    ],
  };
}

/** Treemap: each tile's area is its share, so a long tail of small items stays readable next to the big ones. */
/** `total` is what shares are of; it defaults to the items' sum, and is larger when only the top items are drawn. */
export function treemapChart(items: ShareItem[], dim: string, fmt: (v: number) => string, total = items.reduce((a, i) => a + i.value, 0) || 1): EChartsOption {
  const c = chrome();
  return {
    animationDuration: 300,
    textStyle: c.text,
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { name: string; value: number; data: { key: string } }) =>
        tooltipRows(p.name, [{ color: colorFor(dim, p.data.key), name: percent(p.value / total, 1), value: fmt(p.value) }]),
    },
    series: [
      {
        type: "treemap",
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        itemStyle: { borderColor: c.surface, borderWidth: 2, gapWidth: 2, borderRadius: 6 },
        emphasis: { itemStyle: { borderColor: c.ink } },
        label: {
          show: true,
          position: "insideTopLeft",
          padding: [7, 9],
          overflow: "truncate",
          formatter: (p: { name: string; value: number }) => `{name|${p.name}}\n{value|${fmt(p.value)} · ${percent(p.value / total, p.value / total < 0.1 ? 1 : 0)}}`,
          rich: { name: { fontSize: 12, fontWeight: 600, lineHeight: 17 }, value: { fontSize: 11, lineHeight: 15, opacity: 0.8 } },
        },
        data: items.map((it) => {
          const color = colorFor(dim, it.key);
          return { name: it.label, value: it.value, key: it.key, itemStyle: { color }, label: { color: inkOn(color) } };
        }),
      },
    ],
  };
}

export interface SessionPoint {
  id: string;
  title: string;
  project: string;
  provider: string;
  cost: number;
  tokens: number;
  messages: number;
  prompts: number;
}

/**
 * One bubble per session: model calls across, spend up, bubble size = prompts. Both axes are logarithmic
 * because sessions span several orders of magnitude; outliers end up top right.
 */
export function sessionScatter(rows: SessionPoint[], metric: "tokens" | "cost"): EChartsOption {
  const c = chrome();
  const val = (r: SessionPoint) => (metric === "cost" ? r.cost : r.tokens);
  const points = rows.filter((r) => val(r) > 0 && r.messages > 0);
  const providers = [...new Set(points.map((r) => r.provider))];
  const maxPrompts = Math.max(1, ...points.map((r) => r.prompts));
  const fmt = (v: number) => metricValue(v, metric);
  return {
    animationDuration: 300,
    textStyle: c.text,
    grid: { left: 26, right: 16, top: 12, bottom: 30, containLabel: true },
    legend: providers.length > 1 ? htmlLegend(providers) : undefined,
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { color: string; data: { row: SessionPoint } }) => {
        const r = p.data.row;
        return tooltipRows(`${r.title} · ${r.project}`, [
          { color: p.color, name: t(metric === "cost" ? "metric.cost" : "metric.tokens"), value: fmt(val(r)) },
          { color: p.color, name: t("kpi.messages"), value: compact(r.messages) },
          { color: p.color, name: t("col.prompts"), value: compact(r.prompts) },
        ]);
      },
    },
    // Both axes alike: titled, the same axis line and grid, no ticks; log steps are whole numbers ($1, $10, $100).
    xAxis: {
      type: "log",
      name: t("kpi.messages"),
      nameLocation: "middle",
      nameGap: 28,
      nameTextStyle: { color: c.muted, fontSize: 11 },
      axisLine: c.axisLine,
      axisTick: { show: false },
      splitLine: c.splitLine,
      axisLabel: { ...c.axisLabel, formatter: (v: number) => compact(v) },
    },
    yAxis: {
      type: "log",
      name: t(metric === "cost" ? "metric.cost" : "metric.tokens"),
      nameLocation: "middle",
      nameGap: 40,
      nameRotate: 90,
      nameTextStyle: { color: c.muted, fontSize: 11 },
      axisLine: c.axisLine,
      axisTick: { show: false },
      splitLine: c.splitLine,
      axisLabel: { ...c.axisLabel, formatter: (v: number) => (metric === "cost" ? `$${compact(v)}` : compact(v)) },
    },
    series: providers.map((provider) => ({
      name: provider,
      type: "scatter",
      color: colorFor("provider", provider),
      data: points
        .filter((r) => r.provider === provider)
        .map((r) => ({ value: [r.messages, val(r)], symbolSize: 6 + 22 * Math.sqrt(r.prompts / maxPrompts), row: r })),
      itemStyle: { opacity: 0.7, borderColor: c.surface, borderWidth: 1 },
      emphasis: { scale: 1.25, itemStyle: { opacity: 1 } },
    })),
  };
}
