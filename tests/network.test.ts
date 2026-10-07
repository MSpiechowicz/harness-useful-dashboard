import { describe, expect, test } from "bun:test";
import { edgeToEdge, foldPairs, OTHER, settle, type PairRow, type Point } from "../web/src/lib/network.ts";

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
