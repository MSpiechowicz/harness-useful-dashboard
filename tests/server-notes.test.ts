import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMeta, NewerSchemaError, openDb, SCHEMA_VERSION } from "../src/core/db.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { tempDir } from "./helpers.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TOKEN = "d".repeat(64);
const HEADERS = { host: "localhost:4317", "x-harness-dashboard": "1", "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
/** Every source off: the app must not read this machine's real logs. */
const NO_SOURCES = { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false };

function usage(over: Partial<UsageRecord> & { id: string; ts: number }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: null, project: "/work/alpha", model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    ...over,
  };
}

/** Points the app's home and Claude's config folder at `root`, and gives the old values back afterwards. */
function isolate(root: string): () => void {
  const prev = { home: process.env.HARNESS_DASHBOARD_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  mkdirSync(join(root, "home"), { recursive: true });
  writeFileSync(join(root, "home", "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { claudeDirs: [join(root, "claude", "projects")], enabled: NO_SOURCES } }));

  return () => {
    for (const [key, value] of [["HARNESS_DASHBOARD_HOME", prev.home], ["CLAUDE_CONFIG_DIR", prev.claude]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function handlerFor(app: App) {
  const handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token: TOKEN, port: 4317 });
  return (method: string, path: string, body?: unknown, headers: Record<string, string> = HEADERS) =>
    handle(new Request(`http://localhost:4317${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }));
}

describe("chart notes, what-if and Live over HTTP", () => {
  let app: App;
  let call: ReturnType<typeof handlerFor>;
  let restore: () => void;
  const now = Date.now();
  /** A note two days ago: its 7-day comparison is clipped to now. */
  const noteTs = now - 2 * DAY;

  beforeAll(() => {
    const root = tempDir();
    restore = isolate(root);

    // Claude Code's registry lists this test's own process as session live-1. gone-1 has no entry: its process ended.
    mkdirSync(join(root, "claude", "sessions"), { recursive: true });
    writeFileSync(join(root, "claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "live-1" }));

    app = new App(join(root, "test.db"));
    const w = new DbWriter(app.db, new PriceBook(), app.identity);
    w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: "/work/alpha" });
    w.session({ id: "codex:s2", provider: "codex", nativeId: "s2", project: "/work/beta" });
    w.usage(usage({ id: "before", ts: noteTs - HOUR }));
    w.usage(usage({ id: "after", ts: noteTs + HOUR }));
    w.usage(usage({ id: "codex-after", ts: noteTs + 2 * HOUR, provider: "codex", sessionId: "codex:s2", model: "gpt-5", project: "/work/beta" }));

    for (const id of ["live-1", "gone-1"]) {
      w.session({ id: `claude:${id}`, provider: "claude", nativeId: id, project: "/work/live" });
      w.usage(usage({ id: `u-${id}`, ts: now - 5 * 60_000, sessionId: `claude:${id}`, project: "/work/live" }));
    }

    call = handlerFor(app);
  });

  afterAll(() => {
    app.close();
    restore();
  });

  test("note changes need the sign-in and the CSRF header", async () => {
    const noAuth = { host: "localhost:4317", "x-harness-dashboard": "1", "content-type": "application/json" };
    const noCsrf = { host: "localhost:4317", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    expect((await call("GET", "/api/notes", undefined, noAuth)).status).toBe(401);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await call(method, "/api/notes", { ts: now, text: "x", id: crypto.randomUUID() }, noAuth)).status, method).toBe(401);
      expect((await call(method, "/api/notes", { ts: now, text: "x", id: crypto.randomUUID() }, noCsrf)).status, method).toBe(403);
    }
    expect(((await (await call("GET", "/api/notes")).json()) as { notes: unknown[] }).notes).toEqual([]);
  });

  test("add, list in a range, edit and delete a note", async () => {
    const added = await call("POST", "/api/notes", { ts: noteTs, text: "  switched\n to Opus  " });
    expect(added.status).toBe(200);
    const note = (await added.json()) as { id: string; ts: number; day: string | null; text: string; createdAt: number; updatedAt: number };
    expect(note).toMatchObject({ ts: noteTs, day: null, text: "switched to Opus" });

    const list = async (query = "") => ((await (await call("GET", `/api/notes${query}`)).json()) as { notes: { id: string }[] }).notes.map((n) => n.id);
    expect(await list()).toEqual([note.id]);
    expect(await list(`?from=${noteTs - HOUR}&to=${noteTs + HOUR}&provider=codex`)).toEqual([note.id]);
    expect(await list(`?from=${noteTs + 1}`)).toEqual([]);

    const edited = (await (await call("PUT", "/api/notes", { id: note.id, text: "new CLAUDE.md", day: "2026-09-30" })).json()) as typeof note;
    expect(edited).toMatchObject({ id: note.id, text: "new CLAUDE.md", day: "2026-09-30", ts: noteTs });

    expect(await (await call("DELETE", "/api/notes", { id: note.id })).json()).toBeNull();
    expect(await list()).toEqual([]);
    expect((await call("DELETE", "/api/notes", { id: note.id })).status).toBe(404);
  });

  test("odd or oversized input is refused, an unknown note is 404", async () => {
    for (const body of [{ ts: now, text: "" }, { ts: now, text: "x".repeat(201) }, { ts: "now", text: "x" }, { ts: now, text: "x", day: "2026-02-30" }, [1], "not json"]) {
      expect((await call("POST", "/api/notes", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/api/notes", { ts: now, text: "x", padding: "y".repeat(20_000) })).status).toBe(400);
    expect((await call("PUT", "/api/notes", { id: "nope", text: "x" })).status).toBe(400);
    expect((await call("PUT", "/api/notes", { id: crypto.randomUUID(), text: "x" })).status).toBe(404);
    expect((await call("DELETE", "/api/notes", {})).status).toBe(400);
    expect((await call("GET", `/api/notes/compare?id=${crypto.randomUUID()}&days=7`)).status).toBe(404);
    expect((await call("GET", "/api/notes/compare?id=nope&days=7")).status).toBe(400);
    // Other DELETEs are still no routes.
    expect((await call("DELETE", "/api/scan")).status).toBe(404);
  });

  test("a note's before and after: clipped to now, filters applied", async () => {
    const { id } = (await (await call("POST", "/api/notes", { ts: noteTs, text: "compare me" })).json()) as { id: string };
    type W = { from: number; to: number; cost: number; prompts: number; costPerPrompt: number | null; tokensPerPrompt: number | null; cacheHitRate: number | null; toolErrorRate: number | null; apiErrorRate: number | null };
    const compare = async (query: string) =>
      (await (await call("GET", `/api/notes/compare?id=${id}${query}`)).json()) as { note: { id: string }; days: number; clipped: boolean; before: W; after: W };

    const all = await compare("&days=7");
    expect(all.note.id).toBe(id);
    expect(all.days).toBe(7);
    expect(all.clipped).toBe(true);
    expect(all.after.from).toBe(noteTs);
    expect(all.after.to).toBeGreaterThan(noteTs);
    expect(all.after.to).toBeLessThanOrEqual(Date.now());
    expect(all.before.to).toBe(noteTs);
    expect(Object.keys(all.after).sort()).toEqual(["apiErrorRate", "cacheHitRate", "cost", "costPerPrompt", "from", "prompts", "to", "tokensPerPrompt", "toolErrorRate"]);

    const claude = await compare("&days=7&provider=claude");
    const codex = await compare("&days=7&provider=codex");
    expect(claude.after.cost).toBeGreaterThan(0);
    expect(codex.after.cost).toBeGreaterThan(0);
    expect(claude.after.cost + codex.after.cost).toBeCloseTo(all.after.cost, 9);
    expect(codex.before.cost).toBe(0);

    // The global range filter doesn't move the windows.
    expect((await compare("&days=7&from=0&to=1")).after.cost).toBeCloseTo(all.after.cost, 9);
    expect((await call("GET", `/api/notes/compare?id=${id}&days=5`)).status).toBe(400);
    await call("DELETE", "/api/notes", { id });
  });

  test("what-if re-prices the range at `candidate`, with `model` as the filter", async () => {
    type WhatIf = { candidate: string; candidates: { inUse: string[]; priced: string[] }; actual: number; whatIf: number; change: number | null; estimated: boolean; reported: boolean; rows: { model: string }[] };
    const all = (await (await call("GET", "/api/whatif?candidate=gpt-5")).json()) as WhatIf;
    expect(all.candidate).toBe("gpt-5");
    expect(all.rows.map((r) => r.model).sort()).toEqual(["claude-sonnet-4-5", "gpt-5"]);
    expect(Object.keys(all).sort()).toEqual(["actual", "candidate", "candidates", "change", "estimated", "reported", "rows", "whatIf"]);

    const narrowed = (await (await call("GET", "/api/whatif?candidate=gpt-5&model=claude-sonnet-4-5")).json()) as WhatIf;
    expect(narrowed.candidate).toBe("gpt-5");
    expect(narrowed.rows.map((r) => r.model)).toEqual(["claude-sonnet-4-5"]);
    expect(narrowed.actual).toBeLessThan(all.actual);

    // Without a candidate, the model that cost the most.
    expect(((await (await call("GET", "/api/whatif")).json()) as WhatIf).candidate).toBe(all.candidates.inUse[0]!);
  });

  test("what-if takes only a candidate it offers: a model in use or one with a price", async () => {
    const offered = ((await (await call("GET", "/api/whatif")).json()) as { candidates: { inUse: string[]; priced: string[] } }).candidates;
    const priced = offered.priced.find((m) => !offered.inUse.includes(m))!;
    expect((await call("GET", `/api/whatif?candidate=${encodeURIComponent(priced)}`)).status).toBe(200);

    for (const candidate of ["made-up-model-1", "x".repeat(300)]) {
      const res = await call("GET", `/api/whatif?candidate=${candidate}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("unknown candidate");
    }
  });

  test.skipIf(process.platform === "win32")("Live judges this machine's Claude sessions by Claude Code's registry", async () => {
    const live = (await (await call("GET", "/api/live?minutes=60")).json()) as { sessions: { id: string; status: string }[] };
    const status = Object.fromEntries(live.sessions.map((s) => [s.id, s.status]));
    expect(status["claude:gone-1"]).toBe("closed");
    expect(status["claude:live-1"]).toBeDefined();
    expect(status["claude:live-1"]).not.toBe("closed");
  });

  test("status says the database is writable, at this app's schema", async () => {
    expect(await (await call("GET", "/api/status")).json()).toMatchObject({ readOnly: null, schemaVersion: SCHEMA_VERSION });
  });
});

/** A database at this app's schema, then marked as migrated by a newer app. */
function newerDatabase(path: string, meta: Record<string, string>): void {
  openDb(path, { isDefaultPath: false }).close();
  const raw = new Database(path);
  for (const [key, value] of Object.entries(meta)) raw.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
  raw.close();
}

describe("a database migrated by a newer app", () => {
  let root: string;
  let path: string;
  let app: App;
  let call: ReturnType<typeof handlerFor>;
  let restore: () => void;

  beforeAll(() => {
    root = tempDir();
    restore = isolate(root);
    path = join(root, "newer.db");
    newerDatabase(path, { schema_version: String(SCHEMA_VERSION + 1) });
    app = new App(path);
    call = handlerFor(app);
  });

  afterAll(() => {
    app.close();
    restore();
  });

  test("opens read-only and says so", async () => {
    expect(app.readOnly).toBe("newer-schema");
    expect(await (await call("GET", "/api/status")).json()).toMatchObject({ readOnly: "newer-schema", schemaVersion: SCHEMA_VERSION + 1 });
    expect((await call("GET", "/api/summary")).status).toBe(200);
    expect((await call("GET", "/api/notes")).status).toBe(200);
  });

  test("every change to the database answers 409, config-only requests still work", async () => {
    for (const [method, route] of [["POST", "/api/notes"], ["PUT", "/api/notes"], ["DELETE", "/api/notes"], ["POST", "/api/tags"], ["POST", "/api/scan"], ["PUT", "/api/pricing"], ["POST", "/api/db/compact"], ["POST", "/api/digest"], ["POST", "/api/import/cursor"]] as const) {
      const res = await call(method, route, { ts: Date.now(), text: "x" });
      expect(res.status, `${method} ${route}`).toBe(409);
      expect(await res.json()).toEqual({ error: "database-newer" });
    }
    expect((await call("POST", "/api/language", { language: "de" })).status).toBe(200);
    expect((await call("POST", "/api/settings", { userName: "ada" })).status).toBe(200);
    expect(app.cfg.userName).toBe("ada");
    // Read and hidden tips live in the config file too.
    expect((await call("POST", "/api/tips/state", { hide: ["low-cache-hit"] })).status).toBe(200);
    expect(app.cfg.tips.hidden).toContain("low-cache-hit");
  });

  test("scans and background jobs leave the file as it was", async () => {
    const before = readFileSync(path);
    expect(await app.scanNow(true)).toMatchObject({ filesSeen: 0, filesParsed: 0, usageRows: 0 });
    app.startBackgroundScan();
    app.trimIfDue();
    app.rollupIfDue();
    expect(app.checkDigest()).toBeNull();
    expect((await call("GET", "/api/live")).status).toBe(200);
    app.stopBackgroundScan();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test("one the newer app marked unreadable for this one isn't opened at all", () => {
    const unreadable = join(root, "unreadable.db");
    newerDatabase(unreadable, { schema_version: String(SCHEMA_VERSION + 2), min_reader_schema: String(SCHEMA_VERSION + 1) });
    expect(() => new App(unreadable)).toThrow(NewerSchemaError);
  });

  test("a copy stays read-only, a switch to another database makes the app writable again", async () => {
    const copy = join(root, "copy.db");
    expect((await call("POST", "/api/settings", { dbPath: copy, copyDb: true })).status).toBe(200);
    expect(app.dbPath).toBe(copy);
    expect(app.readOnly).toBe("newer-schema");

    const fresh = join(root, "fresh.db");
    expect((await call("POST", "/api/settings", { dbPath: fresh })).status).toBe(200);
    expect(await (await call("GET", "/api/status")).json()).toMatchObject({ dbPath: fresh, readOnly: null, schemaVersion: SCHEMA_VERSION });
    expect((await call("POST", "/api/notes", { ts: Date.now(), text: "writable again" })).status).toBe(200);
    app.stopBackgroundScan();
  });

  test("the CLI scan says to update the app, reports still read it", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const env = { ...process.env, NO_COLOR: "1" };

    const scan = Bun.spawnSync(["bun", cli, "scan", "--db", path], { env });
    expect(scan.exitCode).not.toBe(0);
    expect(scan.stderr.toString()).toContain("This database was upgraded by a newer version of Harness Dashboard. Update the app.");

    const report = Bun.spawnSync(["bun", cli, "report", "--db", path, "--json"], { env });
    expect(report.exitCode).toBe(0);
  });
});

describe("a database migrated by a newer app while this one runs", () => {
  let root: string;
  let restore: () => void;

  beforeAll(() => {
    root = tempDir();
    restore = isolate(root);
  });

  afterAll(() => restore());

  /** Marks the file as migrated by a newer app, from a connection of its own like another machine's. */
  function migrateAway(path: string, meta: Record<string, string>): void {
    const raw = new Database(path);
    for (const [key, value] of Object.entries(meta)) raw.query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
    raw.close();
  }

  test("the next write notices: nothing is written, the app turns read-only and open windows hear of it", async () => {
    const path = join(root, "shared.db");
    const app = new App(path);
    const call = handlerFor(app);
    const events: string[] = [];
    app.subscribe((e) => events.push(e.type));
    expect(app.readOnly).toBeNull();

    migrateAway(path, { schema_version: String(SCHEMA_VERSION + 1) });
    const before = readFileSync(path);

    expect(await app.scanNow(true)).toEqual({ filesSeen: 0, filesParsed: 0, usageRows: 0, prompts: 0, tools: 0, errors: [], durationMs: 0 });
    expect(app.readOnly).toBe("newer-schema");
    expect(events).toContain("db-changed");

    const res = await call("POST", "/api/notes", { ts: Date.now(), text: "x" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "database-newer" });
    app.trimIfDue();
    app.rollupIfDue();
    expect(app.checkDigest()).toBeNull();
    expect(await (await call("GET", "/api/status")).json()).toMatchObject({ readOnly: "newer-schema", schemaVersion: SCHEMA_VERSION + 1 });
    expect((await call("GET", "/api/summary")).status).toBe(200);
    expect(readFileSync(path).equals(before)).toBe(true);
    app.close();
  });

  test("a request that would write notices too, before anything is written", async () => {
    const path = join(root, "by-request.db");
    const app = new App(path);
    const call = handlerFor(app);

    migrateAway(path, { schema_version: String(SCHEMA_VERSION + 1) });
    const before = readFileSync(path);

    expect((await call("POST", "/api/tags", { session: "claude:s1", tag: "billable" })).status).toBe(409);
    expect(app.readOnly).toBe("newer-schema");
    expect(readFileSync(path).equals(before)).toBe(true);
    app.close();
  });

  test("a schema version that can't be read is no permission to write, and no reason to give up the database", async () => {
    const path = join(root, "unreadable-meta.db");
    const app = new App(path);
    const call = handlerFor(app);

    // Another machine leaves a meta that fails to read (here a view that overflows), not one that is missing.
    const raw = new Database(path);
    raw.exec("ALTER TABLE meta RENAME TO meta_kept; CREATE VIEW meta AS SELECT key, abs(-9223372036854775808) AS value FROM meta_kept");
    raw.close();
    const before = readFileSync(path);

    expect(app.writable()).toBe(false);
    expect((await call("POST", "/api/notes", { ts: Date.now(), text: "x" })).status).toBe(409);
    expect((await app.scanNow()).filesSeen).toBe(0);
    expect(readFileSync(path).equals(before)).toBe(true);
    // Not read-only for good: the next check that reads a version may write again.
    expect(app.readOnly).toBeNull();
    expect((await call("GET", "/api/status")).status).toBe(200);
    app.close();
  });

  test("a schema version that is no number is no permission to write", async () => {
    const path = join(root, "garbled.db");
    const app = new App(path);

    const raw = new Database(path);
    raw.exec("UPDATE meta SET value = 'later' WHERE key = 'min_reader_schema'");
    raw.close();

    expect(app.writable()).toBe(false);
    expect((await handlerFor(app)("POST", "/api/notes", { ts: Date.now(), text: "x" })).status).toBe(409);
    app.close();
  });

  test("a check that fails for a moment while the jobs start leaves them running", async () => {
    const path = join(root, "locked.db");
    const app = new App(path);
    app.cfg = { ...app.cfg, scanIntervalSec: 30 };
    // A scan that ends tags the labeler's own sessions: the write the scan's tick is seen by.
    const labeler = join(root, "locked-labeler");
    app.labelerDeps = { dir: labeler };
    app.db.query("INSERT INTO sessions (id, provider, native_id, project) VALUES ('claude:lab', 'claude', 'lab', ?)").run(labeler);
    const db = app.db as Database & { query: Database["query"] };

    // The timers are recorded, not run: the test runs the scan's tick itself.
    const ticks: { run: () => void; ms: number }[] = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((run: () => void, ms: number) => {
      ticks.push({ run, ms });
      return realSetInterval(() => {}, 1e9);
    }) as unknown as typeof setInterval;
    // The first read of meta finds the file locked, like a synced folder after busy_timeout.
    let failed = false;
    const query = db.query.bind(db);
    db.query = ((sql: string) => {
      if (!failed && sql.includes("FROM meta WHERE key")) {
        failed = true;
        throw new Error("database is locked");
      }
      return query(sql);
    }) as Database["query"];
    try {
      app.startBackgroundScan();
    } finally {
      globalThis.setInterval = realSetInterval;
      delete (db as Partial<Database>).query;
    }

    expect(failed).toBe(true);
    expect(app.readOnly).toBeNull();
    expect(ticks.map((t) => t.ms).sort((a, b) => a - b)).toEqual([30_000, 5 * 60_000, 5 * 60_000, 10 * 60_000, 10 * 60_000]);

    // The next scan tick, with reads working again, writes.
    const tags = () => (app.db.query("SELECT COUNT(*) AS n FROM session_tags").get() as { n: number }).n;
    expect(tags()).toBe(0);
    ticks.find((t) => t.ms === 30_000)!.run();
    await app.scanNow();
    expect(tags()).toBe(1);
    app.stopBackgroundScan();
    app.close();
  });

  test("one the newer app marked unreadable for this one keeps its connection, and nothing is written", async () => {
    const path = join(root, "unreadable.db");
    const app = new App(path);
    const call = handlerFor(app);

    migrateAway(path, { schema_version: String(SCHEMA_VERSION + 2), min_reader_schema: String(SCHEMA_VERSION + 1) });
    const before = readFileSync(path);

    expect((await app.scanNow()).filesSeen).toBe(0);
    expect(app.readOnly).toBe("newer-schema");
    expect((await call("POST", "/api/notes", { ts: Date.now(), text: "x" })).status).toBe(409);
    expect((await call("GET", "/api/status")).status).toBe(200);
    expect(readFileSync(path).equals(before)).toBe(true);
    app.close();
  });
});

describe("switching to a database that can't be opened", () => {
  let restore: () => void;
  afterAll(() => restore());

  test("leaves the app on its database and the config file as it was", async () => {
    const root = tempDir();
    restore = isolate(root);
    const current = join(root, "current.db");
    const app = new App(current);
    const db = app.db;
    const call = handlerFor(app);
    const config = () => JSON.parse(readFileSync(join(root, "home", "config.json"), "utf8")) as { dbPath?: string };

    const target = join(root, "unreadable.db");
    newerDatabase(target, { schema_version: String(SCHEMA_VERSION + 2), min_reader_schema: String(SCHEMA_VERSION + 1) });

    expect((await call("POST", "/api/settings", { dbPath: target })).status).toBe(500);
    expect(app.dbPath).toBe(current);
    // The same connection, never closed.
    expect(app.db).toBe(db);
    expect(app.readOnly).toBeNull();
    // The settings in the request are saved, the database the app couldn't open isn't.
    expect(config().dbPath ?? "").toBe("");
    expect((await call("POST", "/api/notes", { ts: Date.now(), text: "still here" })).status).toBe(200);
    app.close();
  });
});

describe("background jobs when a newer app migrates the database under them", () => {
  let root: string;
  let restore: () => void;
  const MONTH = 31 * DAY;

  beforeAll(() => {
    root = tempDir();
    restore = isolate(root);
  });

  afterAll(() => restore());

  const bump = (path: string) => {
    const raw = new Database(path);
    raw.query("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    raw.close();
  };
  type Jobs = { trimming: Promise<void> | null; rolling: Promise<void> | null };
  const jobs = (app: App) => app as unknown as Jobs;
  const one = (app: App, sql: string) => (app.db.query(sql).get() as { n: number }).n;

  test("a trim stops at its next batch: no note, no vacuum", async () => {
    const path = join(root, "trim.db");
    const app = new App(path);
    app.cfg = { ...app.cfg, detailRetentionMonths: 3 };
    const w = new DbWriter(app.db, new PriceBook(), app.identity);
    const old = Date.now() - 6 * MONTH;
    // 5001 prompts in sessions of 10, one of them long enough to take pages of its own.
    app.db.transaction(() => {
      for (let i = 0; i < 5001; i++) {
        const sessionId = `claude:old-${Math.floor(i / 10)}`;
        if (i % 10 === 0) w.session({ id: sessionId, provider: "claude", nativeId: sessionId, project: "/work/alpha" });
        w.prompt({ id: `${sessionId}:p${i}`, sessionId, provider: "claude", ts: old + i, text: "x".repeat(i === 1 ? 50_000 : 500), skill: null, isCommand: false });
      }
    })();

    // The first batch of 5000 runs at once, then the trim waits for its pause: the other machine migrates there.
    app.trimIfDue();
    bump(path);
    await jobs(app).trimming;

    expect(app.readOnly).toBe("newer-schema");
    expect(one(app, "SELECT COUNT(*) AS n FROM prompts WHERE length(text) = 500")).toBe(1);
    expect(getMeta(app.db, `detail_trim:${app.identity.host}`)).toBeNull();
    // The pages the first batch freed are still free: no incremental vacuum ran.
    expect(one(app, "SELECT freelist_count AS n FROM pragma_freelist_count")).toBeGreaterThan(0);
    app.close();
  });

  test("the rollup stops at its next day: no note, no vacuum", async () => {
    const path = join(root, "rollup.db");
    const app = new App(path);
    const w = new DbWriter(app.db, new PriceBook(), app.identity);
    for (const [day, n] of [[20, 3], [19, 2]] as const) {
      for (let i = 0; i < n; i++) {
        w.outcome({ id: `o-${day}-${i}`, provider: "claude", sessionId: "claude:s1", ts: new Date().setHours(12, 0, 0, 0) - day * DAY + i, project: "/work/alpha", model: "claude-sonnet-4-5", agent: "main", kind: "tool_ok" });
      }
    }

    // The first day is rolled up before the rollup's first pause, which the other machine's migration comes before.
    app.rollupIfDue();
    setTimeout(() => bump(path), 0);
    await jobs(app).rolling;

    expect(app.readOnly).toBe("newer-schema");
    expect(one(app, "SELECT COUNT(DISTINCT ts) AS n FROM outcome_days")).toBe(1);
    expect(one(app, "SELECT COUNT(*) AS n FROM outcomes WHERE kind = 'tool_ok'")).toBe(2);
    expect(getMeta(app.db, `outcome_rollup:${app.identity.host}`)).toBeNull();
    app.close();
  });

  test("a scan that ends on a migrated database doesn't tag the labeler's sessions", async () => {
    const tagged = async (name: string, migrate: boolean) => {
      const path = join(root, `${name}.db`);
      const dir = join(root, `${name}-labeler`);
      const app = new App(path);
      app.labelerDeps = { dir };
      app.db.query("INSERT INTO sessions (id, provider, native_id, project) VALUES ('claude:lab', 'claude', 'lab', ?)").run(dir);

      const scan = app.scanNow();
      if (migrate) bump(path);
      await scan;
      const n = one(app, "SELECT COUNT(*) AS n FROM session_tags");
      app.close();
      return n;
    };

    expect(await tagged("labeler-control", false)).toBe(1);
    expect(await tagged("labeler-migrated", true)).toBe(0);
  });
});
