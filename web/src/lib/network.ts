/**
 * The "who used what" network on the breakdown pages, without colors or text: the pairs it shows and where each point
 * goes. Kept apart from the chart so it can be tested on its own (splitNetwork.ts draws it).
 */

/** One pair of a dimension and the second one it is split by, with its measure (/api/breakdown/pairs). */
export interface PairRow {
  key: string;
  label: string;
  sub: string;
  subLabel: string;
  value: number;
}

/** What each breakdown page is split by: who used what, from the page's side. */
export const SPLIT_BY: Record<string, string> = { project: "model", model: "project", provider: "model", user: "project", skill: "project", agent: "project" };

/** The key the server sums the rest into. */
export const OTHER = "__other__";

/**
 * The pairs to draw: one too small for a fibre of its own (under half a percent of the total) joins its row's "Other"
 * on the far side, so the amounts all stay and there are fewer, clearer fibres.
 */
export function foldPairs(rows: PairRow[], otherLabel: string): PairRow[] {
  const total = rows.reduce((a, r) => a + r.value, 0);
  const least = total * 0.005;
  const pairs = new Map<string, PairRow>();
  for (const r of rows) {
    const sub = r.value < least && r.sub !== OTHER ? OTHER : r.sub;
    const at = `${r.key}\u0000${sub}`;
    const p = pairs.get(at) ?? { ...r, sub, subLabel: sub === OTHER ? otherLabel : r.subLabel, value: 0 };
    p.value += r.value;
    pairs.set(at, p);
  }
  return [...pairs.values()];
}

/** The gap a point keeps from a fibre that isn't its own, past its edge. */
export const FIBRE_GAP = 6;

export interface Point {
  id: string;
  x: number;
  y: number;
  /** The point's radius, to keep others clear of it. */
  r: number;
}

/**
 * Where each point goes: a small force layout that keeps everything inside the box (with room on the right for the
 * labels) and comes out the same every time. Points push each other apart and never overlap, fibres pull their ends
 * together, a point is pushed off any fibre that isn't its own (drawn with `curveness`, as ECharts bends it), and a
 * light pull keeps the whole near the middle, weaker sideways so it spreads along the wide card.
 */
export function settle(
  points: Point[],
  links: { source: string; target: string; strength: number }[],
  width: number,
  height: number,
  curveness = 0,
): void {
  const pad = 24;
  const left = pad;
  const right = Math.max(left + 100, width - 130);
  const top = pad;
  const bottom = Math.max(top + 100, height - pad);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  // A deterministic start: around an ellipse, in order.
  points.forEach((p, i) => {
    const a = (i / points.length) * Math.PI * 2;
    p.x = cx + Math.cos(a) * (right - left) * 0.35;
    p.y = cy + Math.sin(a) * (bottom - top) * 0.35;
  });
  const at = new Map(points.map((p) => [p.id, p]));
  const rest = Math.min(right - left, (bottom - top) * 2) / 4;
  const STEPS = 400;
  for (let step = 0; step < STEPS; step++) {
    const cool = 1 - step / STEPS;
    const move = new Map(points.map((p) => [p.id, [0, 0] as [number, number]]));
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i]!;
        const b = points[j]!;
        let x = a.x - b.x;
        let y = a.y - b.y;
        let d = Math.hypot(x, y);
        if (d < 0.01) [x, y, d] = [1, 0, 1];
        const push = (rest * rest) / (d * d) + (d < a.r + b.r + 28 ? 4 : 0);
        const ma = move.get(a.id)!;
        const mb = move.get(b.id)!;
        ma[0] += (x / d) * push;
        ma[1] += (y / d) * push;
        mb[0] -= (x / d) * push;
        mb[1] -= (y / d) * push;
      }
    }
    for (const l of links) {
      const a = at.get(l.source)!;
      const b = at.get(l.target)!;
      const x = b.x - a.x;
      const y = b.y - a.y;
      const d = Math.max(0.01, Math.hypot(x, y));
      const pull = ((d - rest) / d) * 0.05 * (0.4 + l.strength);
      const ma = move.get(a.id)!;
      const mb = move.get(b.id)!;
      ma[0] += x * pull;
      ma[1] += y * pull;
      mb[0] -= x * pull;
      mb[1] -= y * pull;
    }
    for (const p of points) {
      const [dx, dy] = move.get(p.id)!;
      const mx = dx + (cx - p.x) * 0.01;
      const my = dy + (cy - p.y) * 0.02;
      const m = Math.hypot(mx, my);
      const cap = 12 * cool + 0.5;
      p.x = Math.min(right, Math.max(left, p.x + (m > cap ? (mx / m) * cap : mx)));
      p.y = Math.min(bottom, Math.max(top, p.y + (m > cap ? (my / m) * cap : my)));
    }
  }
  // Then a point that sits on someone else's fibre, and so looks joined to it, is moved off: away from the nearest
  // part of the curve until there is a clear gap, in small steps that keep points apart. Moving a point moves its own
  // fibres too, so this goes round until nothing changes.
  for (let round = 0; round < 120; round++) {
    let moved = false;
    for (const l of links) {
      const a = at.get(l.source)!;
      const b = at.get(l.target)!;
      const along = curve([a.x, a.y], [b.x, b.y], curveness);
      const marks = Array.from({ length: 33 }, (_, i) => along(i / 32));
      for (const p of points) {
        if (p === a || p === b) continue;
        let [nx, ny, nd] = [0, 0, Infinity];
        for (let i = 0; i < 32; i++) {
          // The nearest spot on each stretch between two samples.
          const [x0, y0] = marks[i]!;
          const [x1, y1] = marks[i + 1]!;
          const [sx, sy] = [x1 - x0, y1 - y0];
          const len = sx * sx + sy * sy || 1;
          const t = Math.min(1, Math.max(0, ((p.x - x0) * sx + (p.y - y0) * sy) / len));
          const [qx, qy] = [x0 + sx * t, y0 + sy * t];
          const d = Math.hypot(p.x - qx, p.y - qy);
          if (d < nd) [nx, ny, nd] = [qx, qy, d];
        }
        const clear = p.r + FIBRE_GAP;
        if (nd >= clear) continue;
        // Exactly on the curve: off to one side, the same side every time.
        const [ux, uy] = nd < 0.01 ? [0, 1] : [(p.x - nx) / nd, (p.y - ny) / nd];
        const step = Math.min(2, clear - nd);
        const x = Math.min(right, Math.max(left, p.x + ux * step));
        const y = Math.min(bottom, Math.max(top, p.y + uy * step));
        // Never onto another point.
        if (points.some((q) => q !== p && Math.hypot(q.x - x, q.y - y) < q.r + p.r + 4)) continue;
        if (x !== p.x || y !== p.y) [p.x, p.y, moved] = [x, y, true];
      }
    }
    if (!moved) break;
  }
}

/** The curve ECharts draws for a fibre between two centers, as a point at `t` (0 to 1) along it. */
function curve(p0: [number, number], p1: [number, number], curveness: number): (t: number) => [number, number] {
  const c: [number, number] = [(p0[0] + p1[0]) / 2 - (p0[1] - p1[1]) * curveness, (p0[1] + p1[1]) / 2 - (p1[0] - p0[0]) * curveness];
  return (t) => [
    (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0],
    (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1],
  ];
}

/**
 * The stretch of a fibre between two bubbles' edges, as points along it: the fibre is the curve ECharts draws between
 * the centers (a quadratic bend of `curveness`, the same formula as its graph and lines series), cut where it leaves
 * the first bubble (radius r0) and where it enters the second (r1). A light that runs along it starts and ends at the
 * edges instead of inside the bubbles. Null when the bubbles touch and nothing is left between them.
 */
export function edgeToEdge(p0: [number, number], p1: [number, number], curveness: number, r0: number, r1: number, samples = 24): [number, number][] | null {
  const at = curve(p0, p1, curveness);
  // Where the curve crosses a circle around one end: the distance from that end only grows along the curve's first
  // stretch, so halving the interval finds it.
  const cross = (end: [number, number], r: number, from: number, to: number) => {
    let [lo, hi] = [from, to];
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      const [x, y] = at(mid);
      if (Math.hypot(x - end[0], y - end[1]) < r) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  // Bubbles so close that the curve's middle is inside one of them leave nothing to run along.
  const [mx, my] = at(0.5);
  if (Math.hypot(mx - p0[0], my - p0[1]) <= r0 || Math.hypot(mx - p1[0], my - p1[1]) <= r1) return null;
  const t0 = cross(p0, r0, 0, 0.5);
  const t1 = cross(p1, r1, 1, 0.5);
  if (t1 - t0 <= 0.02) return null;
  return Array.from({ length: samples + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / samples));
}

export type LabelSide = "right" | "left" | "top" | "bottom";

/**
 * Where each point's name goes: of right, left, above and below, the side its name crosses the fewest fibres on, and
 * no other point or name. A name has to fit in the card. Right wins a tie, so most names read on from their point.
 * `labels` holds each name's width and height in pixels, in the order they are placed: a name placed earlier keeps
 * its spot and later ones go around it, so the names that show come first.
 */
export function labelSides(
  points: Point[],
  labels: Map<string, { w: number; h: number }>,
  links: { source: string; target: string; strength: number }[],
  curveness: number,
  width: number,
  height: number,
  gap = 6,
): Map<string, LabelSide> {
  const at = new Map(points.map((p) => [p.id, p]));
  // Each fibre as points along it, every few pixels, weighed by how thick it is drawn.
  const marks: { x: number; y: number; w: number }[] = [];
  for (const l of links) {
    const a = at.get(l.source);
    const b = at.get(l.target);
    if (!a || !b) continue;
    const along = curve([a.x, a.y], [b.x, b.y], curveness);
    const n = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let i = 0; i <= n; i++) {
      const [x, y] = along(i / n);
      marks.push({ x, y, w: 1 + l.strength });
    }
  }
  const sides: LabelSide[] = ["right", "left", "top", "bottom"];
  const out = new Map<string, LabelSide>();
  // The names placed so far, a little bigger than they are, so two names never quite touch.
  const placed: [number, number, number, number][] = [];
  for (const [id, size] of labels) {
    const p = at.get(id);
    if (!p) continue;
    const { w, h } = size;
    const d = p.r + gap;
    const boxes: Record<LabelSide, [number, number, number, number]> = {
      right: [p.x + d, p.y - h / 2, p.x + d + w, p.y + h / 2],
      left: [p.x - d - w, p.y - h / 2, p.x - d, p.y + h / 2],
      top: [p.x - w / 2, p.y - d - h, p.x + w / 2, p.y - d],
      bottom: [p.x - w / 2, p.y + d, p.x + w / 2, p.y + d + h],
    };
    let best: LabelSide = "right";
    let bestScore = Infinity;
    for (const side of sides) {
      const [x0, y0, x1, y1] = boxes[side];
      if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) continue;
      let score = 0;
      for (const m of marks) if (m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1) score += m.w;
      for (const q of points) {
        if (q === p) continue;
        const cx = Math.min(x1, Math.max(x0, q.x));
        const cy = Math.min(y1, Math.max(y0, q.y));
        if (Math.hypot(q.x - cx, q.y - cy) < q.r + 2) score += 1000;
      }
      for (const [a0, b0, a1, b1] of placed) if (x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0) score += 1000;
      if (score < bestScore) [best, bestScore] = [side, score];
    }
    out.set(p.id, best);
    const [x0, y0, x1, y1] = boxes[best];
    placed.push([x0 - 3, y0 - 2, x1 + 3, y1 + 2]);
  }
  return out;
}
