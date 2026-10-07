import { describe, expect, test } from "bun:test";
import { type ExportRow, columnsOf, csvField, exportFilename, exportText, normalizeRow, seriesRows, toCsv } from "../web/src/lib/export.ts";

describe("csvField", () => {
  test("plain values stay as they are", () => {
    expect(csvField("abc")).toBe("abc");
    expect(csvField(12.5)).toBe("12.5");
    expect(csvField(-3)).toBe("-3");
    expect(csvField(true)).toBe("true");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
    expect(csvField(Number.NaN)).toBe("");
  });
  test("commas, quotes and line breaks are quoted, quotes doubled", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("one\ntwo")).toBe('"one\ntwo"');
    expect(csvField("one\r\ntwo")).toBe('"one\r\ntwo"');
  });
  test("text a spreadsheet would run as a formula is defused", () => {
    expect(csvField("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvField("+1")).toBe("'+1");
    expect(csvField("-x")).toBe("'-x");
    expect(csvField("@cmd")).toBe("'@cmd");
    expect(csvField("=a,b")).toBe(`"'=a,b"`);
  });
});

describe("toCsv", () => {
  test("header row from every key in first-seen order, CRLF line ends", () => {
    const rows: ExportRow[] = [{ a: 1, b: "x" }, { b: "y", c: null }];
    expect(columnsOf(rows)).toEqual(["a", "b", "c"]);
    expect(toCsv(rows)).toBe("a,b,c\r\n1,x,\r\n,y,\r\n");
  });
  test("an empty table still has its header when columns are given", () => {
    expect(toCsv([], ["key", "cost"])).toBe("key,cost\r\n");
  });
});

describe("normalizeRow", () => {
  test("timestamps become ISO 8601, lists of words joined, nested values JSON, undefined dropped", () => {
    const ts = Date.UTC(2026, 9, 7, 12, 30);
    expect(normalizeRow({ ts, lastTs: ts, startedAt: ts, cost: 1.25, tags: ["a", "b"], ids: [1, 2], meta: { k: 1 }, gone: undefined, n: null })).toEqual({
      ts: "2026-10-07T12:30:00.000Z",
      lastTs: "2026-10-07T12:30:00.000Z",
      startedAt: "2026-10-07T12:30:00.000Z",
      cost: 1.25,
      tags: "a, b",
      ids: "[1,2]",
      meta: '{"k":1}',
      n: null,
    });
  });
  test("small numbers under a time-like key are left alone", () => {
    expect(normalizeRow({ lastTs: 0 })).toEqual({ lastTs: 0 });
  });
});

describe("exportText", () => {
  test("CSV starts with a UTF-8 BOM and keeps non-ASCII text", () => {
    const text = exportText([{ name: "Zażółć", cost: 0.5 }], "csv");
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe("name,cost\r\nZażółć,0.5\r\n");
  });
  test("JSON is an array of objects with the same keys", () => {
    const ts = Date.UTC(2026, 0, 1);
    expect(JSON.parse(exportText([{ key: "a", lastTs: ts }], "json"))).toEqual([{ key: "a", lastTs: "2026-01-01T00:00:00.000Z" }]);
  });
});

test("seriesRows: one row per bucket, a column per series", () => {
  const ts = { buckets: ["2026-10-01", "2026-10-02"], series: [{ key: "input", data: [1, 2] }, { key: "output", data: [3] }] };
  expect(seriesRows(ts, true)).toEqual([
    { bucket: "2026-10-01", input: 1, output: 3, total: 4 },
    { bucket: "2026-10-02", input: 2, output: 0, total: 2 },
  ]);
});

test("exportFilename", () => {
  const d = new Date(2026, 9, 7);
  expect(exportFilename("sessions", "csv", d)).toBe("harness-dashboard-sessions-2026-10-07.csv");
  expect(exportFilename("Cache by Model", "json", d)).toBe("harness-dashboard-cache-by-model-2026-10-07.json");
});
