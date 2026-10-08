import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMeta, hasTable, migrate, NewerSchemaError, openDb, SCHEMA_VERSION, schemaInfo } from "../src/core/db.ts";
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

const NEW_TABLES = ["outcome_days", "chart_notes", "git_events", "compactions", "outcome_counts"];

/** Every path the migration to 18 decides on, and whether it is read again. */
const INGESTED: [path: string, reread: boolean][] = [
  ["/h/.claude/projects/p/s.jsonl", true],
  ["/h/.codex/sessions/rollout-1.jsonl", true],
  ["/h/.gemini/tmp/x/chats/session-1.json", true],
  ["C:\\Users\\me\\.gemini\\tmp\\x\\chats\\session-1.json", true],
  ["/h/.local/share/opencode/opencode.db", true],
  ["/h/.local/share/kilo/kilo.db", true],
  ["/h/.local/share/zed/threads/threads.db", false],
  ["/h/.copilot/session-store.db", false],
  ["/h/.config/Code/User/globalStorage/state.vscdb", false],
  ["/h/cline/tasks/1/ui_messages.json", false],
];

/** A database as schema 17 left it: none of 18's tables, its version set back, and logs already read. */
function v17(path: string): void {
  openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
  const db = new Database(path);
  db.exec(`DROP VIEW outcome_counts; DROP TABLE outcome_days; DROP TABLE chart_notes; DROP TABLE git_events; DROP TABLE compactions;
           DELETE FROM meta WHERE key = 'min_reader_schema'; UPDATE meta SET value = '17' WHERE key = 'schema_version'`);
  for (const [p] of INGESTED) db.query("INSERT INTO ingest_files (host, path, size, mtime, offset) VALUES ('h', ?, 1, 1, 1)").run(p);
  db.close();
}

const objects = (db: Database) =>
  db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((r) => r.name);

describe("schema 18", () => {
  test("a fresh database has the rollup, notes, git and compaction tables, the view and the oldest reader", () => {
    const db = openDb(":memory:");
    expect(objects(db)).toEqual(expect.arrayContaining(NEW_TABLES));
    expect(schemaInfo(db)).toEqual({ version: SCHEMA_VERSION, minReader: 18 });
    db.query("INSERT INTO outcomes (id, provider, session_id, ts, kind) VALUES ('o1', 'claude', 's', 1, 'tool_ok')").run();
    db.query("INSERT INTO outcome_days (ts, host, provider, session_id, n) VALUES (0, 'h', 'claude', 's', 5)").run();
    const counts = db.query<{ kind: string; n: number }, []>("SELECT kind, SUM(n) AS n FROM outcome_counts GROUP BY kind").all();
    expect(counts).toEqual([{ kind: "tool_ok", n: 6 }]);
    db.close();
  });

  test("a schema 17 database migrates and reads its logs, chats and OpenCode and Kilo databases once more", () => {
    const path = join(tempDir(), "v17.db");
    v17(path);
    const db = openDb(path, { journalMode: "delete", isDefaultPath: false });
    expect(Number(getMeta(db, "schema_version"))).toBe(SCHEMA_VERSION);
    expect(getMeta(db, "min_reader_schema")).toBe("18");
    expect(objects(db)).toEqual(expect.arrayContaining(NEW_TABLES));
    const kept = db.query<{ path: string }, []>("SELECT path FROM ingest_files ORDER BY path").all().map((r) => r.path);
    expect(kept).toEqual(INGESTED.filter(([, reread]) => !reread).map(([p]) => p).sort());
    db.close();
  });

  test("a newer app's database is never written to: a writable open throws and leaves the file as it was", () => {
    const path = join(tempDir(), "newer.db");
    openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
    const raw = new Database(path);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    raw.close();
    const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs, size: statSync(path).size };

    let error: unknown;
    try {
      openDb(path, { journalMode: "delete", isDefaultPath: false });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(NewerSchemaError);
    expect((error as NewerSchemaError).version).toBe(SCHEMA_VERSION + 1);
    expect(statSync(path).mtimeMs).toBe(before.mtime);
    expect(statSync(path).size).toBe(before.size);
    expect(readFileSync(path).equals(before.bytes)).toBe(true);

    // Read-only it opens: the newer app still lets schema 18 read.
    const ro = openDb(path, { readonly: true });
    expect(schemaInfo(ro)).toEqual({ version: SCHEMA_VERSION + 1, minReader: 18 });
    ro.close();
  });

  test("migrating a database a newer app already migrated throws, with nothing written", () => {
    const path = join(tempDir(), "raced.db");
    openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
    const raw = new Database(path);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);
    const before = readFileSync(path);

    expect(() => migrate(raw)).toThrow(NewerSchemaError);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(schemaInfo(raw).version).toBe(SCHEMA_VERSION + 1);
    raw.close();
  });

  test("a version that is no number fails closed, except for opening read-only", () => {
    const garbled = (key: string, value: string) => {
      const path = join(tempDir(), "garbled.db");
      openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
      const raw = new Database(path);
      raw.query("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
      return { path, raw };
    };

    for (const value of ["nineteen", "", "18.5"]) {
      const { path, raw } = garbled("schema_version", value);
      expect(() => schemaInfo(raw), value).toThrow("no version number");
      expect(() => migrate(raw), value).toThrow("no version number");
      raw.close();
      expect(() => openDb(path, { journalMode: "delete", isDefaultPath: false }), value).toThrow("no version number");
      openDb(path, { readonly: true }).close();
    }

    // The oldest reader is only read by the version check, which then refuses (App.writable, see server-notes).
    const { path, raw } = garbled("min_reader_schema", "18a");
    expect(() => schemaInfo(raw)).toThrow("no version number");
    raw.close();
    openDb(path, { readonly: true }).close();
  });

  test("a database that needs a newer reader opens in neither mode", () => {
    const path = join(tempDir(), "unreadable.db");
    openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
    const raw = new Database(path);
    raw.exec(`UPDATE meta SET value = '${SCHEMA_VERSION + 1}' WHERE key IN ('schema_version', 'min_reader_schema')`);
    raw.close();
    expect(() => openDb(path, { readonly: true })).toThrow(NewerSchemaError);
    expect(() => openDb(path, { journalMode: "delete", isDefaultPath: false })).toThrow(NewerSchemaError);
  });

  test("a read-only reader sees a table once another connection migrated the database", () => {
    const path = join(tempDir(), "reader.db");
    v17(path);
    const ro = openDb(path, { readonly: true });
    expect(hasTable(ro, "usage")).toBe(true);
    expect(hasTable(ro, "git_events")).toBe(false);
    openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
    expect(hasTable(ro, "git_events")).toBe(true);
    expect(hasTable(ro, "outcome_counts")).toBe(true);
    ro.close();
  });
});

describe("schema 19", () => {
  test("stored model ids lose their snapshot date, and only that", () => {
    const path = join(tempDir(), "dated.db");
    openDb(path, { journalMode: "delete", isDefaultPath: false }).close();
    const raw = new Database(path);
    const insert = raw.query("INSERT INTO outcomes (id, provider, session_id, ts, model, kind) VALUES (?, 'claude', 's', 1, ?, 'tool_ok')");
    for (const [id, model] of [["a", "claude-haiku-4-5-20251001"], ["b", "claude-haiku-4-5@20251001"], ["c", "claude-opus-5-5"], ["d", "gpt-4o-2024-08-06"]]) insert.run(id, model);
    raw.exec("UPDATE meta SET value = '18' WHERE key = 'schema_version'");
    raw.close();

    const db = openDb(path, { journalMode: "delete", isDefaultPath: false });
    const models = db.query<{ model: string }, []>("SELECT model FROM outcomes ORDER BY id").all().map((r) => r.model);
    expect(models).toEqual(["claude-haiku-4-5", "claude-haiku-4-5", "claude-opus-5-5", "gpt-4o-2024-08-06"]);
    db.close();
  });
});
