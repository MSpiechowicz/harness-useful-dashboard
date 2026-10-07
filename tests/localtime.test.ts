import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { zoneChanges } from "../src/core/queries.ts";

const QUERIES = join(import.meta.dir, "../src/core/queries.ts");

/**
 * SQLite reads the time zone once per process, so each zone runs in a child process with TZ set. The child buckets
 * every quarter hour around DST changes (and a few far-off times that take the 'localtime' fallback) both ways: with
 * SQLite's 'localtime' as before, and with the offsets from the JS clock.
 */
const CHILD = `
  import { Database } from "bun:sqlite";
  import { bucketExpr, localTime } from ${JSON.stringify(QUERIES)};
  const db = new Database(":memory:");
  db.exec("CREATE TABLE usage (ts INTEGER NOT NULL)");
  const ins = db.prepare("INSERT INTO usage (ts) VALUES (?)");
  const ranges = [[Date.UTC(2026, 2, 26), Date.UTC(2026, 3, 8)], [Date.UTC(2026, 9, 22), Date.UTC(2026, 10, 5)], [Date.UTC(2025, 9, 1), Date.UTC(2025, 9, 9)]];
  db.transaction(() => {
    for (const [a, b] of ranges) for (let t = a; t < b; t += 15 * 60_000) ins.run(t + 7_123);
    for (const t of [Date.UTC(2012, 6, 1, 23, 30), Date.UTC(2014, 11, 31, 23, 59), Date.UTC(2031, 0, 1, 0, 5), Date.now()]) ins.run(t);
  })();
  const L = "u.ts / 1000, 'unixepoch', 'localtime'";
  const old = {
    hour: "strftime('%Y-%m-%d %H:00', " + L + ")",
    day: "date(" + L + ")",
    week: "date(" + L + ", 'weekday 0', '-6 days')",
    month: "strftime('%Y-%m', " + L + ")",
    heat: "strftime('%w %H', " + L + ")",
  };
  const neu = { hour: bucketExpr("hour"), day: bucketExpr("day"), week: bucketExpr("week"), month: bucketExpr("month"), heat: "strftime('%w %H', " + localTime("u.ts") + ")" };
  const out = {};
  for (const k of Object.keys(old)) {
    out[k] = db.query("SELECT COUNT(*) AS n, SUM(" + old[k] + " IS NOT " + neu[k] + ") AS diff FROM usage u").get();
  }
  console.log(JSON.stringify(out));
`;

describe("local time buckets", () => {
  // Windows' C library doesn't read IANA zone names from TZ, so SQLite and the JS clock would disagree there.
  test.skipIf(process.platform === "win32").each(["Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu", "UTC"])("match SQLite's localtime in %p", (tz) => {
    const proc = Bun.spawnSync([process.execPath, "-e", CHILD], { env: { ...process.env, TZ: tz } });
    expect(proc.stderr.toString()).toBe("");
    const result = JSON.parse(proc.stdout.toString()) as Record<string, { n: number; diff: number }>;
    for (const [, r] of Object.entries(result)) {
      expect(r.n).toBeGreaterThan(3000);
      expect(r.diff).toBe(0);
    }
  });

  test("zone changes are found to the minute", () => {
    const changes = zoneChanges(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
    for (const c of changes.slice(1)) {
      expect(c.at % 60_000).toBe(0);
      expect(-new Date(c.at).getTimezoneOffset() * 60_000).toBe(c.offset);
      expect(-new Date(c.at - 60_000).getTimezoneOffset() * 60_000).not.toBe(c.offset);
    }
  });
});
