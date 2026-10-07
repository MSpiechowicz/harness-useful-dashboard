import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getMeta, migrate, openDb, SCHEMA_VERSION } from "../src/core/db.ts";
import { tempDir } from "./helpers.ts";

const DB = join(import.meta.dir, "../src/core/db.ts");

describe("migrations", () => {
  test("a fresh database ends at the current version", () => {
    const db = openDb(":memory:");
    expect(Number(getMeta(db, "schema_version"))).toBe(SCHEMA_VERSION);
    migrate(db);
    expect(Number(getMeta(db, "schema_version"))).toBe(SCHEMA_VERSION);
  });

  test("machines opening a new shared database at once all succeed", async () => {
    const path = join(tempDir(), "shared.db");
    const child = `import { openDb } from ${JSON.stringify(DB)}; openDb(${JSON.stringify(path)}, { journalMode: "delete", isDefaultPath: false }).close();`;
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", child], { stderr: "pipe" }));
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(errors.filter(Boolean)).toEqual([]);
    expect(codes).toEqual(codes.map(() => 0));
    const db = new Database(path, { readonly: true });
    expect(Number(getMeta(db, "schema_version"))).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("the rollback journal syncs fully, WAL normally", () => {
    const dir = tempDir();
    const shared = openDb(join(dir, "shared.db"), { journalMode: "delete", isDefaultPath: false });
    const local = openDb(join(dir, "local.db"), { journalMode: "wal" });
    const sync = (db: Database) => db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
    expect(sync(shared)).toBe(2);
    expect(sync(local)).toBe(1);
    shared.close();
    local.close();
  });
});
