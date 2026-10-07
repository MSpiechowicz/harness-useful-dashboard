import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { cursorEvent, cursorStatePath, readCursorLogin, syncCursor, syncState } from "../src/core/cursorSync.ts";
import { CURSOR_REKEY, importCursorCsv } from "../src/core/ingest/cursor.ts";
import { DbWriter } from "../src/core/ingest/writer.ts";
import { PriceBook } from "../src/core/pricing.ts";
import { ID, memDb, tempDir } from "./helpers.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A JWT shaped like Cursor's login: only its claims matter here, the signature is never checked. */
function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}
const TOKEN = jwt({ sub: "auth0|user_01ABCXYZ", exp: (NOW + 30 * DAY) / 1000 });

let home: string;
const deps = (fetchImpl: typeof fetch, now = NOW) => ({ home, platform: "linux" as const, env: {}, now: () => now, fetch: fetchImpl });

/** Cursor's state.vscdb, with the VS Code key/value table and the given keys. */
function writeState(values: Record<string, string | Uint8Array>) {
  const path = cursorStatePath({ home, platform: "linux", env: {} });
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new Database(path);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  for (const [k, v] of Object.entries(values)) db.query("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(k, v);
  db.close();
}

/** A usage event as cursor.com's dashboard API answers it. */
function event(ts: number, over: Record<string, unknown> = {}) {
  return {
    timestamp: String(ts),
    model: "claude-4.5-sonnet",
    kind: "USAGE_EVENT_KIND_INCLUDED_IN_PRO",
    maxMode: false,
    requestsCosts: 1,
    isTokenBasedCall: true,
    chargedCents: 0,
    owningUser: "123456",
    tokenUsage: { inputTokens: 200, outputTokens: 300, cacheWriteTokens: 1000, cacheReadTokens: 5000, totalCents: 4.2 },
    ...over,
  };
}

interface Call {
  url: string;
  init: RequestInit;
  body: { startDate: string; endDate: string; page: number; pageSize: number };
}

/** A fetch that answers from a list of events, a page at a time, and records what it was asked. */
function mockApi(events: ReturnType<typeof event>[], respond?: (call: Call) => Response | null) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init, body: JSON.parse(String(init.body)) };
    calls.push(call);
    const special = respond?.(call);
    if (special) return special;
    const { startDate, endDate, page, pageSize } = call.body;
    const inRange = events.filter((e) => Number(e.timestamp) >= Number(startDate) && Number(e.timestamp) <= Number(endDate)).sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    if (!inRange.length) return Response.json({});
    const slice = inRange.slice((page - 1) * pageSize, page * pageSize);
    return Response.json(slice.length ? { totalUsageEventsCount: inRange.length, usageEventsDisplay: slice } : { totalUsageEventsCount: inRange.length });
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

const writer = (db: Database) => () => new DbWriter(db, new PriceBook(), ID);
const usageCount = (db: Database) => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage").get()!.n;

beforeEach(() => {
  home = tempDir("hd-cursor-");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("Cursor login", () => {
  test("is read from Cursor's state.vscdb on each OS", () => {
    expect(cursorStatePath({ home: "/h", platform: "linux", env: {} })).toBe(join("/h", ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorStatePath({ home: "/h", platform: "linux", env: { XDG_CONFIG_HOME: "/x" } })).toBe(join("/x", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorStatePath({ home: "/h", platform: "darwin", env: {} })).toBe(join("/h", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));
    expect(cursorStatePath({ home: "/h", platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" } })).toBe(join("C:\\Users\\me\\AppData\\Roaming", "Cursor", "User", "globalStorage", "state.vscdb"));
  });

  test("makes the session cookie from the user id and the token, from text or bytes", () => {
    writeState({ "cursorAuth/accessToken": TOKEN, "cursorAuth/cachedEmail": "me@example.com" });
    expect(readCursorLogin(deps(fetch))).toEqual({ cookie: `user_01ABCXYZ%3A%3A${TOKEN}`, expiresAt: NOW + 30 * DAY });
    writeState({ "cursorAuth/accessToken": new TextEncoder().encode(TOKEN) });
    expect(readCursorLogin(deps(fetch))?.cookie).toBe(`user_01ABCXYZ%3A%3A${TOKEN}`);
    writeState({ "cursorAuth/accessToken": Buffer.from(TOKEN, "utf16le") });
    expect(readCursorLogin(deps(fetch))?.cookie).toBe(`user_01ABCXYZ%3A%3A${TOKEN}`);
  });

  test("is none without Cursor, without a login, or with something that isn't one", () => {
    expect(readCursorLogin(deps(fetch))).toBeNull();
    writeState({ "cursorAuth/cachedEmail": "me@example.com" });
    expect(readCursorLogin(deps(fetch))).toBeNull();
    writeState({ "cursorAuth/accessToken": "not a token\r\nX-Injected: 1" });
    expect(readCursorLogin(deps(fetch))).toBeNull();
    writeState({ "cursorAuth/accessToken": jwt({ sub: "auth0|bad id\r\n" }) });
    expect(readCursorLogin(deps(fetch))).toBeNull();
  });

  test("Cursor's database is only read", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const path = cursorStatePath({ home, platform: "linux", env: {} });
    const before = await Bun.file(path).bytes();
    readCursorLogin(deps(fetch));
    expect(await Bun.file(path).bytes()).toEqual(before);
  });
});

describe("Cursor usage events", () => {
  test("map to rows like the CSV export's", () => {
    expect(cursorEvent(event(NOW))).toEqual({ ts: NOW, user: null, model: "claude-4.5-sonnet", kind: "Included", input: 200, cacheWrite: 1000, cacheRead: 5000, output: 300, cost: null });
    // A call billed by usage carries what it was charged.
    expect(cursorEvent(event(NOW, { kind: "USAGE_EVENT_KIND_USAGE_BASED", chargedCents: 11 }))).toMatchObject({ kind: "On-Demand", cost: 0.11 });
    // Numbers come as strings too, and cache writes can be missing.
    expect(cursorEvent(event(NOW, { tokenUsage: { inputTokens: "7", outputTokens: 3, cacheReadTokens: "2" } }))).toMatchObject({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0 });
    expect(cursorEvent(event(NOW, { timestamp: "nope" }))).toBeNull();
  });
});

describe("Cursor sync", () => {
  test("off: asks nothing and writes nothing", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const api = mockApi([event(NOW - HOUR)]);
    await syncCursor(db, ID.host, writer(db), { enabled: false, force: true }, deps(api.fetch));
    expect(api.calls).toHaveLength(0);
    expect(usageCount(db)).toBe(0);
  });

  test("sends the login as cursor.com's session cookie, to cursor.com only, over HTTPS, and never logs it", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const api = mockApi([event(NOW - HOUR)]);
    const log = spyOn(console, "error");
    const warn = spyOn(console, "warn");
    const info = spyOn(console, "log");
    try {
      const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch));
      expect(state).toMatchObject({ syncedAt: NOW, added: 1, code: null, cursor: NOW - HOUR, nextAt: NOW + 6 * HOUR });
      expect(api.calls).toHaveLength(1);
      const [call] = api.calls;
      expect(call!.url).toBe("https://cursor.com/api/dashboard/get-filtered-usage-events");
      expect(call!.url).not.toContain(TOKEN);
      expect(call!.init).toMatchObject({ method: "POST", redirect: "error" });
      const headers = call!.init.headers as Record<string, string>;
      expect(headers.Cookie).toBe(`WorkosCursorSessionToken=user_01ABCXYZ%3A%3A${TOKEN}`);
      expect(headers.Origin).toBe("https://cursor.com");
      expect(headers.Authorization).toBeUndefined();
      expect(String(call!.init.body)).not.toContain(TOKEN);
      expect(call!.body).toMatchObject({ startDate: String(NOW - 30 * DAY), endDate: String(NOW), page: 1 });
      const printed = [...log.mock.calls, ...warn.mock.calls, ...info.mock.calls].flat().map(String).join(" ");
      expect(printed).not.toContain(TOKEN.split(".")[1]!);
      // Nothing of the login is kept.
      const meta = db.query<{ value: string }, []>("SELECT group_concat(value) AS value FROM meta").get()!.value;
      expect(meta).not.toContain("user_01ABCXYZ");
      expect(meta).not.toContain(TOKEN.split(".")[1]!);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
    const row = db.query<any, []>("SELECT * FROM usage").get();
    expect(row).toMatchObject({ provider: "cursor", project: "Cursor", model: "claude-4.5-sonnet", agent: "Included", input_tokens: 200, output_tokens: 300, cache_write_tokens: 1000, cache_read_tokens: 5000, user: ID.user, host: ID.host });
  });

  test("reads every page", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const events = Array.from({ length: 1234 }, (_, i) => event(NOW - DAY - i * 60_000, { tokenUsage: { inputTokens: i + 1, outputTokens: 1 } }));
    const api = mockApi(events);
    const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch));
    expect(api.calls.map((c) => c.body.page)).toEqual([1, 2, 3]);
    expect(state.added).toBe(1234);
    expect(usageCount(db)).toBe(1234);
  });

  test("goes on from the newest event synced, and only when due", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const events = [event(NOW - 2 * DAY)];
    const api = mockApi(events);
    await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch));
    // Within 6 hours nothing is asked.
    await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, NOW + HOUR));
    expect(api.calls).toHaveLength(1);
    events.push(event(NOW + 5 * HOUR, { model: "gpt-5" }));
    const later = NOW + 7 * HOUR;
    const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, later));
    expect(api.calls).toHaveLength(2);
    // A day before the newest event: late events are caught, rows already there stay one row.
    expect(api.calls[1]!.body).toMatchObject({ startDate: String(NOW - 3 * DAY), endDate: String(later) });
    expect(state).toMatchObject({ syncedAt: later, added: 1, cursor: NOW + 5 * HOUR });
    expect(usageCount(db)).toBe(2);
  });

  test("counts a call once whether it came from a CSV import or a sync", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const ts = NOW - 3 * HOUR;
    importCursorCsv(
      `Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"${new Date(ts).toISOString()}","","","Included","claude-4.5-sonnet","No","1000","200","5000","300","6500","Included"
"${new Date(ts - HOUR).toISOString()}","","","On-Demand","gpt-5","No","0","100","0","50","150","0.11"
`,
      writer(db)(),
    );
    expect(usageCount(db)).toBe(2);
    const api = mockApi([event(ts), event(ts - HOUR, { model: "gpt-5", kind: "USAGE_EVENT_KIND_USAGE_BASED", chargedCents: 11, tokenUsage: { inputTokens: 100, outputTokens: 50, totalCents: 11 } }), event(ts - 2 * HOUR, { model: "gpt-5" })]);
    const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch));
    expect(state.added).toBe(1);
    expect(usageCount(db)).toBe(3);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()!.n).toBe(1);
    // And the other way round: importing the CSV after the sync adds nothing.
    importCursorCsv(`Date,Kind,Model,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Cost\n"${new Date(ts - 2 * HOUR).toISOString()}","Included","gpt-5","1000","200","5000","300","Included"\n`, writer(db)());
    expect(usageCount(db)).toBe(3);
  });

  test("rows imported before keep counting once (migration 13)", () => {
    const db = memDb();
    db.query(
      `INSERT INTO usage (id, provider, session_id, ts, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ('cursor:0123456789abcdef0123', 'cursor', 's', 1000, 'gpt-5', 1, 2, 3, 4)`,
    ).run();
    db.exec(CURSOR_REKEY);
    expect(db.query<{ id: string }, []>("SELECT id FROM usage").get()!.id).toBe("cursor:1000:gpt-5:1:4:3:2");
  });

  test("not signed in, or an expired login: nothing is sent and the login is not renewed", async () => {
    const db = memDb();
    const api = mockApi([event(NOW - HOUR)]);
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch))).toMatchObject({ code: "not-signed-in", nextAt: NOW + 10 * 60_000 });
    writeState({ "cursorAuth/accessToken": jwt({ sub: "auth0|user_01ABCXYZ", exp: (NOW - HOUR) / 1000 }), "cursorAuth/refreshToken": "refresh-secret" });
    const later = NOW + 11 * 60_000;
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, later))).toMatchObject({ code: "expired", nextAt: later + 10 * 60_000 });
    expect(api.calls).toHaveLength(0);
  });

  test("a refused login is reported, and not sent again until Cursor signs in anew", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const api = mockApi([], () => new Response("<html>secret provider text</html>", { status: 401 }));
    const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch));
    expect(state.code).toBe("unauthorized");
    expect(JSON.stringify(state)).not.toContain("secret provider text");
    await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, NOW + HOUR));
    expect(api.calls).toHaveLength(1);
    // A new login (a new expiry) is tried.
    writeState({ "cursorAuth/accessToken": jwt({ sub: "auth0|user_01ABCXYZ", exp: (NOW + 40 * DAY) / 1000 }) });
    await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, NOW + 2 * HOUR));
    expect(api.calls).toHaveLength(2);
  });

  test("rate limited: waits what cursor.com asks, at least 30 minutes, and Sync now waits too", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    let limited = true;
    const api = mockApi([event(NOW - HOUR)], () => (limited ? new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } }) : null));
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch))).toMatchObject({ code: "rate-limited", nextAt: NOW + HOUR, failures: 1 });
    await syncCursor(db, ID.host, writer(db), { enabled: true, force: true }, deps(api.fetch, NOW + 30 * 60_000));
    expect(api.calls).toHaveLength(1);
    limited = false;
    const state = await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch, NOW + HOUR));
    expect(state).toMatchObject({ code: null, added: 1, failures: 0 });
    expect(api.calls).toHaveLength(2);
  });

  test("an answer that isn't usage (a challenge page) fails with a code, and writes nothing", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const api = mockApi([], () => new Response("<html>checking your browser</html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch))).toMatchObject({ code: "failed", nextAt: NOW + 30 * 60_000 });
    const down = mockApi([], () => {
      throw new TypeError("redirect");
    });
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true, force: true }, deps(down.fetch, NOW + 2 * HOUR))).toMatchObject({ code: "unreachable" });
    expect(usageCount(db)).toBe(0);
    expect(syncState(db, ID.host).syncedAt).toBeNull();
  });

  test("an empty range is no error", async () => {
    writeState({ "cursorAuth/accessToken": TOKEN });
    const db = memDb();
    const api = mockApi([]);
    expect(await syncCursor(db, ID.host, writer(db), { enabled: true }, deps(api.fetch))).toMatchObject({ code: null, added: 0, syncedAt: NOW });
  });
});
