import { describe, expect, test } from "bun:test";
import { bucketDay, localDay, mondayOf, noteBucketIndex } from "../web/src/lib/noteBuckets.ts";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("noteBucketIndex", () => {
  test("a day note sits on its day's column, none when the day has no bucket", () => {
    const days = ["2026-09-13", "2026-09-14", "2026-09-15"];
    expect(noteBucketIndex(days, "day", { ts: at(2026, 9, 14), day: "2026-09-14" })).toBe(1);
    expect(noteBucketIndex(days, "day", { ts: at(2026, 9, 20), day: "2026-09-20" })).toBeNull();
  });

  test("a note at a moment sits on the local day it falls on", () => {
    const days = ["2026-09-13", "2026-09-14"];
    expect(noteBucketIndex(days, "day", { ts: at(2026, 9, 14, 23, 59), day: null })).toBe(1);
    expect(noteBucketIndex(days, "day", { ts: at(2026, 9, 13, 0, 1), day: null })).toBe(0);
  });

  test("hourly buckets: a moment sits on its hour, a day note on the day's first hour with usage", () => {
    const hours = ["2026-09-14 09:00", "2026-09-14 10:00", "2026-09-15 08:00"];
    expect(noteBucketIndex(hours, "hour", { ts: at(2026, 9, 14, 10, 40), day: null })).toBe(1);
    expect(noteBucketIndex(hours, "hour", { ts: at(2026, 9, 14, 11, 0), day: null })).toBeNull();
    expect(noteBucketIndex(hours, "hour", { ts: at(2026, 9, 15), day: "2026-09-15" })).toBe(2);
    expect(noteBucketIndex(hours, "hour", { ts: at(2026, 9, 14), day: "2026-09-14" })).toBe(0);
  });

  test("weekly buckets are named by their Monday, monthly ones by the month", () => {
    const weeks = ["2026-09-07", "2026-09-14"];
    // 2026-09-13 is a Sunday, 2026-09-14 a Monday.
    expect(noteBucketIndex(weeks, "week", { ts: at(2026, 9, 13), day: "2026-09-13" })).toBe(0);
    expect(noteBucketIndex(weeks, "week", { ts: at(2026, 9, 14), day: "2026-09-14" })).toBe(1);
    expect(noteBucketIndex(weeks, "week", { ts: at(2026, 9, 30), day: "2026-09-30" })).toBeNull();
    const months = ["2026-08", "2026-09"];
    expect(noteBucketIndex(months, "month", { ts: at(2026, 9, 30, 23, 0), day: null })).toBe(1);
    expect(noteBucketIndex(months, "month", { ts: at(2026, 10, 1), day: "2026-10-01" })).toBeNull();
  });
});

describe("date helpers", () => {
  test("localDay and mondayOf", () => {
    expect(localDay(at(2026, 1, 5, 23, 30))).toBe("2026-01-05");
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");
    expect(mondayOf("2026-09-07")).toBe("2026-09-07");
    expect(mondayOf("2026-03-01")).toBe("2026-02-23");
  });

  test("bucketDay is the day a bucket starts on", () => {
    expect(bucketDay("2026-09-14 13:00", "hour")).toBe("2026-09-14");
    expect(bucketDay("2026-09-07", "week")).toBe("2026-09-07");
    expect(bucketDay("2026-09", "month")).toBe("2026-09-01");
  });
});
