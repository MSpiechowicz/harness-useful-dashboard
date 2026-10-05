import { describe, expect, test } from "bun:test";
import { importCursorCsv, parseCsv } from "../src/core/ingest/cursor.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { ID, memDb } from "./helpers.ts";

describe("parseCsv", () => {
  test("handles quotes, escaped quotes, commas and CRLF", () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""",3\r\n\r\nlast,,\n');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "3"],
      ["last", "", ""],
    ]);
  });
  test("strips a UTF-8 BOM", () => {
    expect(parseCsv("﻿Date,Model\n2026-01-01,x")[0]).toEqual(["Date", "Model"]);
  });
});

const CSV = `Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-09-10T08:00:00.000Z","Included","claude-4.5-sonnet","No","1000","200","5000","300","6500","0.12"
"2026-09-10T09:00:00.000Z","Included","gpt-5","No","0","100","0","50","150","Included"
"2026-09-11T09:00:00.000Z","Errored","gpt-5","No","0","0","0","0","0","0"
"not a date","x","y","No","1","1","1","1","4","0"
`;

describe("Cursor CSV import", () => {
  test("maps columns, uses reported cost when present and dedupes re-imports", () => {
    const db = memDb();
    const writer = new DbWriter(db, new PriceBook(), ID);
    const r = importCursorCsv(CSV, writer);
    expect(r).toEqual({ rows: 4, imported: 2, skipped: 2 });

    const rows = db.query<any, []>("SELECT * FROM usage ORDER BY ts").all();
    expect(rows[0]).toMatchObject({ provider: "cursor", project: "Cursor", input_tokens: 200, cache_write_tokens: 1000, cache_read_tokens: 5000, output_tokens: 300, cost_usd: 0.12, cost_estimated: 0, agent: "Included" });
    // "Included" is not a number → priced from the price book
    expect(rows[1].cost_usd).toBeGreaterThan(0);

    importCursorCsv(CSV, writer);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM usage").get().n).toBe(2);
    expect(db.query<any, []>("SELECT COUNT(*) AS n FROM sessions").get().n).toBe(1);
  });

  test("rejects files without a date column", () => {
    const db = memDb();
    expect(() => importCursorCsv("Model,Tokens\nx,1\n", new DbWriter(db, new PriceBook(), ID))).toThrow(/Date/);
  });

  test("team exports carry the user per row", () => {
    const db = memDb();
    importCursorCsv(`Date,User,Model,Input (w/o Cache Write),Output Tokens\n2026-09-10T08:00:00Z,alice@example.com,gpt-5,100,10\n`, new DbWriter(db, new PriceBook(), ID));
    expect(db.query<any, []>("SELECT user FROM usage").get().user).toBe("alice@example.com");
  });
});
