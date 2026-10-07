import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getMeta, openDb, SCHEMA_VERSION } from "../src/core/db.ts";
import type { UsageRecord } from "../src/core/ingest/types.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { Queries, whereClause } from "../src/core/queries.ts";
import { friction } from "../src/core/friction.ts";
import { lines } from "../src/core/changes.ts";
import { addTag, allTags, normalizeNote, normalizeTag, projectRules, removeTag, sessionTags, setNote, setProjectRules, tagsForSessions } from "../src/core/tags.ts";
import { tagUsage } from "../src/core/tagUsage.ts";
import { usageReport } from "../src/core/reports.ts";
import { App } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { ID, memDb, tempDir } from "./helpers.ts";

const T0 = new Date(2026, 8, 1, 12, 0, 0).getTime();

function usage(over: Partial<UsageRecord> & { id: string }): UsageRecord {
  return {
    provider: "claude", sessionId: "claude:s1", promptId: null, ts: T0, project: "/work/alpha", model: "claude-sonnet-4-5",
    skill: null, agent: "main", isSubagent: false, input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
    ...over,
  };
}

/** s1 (alpha), s2 (beta) with the subagent session c2, s3 (gamma, untagged). */
function seed() {
  const db = memDb();
  const prices = new PriceBook();
  const w = new DbWriter(db, prices, ID);
  w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: "/work/alpha", title: "Alpha" });
  w.session({ id: "codex:s2", provider: "codex", nativeId: "s2", project: "/work/beta", title: "Beta" });
  w.session({ id: "codex:c2", provider: "codex", nativeId: "c2", project: "/work/beta", parentSessionId: "codex:s2", agent: "worker" });
  w.session({ id: "claude:s3", provider: "claude", nativeId: "s3", project: "/work/gamma", title: "Gamma" });
  w.usage(usage({ id: "u1" }));
  w.usage(usage({ id: "u2", sessionId: "codex:s2", provider: "codex", project: "/work/beta", model: "gpt-5" }));
  w.usage(usage({ id: "u3", sessionId: "codex:c2", provider: "codex", project: "/work/beta", model: "gpt-5", agent: "worker", isSubagent: true, output: 5000 }));
  w.usage(usage({ id: "u4", sessionId: "claude:s3", project: "/work/gamma" }));
  w.tool({ id: "t1", usageId: "u1", sessionId: "claude:s1", promptId: null, provider: "claude", ts: T0, project: "/work/alpha", tool: "Edit", filePath: "/work/alpha/a.ts", skill: null, agent: "main", linesAdded: 10, linesRemoved: 2 });
  w.tool({ id: "t2", usageId: "u3", sessionId: "codex:c2", promptId: null, provider: "codex", ts: T0, project: "/work/beta", tool: "Edit", filePath: "/work/beta/b.ts", skill: null, agent: "worker", linesAdded: 4, linesRemoved: 0 });
  return { db, q: new Queries(db, () => prices) };
}

describe("tag and note input", () => {
  test("tags are trimmed and lowercased, odd ones refused", () => {
    expect(normalizeTag("  Acme ")).toBe("acme");
    expect(normalizeTag("#Q3 billable")).toBe("q3-billable");
    expect(normalizeTag("client:acme/web")).toBe("client:acme/web");
    expect(normalizeTag("Łódź")).toBe("łódź");
    for (const bad of ["", "   ", "-x", "a b;c", "a'b", "<b>", "x".repeat(33), "(none)", 5, null, {}]) expect(normalizeTag(bad)).toBeNull();
  });
  test("notes keep line breaks, lose secrets and are capped", () => {
    expect(normalizeNote("  one\r\ntwo  ")).toBe("one\ntwo");
    expect(normalizeNote("key sk-ant-" + "a".repeat(30))).toContain("[redacted]");
    expect(normalizeNote("x".repeat(2001))).toBeNull();
    expect(normalizeNote(5)).toBeNull();
  });
});

describe("storage", () => {
  test("adds, removes, dedupes and checks the session", () => {
    const { db } = seed();
    expect(addTag(db, "claude:s1", "Acme")).toEqual({ ok: ["acme"] });
    expect(addTag(db, "claude:s1", "acme")).toEqual({ ok: ["acme"] });
    expect(addTag(db, "claude:s1", "billable")).toEqual({ ok: ["acme", "billable"] });
    expect(addTag(db, "nope", "acme")).toEqual({ error: "unknown session" });
    expect("error" in addTag(db, "claude:s1", "a;b")).toBe(true);
    expect(removeTag(db, "claude:s1", "ACME")).toEqual({ ok: ["billable"] });
    expect(allTags(db)).toEqual([{ tag: "billable", sessions: 1 }]);
  });
  test("a session takes a limited number of tags", () => {
    const { db } = seed();
    for (let i = 0; i < 20; i++) expect("ok" in addTag(db, "claude:s1", `t${i}`)).toBe(true);
    expect("error" in addTag(db, "claude:s1", "one-more")).toBe(true);
    expect("ok" in addTag(db, "claude:s1", "t3")).toBe(true);
  });
  test("a note is saved, replaced and removed when empty", () => {
    const { db } = seed();
    expect(setNote(db, "claude:s1", "first", 5)).toEqual({ ok: { note: "first", updatedAt: 5 } });
    expect(sessionTags(db, "claude:s1").note).toEqual({ note: "first", updatedAt: 5 });
    setNote(db, "claude:s1", "second", 6);
    expect(sessionTags(db, "claude:s1").note?.note).toBe("second");
    expect(setNote(db, "claude:s1", "  ")).toEqual({ ok: null });
    expect(sessionTags(db, "claude:s1").note).toBeNull();
    expect("error" in setNote(db, "claude:s1", "x".repeat(2001))).toBe(true);
    expect("error" in setNote(db, "ghost", "x")).toBe(true);
  });
  test("project rules are replaced as a whole and validated", () => {
    const { db } = seed();
    expect(setProjectRules(db, [{ project: "/work/alpha", tag: "Acme" }])).toEqual({ ok: [{ project: "/work/alpha", tag: "acme" }] });
    expect("error" in setProjectRules(db, [{ project: "", tag: "x" }])).toBe(true);
    expect("error" in setProjectRules(db, "nope")).toBe(true);
    expect(projectRules(db)).toEqual([{ project: "/work/alpha", tag: "acme" }]);
    expect(setProjectRules(db, [])).toEqual({ ok: [] });
  });
  test("tags of sessions come from the session, its parent and its project", () => {
    const { db } = seed();
    addTag(db, "codex:s2", "beta");
    setProjectRules(db, [{ project: "/work/beta", tag: "client" }]);
    const m = tagsForSessions(db, ["claude:s1", "codex:s2", "codex:c2", "claude:s3"]);
    expect(m.get("codex:s2")).toEqual(["beta", "client"]);
    expect(m.get("codex:c2")).toEqual(["beta", "client"]);
    expect(m.has("claude:s1")).toBe(false);
    const s = sessionTags(db, "codex:c2");
    expect(s.tags).toEqual([]);
    expect(s.inherited).toEqual(["beta"]);
    expect(s.rule).toBe("client");
  });
});

describe("tag filter", () => {
  test("covers the tagged session and its subagents' sessions, nothing else", () => {
    const { db, q } = seed();
    addTag(db, "codex:s2", "acme");
    const only = q.summary({ tag: "acme" });
    expect(only.sessions).toBe(2);
    expect(only.messages).toBe(2);
    expect(q.summary({ tag: "other" }).messages).toBe(0);
    expect(q.summary({}).messages).toBe(4);
    const rows = q.sessions({ tag: "acme" }, {}).rows.map((r) => r.id).sort();
    expect(rows).toEqual(["codex:c2", "codex:s2"]);
  });
  test("a project's default tag reaches all its rows", () => {
    const { db, q } = seed();
    setProjectRules(db, [{ project: "/work/alpha", tag: "acme" }]);
    expect(q.summary({ tag: "acme" }).sessions).toBe(1);
    addTag(db, "claude:s3", "acme");
    expect(q.summary({ tag: "acme" }).sessions).toBe(2);
  });
  test("works in the other views that filter", () => {
    const { db } = seed();
    addTag(db, "claude:s1", "acme");
    expect(lines(db, { tag: "acme" }).total.added).toBe(10);
    expect(lines(db, {}).total.added).toBe(14);
    expect(friction(db, { tag: "acme" }, "day").totals).toBeDefined();
  });
  test("the clause is parameterised and also fits tool calls", () => {
    const w = whereClause({ tag: "x'; drop" }, "t");
    expect(w.params.tag).toBe("x'; drop");
    expect(w.sql).toContain("t.session_id IN");
    expect(w.sql).not.toContain("drop");
  });
  test("the filter options list every tag", () => {
    const { db, q } = seed();
    addTag(db, "claude:s1", "acme");
    expect(q.filters({}).tag).toEqual([{ value: "acme", label: "acme", n: 1 }]);
  });
  test("sessions are searched by tag, and carry their tags", () => {
    const { db, q } = seed();
    addTag(db, "codex:s2", "billable");
    const found = q.sessions({}, { q: "billa" }).rows.map((r) => r.id).sort();
    expect(found).toEqual(["codex:c2", "codex:s2"]);
    expect(q.sessions({}, {}).rows.find((r) => r.id === "codex:s2")?.tags).toEqual(["billable"]);
  });
});

describe("breakdown by tag", () => {
  test("sums per tag, a multi-tag session counts in each, untagged apart", () => {
    const { db, q } = seed();
    addTag(db, "claude:s1", "acme");
    addTag(db, "claude:s1", "billable");
    addTag(db, "codex:s2", "billable");
    const r = tagUsage(db, {});
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    const total = q.summary({});
    expect(r.total.cost).toBeCloseTo(total.cost, 9);
    expect(by["acme"]!.sessions).toBe(1);
    expect(by["billable"]!.sessions).toBe(3);
    expect(by["billable"]!.cost).toBeCloseTo(q.summary({ tag: "billable" }).cost, 9);
    expect(by["(none)"]!.sessions).toBe(1);
    // Sessions with several tags make the rows add up to more than the total.
    expect(r.rows.reduce((a, x) => a + x.cost, 0)).toBeGreaterThan(r.total.cost);
    // Lines changed follow the tag, a subagent's edits included.
    expect(by["acme"]!.changed).toBe(12);
    expect(by["billable"]!.changed).toBe(16);
    expect(by["acme"]!.costPer100).not.toBeNull();
  });
  test("the report command can group by tag", () => {
    const { db, q } = seed();
    addTag(db, "claude:s1", "acme");
    const report = usageReport({ db, queries: q, budgets: {} as never, user: "x", host: "h", now: T0 + 1000 } as never, { by: "tag", range: "all" });
    expect(report.rows.map((r) => r.key).sort()).toEqual(["(none)", "acme"]);
    expect(usageReport({ db, queries: q, now: T0 } as never, { by: "project", range: "all", tag: "ACME" }).filters).toEqual({ tag: "acme" });
  });
});

describe("migration", () => {
  test("an older database gets the tables and keeps its data", () => {
    const dir = tempDir();
    const path = join(dir, "old.db");
    const db = openDb(path);
    db.exec("DROP TABLE session_tags; DROP TABLE session_notes; DROP TABLE project_tags; UPDATE meta SET value = '14' WHERE key = 'schema_version'");
    db.close();
    const again = openDb(path);
    expect(Number(getMeta(again, "schema_version"))).toBe(SCHEMA_VERSION);
    expect(addTag(again, "x", "a")).toEqual({ error: "unknown session" });
    expect(again.query("SELECT COUNT(*) AS n FROM session_notes").get()).toEqual({ n: 0 });
    again.close();
    const check = new Database(path, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE name = 'idx_session_tags_tag'").get()).toBeTruthy();
    check.close();
  });
});

describe("API", () => {
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;
  const token = "c".repeat(64);
  const hdr = { host: "localhost:4317", "x-harness-dashboard": "1", "content-type": "application/json", authorization: `Bearer ${token}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = hdr) =>
    handle(new Request(`http://localhost:4317${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));

  beforeAll(() => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false } } }));
    app = new App(join(root, "test.db"));
    const w = new DbWriter(app.db, new PriceBook(), ID);
    w.session({ id: "claude:s1", provider: "claude", nativeId: "s1", project: "/work/alpha", title: "Alpha" });
    w.usage(usage({ id: "u1" }));
    handle = createHandler(app, { get: async () => null }, { restart() {}, shutdown() {} }, { token, port: 4317 });
  });
  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
  });

  test("tags and notes need the sign-in and the CSRF header", async () => {
    const noAuth = { host: "localhost:4317", "x-harness-dashboard": "1", "content-type": "application/json" };
    expect((await call("POST", "/api/tags", { session: "claude:s1", tag: "acme" }, noAuth)).status).toBe(401);
    const noCsrf = { host: "localhost:4317", authorization: `Bearer ${token}`, "content-type": "application/json" };
    for (const [m, p] of [["POST", "/api/tags"], ["DELETE", "/api/tags"], ["PUT", "/api/session/note"], ["PUT", "/api/tags/rules"]] as const) {
      expect((await call(m, p, { session: "claude:s1", tag: "acme", note: "x", rules: [] }, noCsrf)).status).toBe(403);
    }
    expect((await call("POST", "/api/tags", { session: "claude:s1", tag: "acme" }, { ...hdr, "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("add, list, filter, note and remove", async () => {
    expect(await (await call("POST", "/api/tags", { session: "claude:s1", tag: " Acme " })).json()).toEqual(["acme"]);
    const detail = (await (await call("GET", "/api/session?id=claude:s1")).json()) as { tags: string[]; note: unknown };
    expect(detail.tags).toEqual(["acme"]);
    expect(((await (await call("GET", "/api/tags?range=all")).json()) as { rows: { key: string }[] }).rows[0]!.key).toBe("acme");
    expect(((await (await call("GET", "/api/summary?tag=ACME")).json()) as { sessions: number }).sessions).toBe(1);
    expect(((await (await call("GET", "/api/summary?tag=nope")).json()) as { sessions: number }).sessions).toBe(0);
    expect(((await (await call("GET", "/api/filters")).json()) as { tag: unknown[] }).tag).toHaveLength(1);
    const note = (await (await call("PUT", "/api/session/note", { session: "claude:s1", note: "token sk-ant-" + "b".repeat(30) })).json()) as { note: string };
    expect(note.note).toContain("[redacted]");
    expect(await (await call("DELETE", "/api/tags", { session: "claude:s1", tag: "acme" })).json()).toEqual([]);
    expect(await (await call("PUT", "/api/session/note", { session: "claude:s1", note: "" })).json()).toBeNull();
  });

  test("odd input is refused", async () => {
    for (const body of [{ session: "claude:s1", tag: "a;b" }, { session: "claude:s1", tag: "x".repeat(40) }, { session: "ghost", tag: "ok" }, { tag: "ok" }, { session: 5, tag: "ok" }]) {
      expect((await call("POST", "/api/tags", body)).status).toBe(400);
    }
    expect((await call("PUT", "/api/session/note", { session: "claude:s1", note: "x".repeat(5000) })).status).toBe(400);
    expect((await call("PUT", "/api/tags/rules", { rules: [{ project: "/p", tag: "bad tag;" }] })).status).toBe(400);
    expect((await call("POST", "/api/tags", "not json" as never)).status).toBe(400);
    expect((await call("DELETE", "/api/scan")).status).toBe(404);
    expect((await call("GET", "/api/tags?tag=" + "x".repeat(5000))).status).toBe(200);
  });

  test("project rules round trip", async () => {
    expect(await (await call("PUT", "/api/tags/rules", { rules: [{ project: "/work/alpha", tag: "Client-A" }] })).json()).toEqual([{ project: "/work/alpha", tag: "client-a" }]);
    expect(await (await call("GET", "/api/tags/rules")).json()).toEqual([{ project: "/work/alpha", tag: "client-a" }]);
    expect(((await (await call("GET", "/api/summary?tag=client-a")).json()) as { sessions: number }).sessions).toBe(1);
  });
});
