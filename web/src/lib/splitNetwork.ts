import { chrome, tooltipRows } from "./charts.ts";
import { colorFor, isColored } from "./colors.svelte.ts";
import type { EChartsOption } from "./echarts.ts";
import { percent } from "./format.ts";
import { t, tMaybe } from "./i18n.svelte.ts";
import { edgeToEdge, foldPairs, labelSides, OTHER, settle, type PairRow, type Point } from "./network.ts";
import { store } from "./state.svelte.ts";

/** Whoever asked their system for less motion gets the network without the pulses. */
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A color moved toward white by `k` (0 to 1): a light stands out on a fibre of its own color. */
function lighten(hex: string, k: number): string {
  if (!/^#[0-9a-f]{6}/i.test(hex)) return "#fff";
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v: number) => Math.round(v + (255 - v) * k);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** How many of the strongest fibres carry pulses: enough to feel alive, few enough to stay calm. */
const PULSES = 12;

/**
 * Network: the page's values and what they used (or were used by) as small glowing points, joined by fine curved
 * fibres, a fibre for every pair and as strong as its measure. Small lights travel along the strongest fibres. The
 * layout is worked out here (network.ts) so it stays inside the card, and pointing at a point lights up its fibres.
 * The page's side are filled points, the other side rings. The server keeps the biggest few of each side, the rest
 * is "Other".
 */
export function splitNetwork(rows: PairRow[], dim: string, by: string, fmt: (v: number) => string, width = 1000, height = 460): EChartsOption {
  const c = chrome();
  const narrow = width < 700;
  // Each side's "Other" says what it holds, as both sides have one.
  const otherOf = (d: string) => tMaybe(`chart.other.${d}`) ?? t("chart.other");
  const total = rows.reduce((a, r) => a + r.value, 0);
  const color = (d: string, key: string) => (key !== OTHER && isColored(d, key) ? colorFor(d, key) : c.data);
  const kept = foldPairs(rows, otherOf(by));

  const totals = (other: string, pick: (r: PairRow) => [string, string]) => {
    const m = new Map<string, { label: string; value: number }>();
    for (const r of kept) {
      const [k, label] = pick(r);
      m.set(k, { label: k === OTHER ? other : label, value: (m.get(k)?.value ?? 0) + r.value });
    }
    return m;
  };
  const own = totals(otherOf(dim), (r) => [r.key, r.label]);
  const theirs = totals(otherOf(by), (r) => [r.sub, r.subLabel]);
  const biggest = Math.max(1e-9, ...[...own.values(), ...theirs.values()].map((v) => v.value));
  const heaviest = Math.max(1e-9, ...kept.map((r) => r.value));
  // Points stay small, their size only a hint of the measure, so they never cover each other.
  const size = (v: number) => (narrow ? 5 : 6) + (narrow ? 9 : 14) * Math.sqrt(v / biggest);
  const strength = (v: number) => Math.sqrt(v / heaviest);

  const entries = [
    ...[...own.entries()].map(([k, v]) => ({ id: `a:${k}`, d: dim, k, v, filled: true })),
    ...[...theirs.entries()].map(([k, v]) => ({ id: `b:${k}`, d: by, k, v, filled: false })),
  ];
  const fibres = kept.map((r) => ({ source: `a:${r.key}`, target: `b:${r.sub}`, value: r.value, strength: strength(r.value) }));
  const points: Point[] = entries.map((e) => ({ id: e.id, x: 0, y: 0, r: size(e.v.value) / 2 }));
  // The fibres' bend. The lights' paths are worked out along the same curve, so they run exactly along the fibres.
  const CURVE = 0.25;
  settle(points, fibres, width, height, CURVE);
  const where = new Map(points.map((p) => [p.id, [p.x, p.y] as [number, number]]));
  // Each name goes on the side of its point where it crosses the fewest fibres and no other name. Its width is guessed
  // from its length at 11px, up to the width it is cut to. The biggest points' names are placed first: they are the
  // ones that show.
  const labelWidth = narrow ? 70 : 120;
  const sides = labelSides(
    points,
    new Map([...entries].sort((x, y) => y.v.value - x.v.value).map((e) => [e.id, { w: Math.min(labelWidth, e.v.label.length * 6.2), h: 14 }])),
    fibres,
    CURVE,
    width,
    height,
  );
  // On a light card a glow in the point's color only smudges it, so there it is a faint halo.
  const glow = store.dark ? 1 : 0.3;

  const nodes = entries.map((e) => {
    const tint = color(e.d, e.k);
    return {
      id: e.id,
      name: e.v.label,
      value: [...where.get(e.id)!, e.v.value],
      symbolSize: size(e.v.value),
      itemStyle: {
        // The page's side filled, the other side rings.
        ...(e.filled ? { color: tint } : { color: c.surface, borderColor: tint, borderWidth: 2 }),
        // The glow, in the point's own color.
        shadowBlur: (6 + 14 * Math.sqrt(e.v.value / biggest)) * glow,
        shadowColor: tint,
      },
      label: { show: e.v.value / biggest >= 0.08, position: sides.get(e.id) ?? "right", distance: 6, color: c.ink2 },
      emphasis: { label: { show: true, color: c.ink } },
    };
  });
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  const tintOf = new Map(entries.map((e) => [e.id, color(e.d, e.k)]));
  const links = fibres.map((f) => ({
    source: f.source,
    target: f.target,
    value: f.value,
    lineStyle: { width: 0.6 + 2.4 * f.strength, opacity: 0.18 + 0.4 * f.strength, curveness: CURVE },
  }));
  // Each light runs only between the bubbles' edges, so it appears as it leaves one and is gone as it touches the other.
  // A ring's edge is out by half its border.
  const edge = new Map(entries.map((e) => [e.id, size(e.v.value) / 2 + (e.filled ? 0.5 : 1.5)]));
  const pulsing = [...fibres]
    .sort((a, b) => b.value - a.value)
    .slice(0, PULSES)
    .map((f) => ({ ...f, path: edgeToEdge(where.get(f.source)!, where.get(f.target)!, CURVE, edge.get(f.source)!, edge.get(f.target)!) }))
    .filter((f) => f.path);

  return {
    animationDuration: 600,
    textStyle: c.text,
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: "value", min: 0, max: width, show: false },
    yAxis: { type: "value", min: 0, max: height, inverse: true, show: false },
    tooltip: {
      ...c.tooltip,
      trigger: "item",
      formatter: (p: { seriesType?: string; dataType?: string; data: { id?: string; source?: string; target?: string; value: number | number[] }; color: string }) => {
        if (p.seriesType !== "graph") return "";
        const v = Array.isArray(p.data.value) ? p.data.value[2]! : p.data.value;
        const share = `${fmt(v)} · ${percent(total ? v / total : 0, 1)}`;
        const head = p.dataType === "edge" ? `${names.get(p.data.source!)} › ${names.get(p.data.target!)}` : (names.get(p.data.id!) ?? "");
        return tooltipRows(head, [{ color: p.color, name: t("chart.splitOfAll"), value: share }]);
      },
    },
    series: [
      {
        type: "graph",
        coordinateSystem: "cartesian2d",
        data: nodes,
        links,
        label: { fontSize: 11, overflow: "truncate", width: labelWidth },
        labelLayout: { hideOverlap: true },
        lineStyle: { color: "source" },
        emphasis: { focus: "adjacency", lineStyle: { opacity: 0.9 }, label: { show: true } },
        blur: { itemStyle: { opacity: 0.25 }, lineStyle: { opacity: 0.05 }, label: { opacity: 0.3 } },
        z: 2,
      },
      {
        // The pulses: a light runs along each of the strongest fibres. No start delay: ECharts shows a waiting light
        // standing still at its start. The paths differ in length, so the lights fall out of step on their own.
        // The line itself is drawn by the graph above, so here it is invisible.
        type: "lines",
        coordinateSystem: "cartesian2d",
        // Each path is the fibre's curve between the edges, as points along it.
        polyline: true,
        silent: true,
        z: 3,
        effect: { show: !reducedMotion(), constantSpeed: narrow ? 50 : 70, trailLength: 0.15, symbol: "circle", symbolSize: 3 },
        // A light is a near white version of its fibre's color, bigger on a thicker fibre and glowing in the fibre's
        // color, so it shows on any fibre, the thickest included. On a light card near white would vanish, so there
        // it is the fibre's own color.
        data: pulsing.map((f) => {
          const tint = tintOf.get(f.source)!;
          return {
            coords: f.path!,
            lineStyle: { color: tint, opacity: 0 },
            effect: { color: store.dark ? lighten(tint, 0.7) : tint, symbolSize: 2.5 + 2.5 * f.strength, shadowBlur: (1 + 1.5 * f.strength) * glow, shadowColor: tint },
          };
        }),
      },
    ],
  } as EChartsOption;
}
