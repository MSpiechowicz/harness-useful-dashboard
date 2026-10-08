import { describe, expect, test } from "bun:test";
import { edgeToEdge, foldPairs, labelSides, OTHER, settle, type PairRow, type Point } from "../web/src/lib/network.ts";

const rows: PairRow[] = [
  { key: "m1", label: "model one", sub: "p1", subLabel: "alpha", value: 50 },
  { key: "m1", label: "model one", sub: "p2", subLabel: "beta", value: 30 },
  { key: "m2", label: "model two", sub: "p1", subLabel: "alpha", value: 15 },
  { key: "m2", label: "model two", sub: "p3", subLabel: "gamma", value: 0.2 },
  { key: OTHER, label: "other", sub: "p2", subLabel: "beta", value: 4.8 },
];

describe("foldPairs", () => {
  test("a pair too small for a fibre joins its row's Other, keeping the total", () => {
    const kept = foldPairs(rows, "Other");
    expect(kept.reduce((a, r) => a + r.value, 0)).toBeCloseTo(100);
    expect(kept.some((r) => r.sub === "p3")).toBe(false);
    expect(kept.find((r) => r.key === "m2" && r.sub === OTHER)).toMatchObject({ subLabel: "Other", value: 0.2 });
  });
});

describe("settle", () => {
  const layout = () => {
    const points: Point[] = ["a:m1", "a:m2", "a:x", "b:p1", "b:p2", "b:p3"].map((id) => ({ id, x: 0, y: 0, r: 8 }));
    settle(points, [{ source: "a:m1", target: "b:p1", strength: 1 }, { source: "a:m2", target: "b:p2", strength: 0.4 }], 900, 460);
    return points;
  };
  test("keeps every point inside the box, clear of the labels' room, the same every time", () => {
    const points = layout();
    expect(JSON.stringify(points)).toBe(JSON.stringify(layout()));
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.x).toBeLessThanOrEqual(900 - 130);
      expect(p.y).toBeGreaterThanOrEqual(24);
      expect(p.y).toBeLessThanOrEqual(460 - 24);
    }
  });
  test("points don't overlap", () => {
    const points = layout();
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) expect(Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y)).toBeGreaterThan(16);
  });
});

describe("settle around fibres", () => {
  test("no point sits on a fibre that isn't its own", () => {
    // A dense network like a real one: 8 points on one side, 7 on the other, many pairs.
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ids = [...Array(8)].map((_, i) => `a:${i}`).concat([...Array(7)].map((_, i) => `b:${i}`));
    const points: Point[] = ids.map((id) => ({ id, x: 0, y: 0, r: 3 + rnd() * 7 }));
    const links: { source: string; target: string; strength: number }[] = [];
    for (let i = 0; i < 8; i++) for (let j = 0; j < 7; j++) if (rnd() < 0.4) links.push({ source: `a:${i}`, target: `b:${j}`, strength: rnd() });
    const curveness = 0.25;
    settle(points, links, 1000, 460, curveness);
    const at = new Map(points.map((p) => [p.id, p]));
    for (const l of links) {
      const [a, b] = [at.get(l.source)!, at.get(l.target)!];
      const c = [(a.x + b.x) / 2 - (a.y - b.y) * curveness, (a.y + b.y) / 2 - (b.x - a.x) * curveness];
      for (const p of points) {
        if (p === a || p === b) continue;
        let d = Infinity;
        for (let i = 0; i <= 200; i++) {
          const t = i / 200;
          const x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * c[0]! + t * t * b.x;
          const y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * c[1]! + t * t * b.y;
          d = Math.min(d, Math.hypot(p.x - x, p.y - y));
        }
        expect(d).toBeGreaterThan(p.r + 2);
      }
    }
  });
});

describe("edgeToEdge", () => {
  test("starts on the first bubble's edge and ends on the second's", () => {
    const path = edgeToEdge([0, 0], [200, 0], 0.25, 10, 20)!;
    const [first, last] = [path[0]!, path[path.length - 1]!];
    expect(Math.hypot(first[0], first[1])).toBeCloseTo(10, 1);
    expect(Math.hypot(last[0] - 200, last[1])).toBeCloseTo(20, 1);
    // It bends like the fibre: off the straight line between the centers.
    expect(Math.abs(path[12]![1])).toBeGreaterThan(10);
  });
  test("nothing when the bubbles touch", () => {
    expect(edgeToEdge([0, 0], [25, 0], 0.25, 12, 14)).toBeNull();
  });
});

describe("labelSides", () => {
  const label = { w: 60, h: 14 };
  test("a name goes where no fibre runs, right when that is free", () => {
    // a's fibre leaves to the right, so its name moves off it. c has no fibre on its right.
    const points: Point[] = [
      { id: "a", x: 100, y: 100, r: 6 },
      { id: "b", x: 400, y: 100, r: 6 },
      { id: "c", x: 100, y: 300, r: 6 },
    ];
    const sides = labelSides(points, new Map(points.map((p) => [p.id, label])), [{ source: "a", target: "b", strength: 1 }], 0, 600, 400);
    expect(sides.get("a")).not.toBe("right");
    expect(sides.get("c")).toBe("right");
  });
  test("a name stays inside the card and off other points", () => {
    const points: Point[] = [
      { id: "edge", x: 590, y: 200, r: 6 },
      { id: "a", x: 100, y: 200, r: 6 },
      { id: "near", x: 140, y: 200, r: 6 },
    ];
    const sides = labelSides(points, new Map(points.map((p) => [p.id, label])), [], 0.25, 600, 400);
    expect(sides.get("edge")).toBe("left");
    expect(sides.get("a")).not.toBe("right");
  });
  test("names placed one after another never overlap", () => {
    // A big point near the card's left edge with "Other" up and to its right, both with a fibre off to the right:
    // a's name can only go above it, where b's would go to its left.
    const points: Point[] = [
      { id: "a", x: 100, y: 200, r: 10 },
      { id: "b", x: 190, y: 185, r: 6 },
      { id: "e", x: 500, y: 200, r: 6 },
      { id: "f", x: 500, y: 185, r: 6 },
    ];
    const sizes = new Map(points.map((p) => [p.id, { w: 110, h: 14 }]));
    const fibres = [{ source: "a", target: "e", strength: 1 }, { source: "b", target: "f", strength: 1 }];
    const sides = labelSides(points, sizes, fibres, 0, 600, 400);
    expect(sides.get("a")).toBe("top");
    const box = (p: Point) => {
      const { w, h } = sizes.get(p.id)!;
      const d = p.r + 6;
      return {
        right: [p.x + d, p.y - h / 2, p.x + d + w, p.y + h / 2],
        left: [p.x - d - w, p.y - h / 2, p.x - d, p.y + h / 2],
        top: [p.x - w / 2, p.y - d - h, p.x + w / 2, p.y - d],
        bottom: [p.x - w / 2, p.y + d, p.x + w / 2, p.y + d + h],
      }[sides.get(p.id)!]!;
    };
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++) {
        const [a0, b0, a1, b1] = box(points[i]!);
        const [x0, y0, x1, y1] = box(points[j]!);
        expect(x0 < a1 && x1 > a0 && y0 < b1 && y1 > b0).toBe(false);
      }
  });
});
