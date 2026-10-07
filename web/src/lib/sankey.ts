import { colorFor } from "./colors.svelte.ts";
import type { EChartsOption } from "./echarts.ts";
import { chrome, tooltipRows } from "./charts.ts";
import { entityLabel, percent } from "./format.ts";
import { t } from "./i18n.svelte.ts";

/** One provider × model × project sum, as /api/flow returns it. */
export interface FlowRow {
  provider: string;
  model: string;
  project: string;
  tokens: number;
  cost: number;
}

type Dim = "provider" | "model" | "project";
const COLUMNS: Dim[] = ["provider", "model", "project"];
/** How many models and projects get a node of their own, the rest of each column folds into "Other". */
const KEEP: Record<Dim, number> = { provider: 99, model: 6, project: 8 };
const OTHER = "__other__";

/** The label of a project's path is its folder name, like the rest of the dashboard. */
function nameOf(dim: Dim, key: string): string {
  if (key === OTHER) return t("chart.other");
  return entityLabel(dim, key, dim === "project" ? key.split(/[\\/]/).filter(Boolean).pop() ?? key : key);
}

/**
 * Sankey of the spend from harness to model to project. Each column keeps its biggest entries and folds the rest
 * into "Other", so a long tail doesn't turn into slivers.
 */
export function sankeyChart(rows: FlowRow[], metric: "tokens" | "cost", fmt: (v: number) => string): EChartsOption {
  const c = chrome();
  const val = (r: FlowRow) => r[metric];
  const kept = {} as Record<Dim, Set<string>>;
  for (const dim of COLUMNS) {
    const sums = new Map<string, number>();
    for (const r of rows) sums.set(r[dim], (sums.get(r[dim]) ?? 0) + val(r));
    const ranked = [...sums].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    // Folding a single entry into "Other" would only rename it.
    const keep = ranked.length > KEEP[dim] ? KEEP[dim] : ranked.length;
    kept[dim] = new Set(ranked.slice(0, keep).map(([k]) => k));
  }
  const fold = (dim: Dim, key: string) => (kept[dim].has(key) ? key : OTHER);
  const id = (dim: Dim, key: string) => `${dim}:${key}`;

  const nodes = new Map<string, { dim: Dim; key: string; value: number }>();
  const links = new Map<string, { source: string; target: string; value: number }>();
  let total = 0;
  for (const r of rows) {
    const v = val(r);
    if (v <= 0) continue;
    total += v;
    const keys = COLUMNS.map((d) => fold(d, r[d]));
    COLUMNS.forEach((dim, i) => {
      const n = nodes.get(id(dim, keys[i]!)) ?? { dim, key: keys[i]!, value: 0 };
      n.value += v;
      nodes.set(id(dim, keys[i]!), n);
    });
    for (const i of [0, 1]) {
      const source = id(COLUMNS[i]!, keys[i]!);
      const target = id(COLUMNS[i + 1]!, keys[i + 1]!);
      const l = links.get(`${source}>${target}`) ?? { source, target, value: 0 };
      l.value += v;
      links.set(`${source}>${target}`, l);
    }
  }
  total ||= 1;

  const color = (dim: Dim, key: string) => colorFor(dim, key);
  const label = (n: { dim: Dim; key: string }) => nameOf(n.dim, n.key);

  return {
    animationDuration: 300,
    textStyle: c.text,
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { dataType: string; value: number; data: { id?: string; dim?: Dim; key?: string; source?: string; target?: string } }) => {
        const d = p.data;
        const share = percent(p.value / total, 1);
        if (p.dataType === "edge") {
          const s = nodes.get(d.source!)!;
          const g = nodes.get(d.target!)!;
          return tooltipRows(`${label(s)} → ${label(g)}`, [{ color: color(g.dim, g.key), name: share, value: fmt(p.value) }]);
        }
        return tooltipRows(label(d as { dim: Dim; key: string }), [{ color: color(d.dim!, d.key!), name: share, value: fmt(p.value) }]);
      },
    },
    series: [
      {
        type: "sankey",
        left: 8,
        right: 110,
        top: 8,
        bottom: 8,
        nodeWidth: 12,
        nodeGap: 10,
        nodeAlign: "justify",
        draggable: false,
        layoutIterations: 32,
        emphasis: { focus: "adjacency" },
        lineStyle: { color: "gradient", opacity: 0.35, curveness: 0.5 },
        label: {
          color: c.ink2,
          fontSize: 11,
          overflow: "truncate",
          width: 100,
          formatter: (p: { data: { dim: Dim; key: string } }) => label(p.data),
        },
        data: [...nodes].map(([name, n]) => ({
          name,
          dim: n.dim,
          key: n.key,
          depth: COLUMNS.indexOf(n.dim),
          itemStyle: { color: color(n.dim, n.key), borderWidth: 0 },
        })),
        links: [...links.values()],
      },
    ],
  };
}
