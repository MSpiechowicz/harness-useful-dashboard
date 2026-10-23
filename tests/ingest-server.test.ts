import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { type AppConfig, defaultConfig } from "../src/core/config.ts";
import { openDb } from "../src/core/db.ts";
import { MAX_HOSTS } from "../src/core/otlp/map.ts";
import * as otlpWrite from "../src/core/otlp/write.ts";
import { MAX_RECORDS } from "../src/core/otlp/write.ts";
import { App, type AppEvent } from "../src/server/app.ts";
import { createHandler } from "../src/server/http.ts";
import { addressKey, bindError, type IngestApp, type IngestDeps, IngestServer, type IngestStatus, isLoopbackPeer, MAX_BODY } from "../src/server/ingest.ts";
import { AUTH_FILE, IngestAuth } from "../src/server/ingestAuth.ts";
import { claudeLogs, encodeTraces, hermesSpans, logsJson, T0 } from "./otlpEncode.ts";
import { tempDir } from "./helpers.ts";

const OFF = { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false };
const PASSWORD = "correct horse battery";
const SECRET = /hd_ing_[0-9a-f]{64}/;

let root: string;
let home: string;
let app: App;
let auth: IngestAuth;
let token: string;
let now = Date.now();
const prevHome = process.env.HARNESS_DASHBOARD_HOME;

beforeAll(async () => {
  root = tempDir();
  home = join(root, "home");
  process.env.HARNESS_DASHBOARD_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: OFF } }));
  app = new App(join(root, "test.db"));
  auth = new IngestAuth(home);
  const made = auth.addToken("ci");
  if ("error" in made) throw new Error(made.error);
  token = made.token;
  await auth.setBasic("hermes", PASSWORD);
});

afterAll(() => {
  app.close();
  process.env.HARNESS_DASHBOARD_HOME = prevHome;
});

/** A listener on the test app, with its own clock and failure counts. */
const listener = (over: Partial<IngestApp> = {}, deps: Partial<IngestDeps> = {}) => {
  const target: IngestApp = {
    get cfg() {
      return app.cfg;
    },
    get db() {
      return app.db;
    },
    get identity() {
      return app.identity;
    },
    writable: () => app.writable(),
    priceBook: () => app.priceBook(),
    emit: (e: AppEvent) => app.emit(e),
    ...over,
  };
  return new IngestServer({ app: target, auth, now: () => now, ...deps });
};

/** Credentials whose password checks are counted, take `ms` each and never pass. */
async function slowAuth(ms: number) {
  const stats = { verifies: 0 };
  const slow = new IngestAuth(join(tempDir(), "home"), () => now, async () => {
    stats.verifies++;
    await Bun.sleep(ms);
    return false;
  });
  await slow.setBasic("hermes", PASSWORD);
  return { auth: slow, stats };
}

/** Credentials checked at once: the password passes when it is PASSWORD. Each check is counted. */
async function fastAuth() {
  const stats = { verifies: 0 };
  const fast = new IngestAuth(join(tempDir(), "home"), () => now, async (password) => {
    stats.verifies++;
    return password === PASSWORD;
  });
  await fast.setBasic("hermes", PASSWORD);
  const made = fast.addToken("fast");
  if ("error" in made) throw new Error(made.error);
  return { auth: fast, stats, token: made.token };
}

const wrongPassword = (i: number) => `Basic ${Buffer.from(`hermes:wrong password ${i}`).toString("base64")}`;
const rightPassword = `Basic ${Buffer.from(`hermes:${PASSWORD}`).toString("base64")}`;
/** A token of the form tokens have, that is none of them. */
const wrongToken = (i: number) => `Bearer hd_ing_${i.toString(16).padStart(64, "0")}`;
const statusCounts = (responses: Response[]) => {
  const out: Record<number, number> = {};
  for (const r of responses) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
};

type Body = Uint8Array | string;
const post = (server: IngestServer, path: string, body: Body, headers: Record<string, string> = {}, ip = "10.0.0.1", method = "POST") =>
  server.handle(
    new Request(`http://ingest.local${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf", ...headers },
      body: method === "GET" || method === "HEAD" ? undefined : body,
    }),
    ip,
  );

/** A Hermes turn from `host`, in a trace of its own: rows are written once, under the host that sent them first. */
const spansFrom = (host: string) => {
  const traceId = createHash("sha256").update(host).digest("hex").slice(0, 32);
  return encodeTraces(hermesSpans({ host }).map((r) => ({ ...r, records: r.records.map((s) => ({ ...s, traceId })) })));
};
const traces = () => spansFrom("build-box");
const usageOf = (host: string) => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage WHERE host = ?").get(host)!.n;

/** An export of more spans than one request may carry, each tiny. */
function tooManySpans(): Uint8Array {
  const records = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => ({
    traceId: "a".repeat(32), spanId: i.toString(16).padStart(16, "0"), name: "x", startMs: T0, endMs: T0 + 1,
  }));
  return encodeTraces([{ resource: { "service.name": "hermes" }, records }]);
}

describe("OTLP listener requests", () => {
  test("a protobuf trace export is written under the remote host and answered with an empty protobuf", async () => {
    const server = listener();
    const res = await post(server, "/v1/traces", traces());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(usageOf("build-box")).toBe(2);
    expect(server.stats()).toEqual({ lastAt: now, lastHost: "build-box", usage: 2, rejected: 0, metricsOnly: false, skipped: 0, lastSkipReason: null, lastVscodeAt: null });
  });

  test("an OTLP/JSON log export is answered with {}", async () => {
    const res = await post(listener(), "/v1/logs", logsJson(claudeLogs({ host: "laptop-2" })), { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
    expect(usageOf("laptop-2")).toBe(1);
  });

  test("a gzip body is inflated, and one that inflates past the cap is refused without inflating it all", async () => {
    const server = listener();
    expect((await post(server, "/v1/traces", gzipSync(traces()), { "content-encoding": "gzip" })).status).toBe(200);

    // 64 KiB on the wire, four times the cap inflated.
    const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024), { level: 9 });
    expect(bomb.length).toBeLessThan(MAX_BODY);
    const started = performance.now();
    const res = await post(server, "/v1/traces", bomb, { "content-encoding": "gzip" });
    expect(res.status).toBe(413);
    expect(performance.now() - started).toBeLessThan(5000);

    expect((await post(server, "/v1/traces", "not gzip", { "content-encoding": "gzip" })).status).toBe(400);
  });

  test("a body too large on the wire, or with too many records, is refused with 413", async () => {
    const server = listener();
    expect((await post(server, "/v1/traces", new Uint8Array(MAX_BODY + 1))).status).toBe(413);
    expect((await post(server, "/v1/traces", tooManySpans())).status).toBe(413);
    expect(server.stats().rejected).toBe(2);
  });

  test("a body that is no OTLP export is refused with 400", async () => {
    const server = listener();
    expect((await post(server, "/v1/logs", "not json", { "content-type": "application/json" })).status).toBe(400);
    expect((await post(server, "/v1/traces", Uint8Array.from([0x0a, 0x05, 0x01]))).status).toBe(400);
  });

  test("only POST to the three OTLP paths is served", async () => {
    const server = listener();
    expect((await post(server, "/api/status", "", {}, undefined, "GET")).status).toBe(404);
    expect((await post(server, "/v1/traces/extra", traces())).status).toBe(404);
    for (const method of ["GET", "OPTIONS", "PUT", "DELETE"]) {
      const res = await post(server, "/v1/traces", "", {}, undefined, method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  test("a sender without a valid token or password gets 401 with a basic auth challenge", async () => {
    const server = listener();
    for (const authorization of ["", "Bearer nope", `Bearer hd_ing_${"0".repeat(64)}`, `Basic ${Buffer.from("hermes:wrong password").toString("base64")}`]) {
      const res = await post(server, "/v1/traces", traces(), { authorization }, `10.1.0.${authorization.length}`);
      expect(res.status, authorization).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Basic realm="harness-dashboard"');
    }
    const basic = `Basic ${Buffer.from(`hermes:${PASSWORD}`).toString("base64")}`;
    expect((await post(server, "/v1/traces", traces(), { authorization: basic })).status).toBe(200);
  });

  test("a revoked token is refused on the next request", async () => {
    const made = auth.addToken("short-lived");
    if ("error" in made) throw new Error(made.error);
    const server = listener();
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${made.token}` })).status).toBe(200);

    new IngestAuth(home).revokeToken(made.item.id);
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${made.token}` })).status).toBe(401);
  });

  test("an address with 10 wrong passwords in a minute waits for basic auth, with Retry-After, and others don't", async () => {
    const { auth: fast, token: fastToken } = await fastAuth();
    const server = listener({}, { auth: fast });
    const ip = "192.0.2.7";
    for (let i = 0; i < 10; i++) expect((await post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, ip)).status).toBe(401);

    const blocked = await post(server, "/v1/traces", traces(), { authorization: rightPassword }, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, "192.0.2.8")).status).toBe(200);
    // A token is never held back by failed passwords.
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${fastToken}` }, ip)).status).toBe(200);

    now += 61_000;
    expect((await post(server, "/v1/traces", traces(), { authorization: wrongPassword(99) }, ip)).status).toBe(401);
  });

  test("requests without a sign-in, or with wrong tokens, never lock out a valid token or a password", async () => {
    const { auth: fast, stats, token: fastToken } = await fastAuth();
    const server = listener({}, { auth: fast });
    const ip = "203.0.113.7";
    // What a web page can post at the listener without a preflight: no Authorization, text/plain.
    const simple = () => server.handle(new Request("http://ingest.local/v1/logs", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), ip);
    for (let i = 0; i < 10; i++) expect((await simple()).status).toBe(401);
    for (const authorization of Array.from({ length: 10 }, (_, i) => [`Bearer nope-${i}`, `Digest ${i}`][i % 2]!)) {
      expect((await post(server, "/v1/traces", traces(), { authorization }, ip)).status, authorization).toBe(401);
    }
    for (let i = 0; i < 10; i++) expect((await post(server, "/v1/traces", traces(), { authorization: wrongToken(i) }, ip)).status).toBe(401);

    // Past 10 wrong tokens, the next wrong one waits: a valid one still passes, and so does the password.
    const wrong = await post(server, "/v1/traces", traces(), { authorization: wrongToken(10) }, ip);
    expect(wrong.status).toBe(429);
    expect(wrong.headers.get("retry-after")).toBe("60");
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${fastToken}` }, ip)).status).toBe(200);
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, ip)).status).toBe(200);
    expect(stats.verifies).toBe(1);
  });

  test("a basic auth sender's requests at once all pass: a cached header, or the same header while it is checked", async () => {
    const { auth: fast, stats } = await fastAuth();
    const server = listener({}, { auth: fast });
    const ip = "198.51.100.20";
    const both = () =>
      Promise.all([
        post(server, "/v1/traces", traces(), { authorization: rightPassword }, ip),
        post(server, "/v1/logs", logsJson(claudeLogs({ host: "parallel-box" })), { authorization: rightPassword, "content-type": "application/json" }, ip),
      ]);

    expect((await both()).map((r) => r.status)).toEqual([200, 200]);
    expect(stats.verifies).toBe(1);
    for (let i = 0; i < 3; i++) expect((await both()).map((r) => r.status)).toEqual([200, 200]);
    expect(stats.verifies).toBe(1);
  });

  test("failures of 20,000 addresses are counted at once, and never unlock an address that waits", async () => {
    const { auth: fast } = await fastAuth();
    const server = listener({}, { auth: fast });
    const locked = "192.0.2.99";
    for (let i = 0; i < 10; i++) await post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, locked);
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, locked)).status).toBe(429);

    const v6 = (i: number) => `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
    const requests = Array.from({ length: 20_000 }, (_, i) => new Request("http://ingest.local/v1/traces", { method: "POST", headers: { authorization: wrongToken(i) } }));
    const started = performance.now();
    for (let i = 0; i < requests.length; i++) await server.handle(requests[i]!, v6(i));
    expect(performance.now() - started).toBeLessThan(2000);

    // Other addresses' wrong passwords too, as many as may fail in a minute: the address still waits.
    for (let i = 0; i < 589; i++) await post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, `10.9.${i >> 8}.${i & 0xff}`);
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, locked)).status).toBe(429);
  });

  test("past 600 wrong passwords a minute from every address together, basic auth waits with 503 and tokens pass", async () => {
    const { auth: fast, stats, token: fastToken } = await fastAuth();
    const server = listener({}, { auth: fast });
    const cached = "198.51.100.30";
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, cached)).status).toBe(200);

    for (let i = 0; i < 600; i++) expect((await post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, `10.8.${i >> 8}.${i & 0xff}`)).status).toBe(401);
    const checks = stats.verifies;

    const busy = await post(server, "/v1/traces", traces(), { authorization: wrongPassword(1000) }, "10.7.0.1");
    expect(busy.status).toBe(503);
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
    // The right password in a header not checked before waits too.
    const unchecked = rightPassword.replace("Basic ", "basic ");
    expect((await post(server, "/v1/traces", traces(), { authorization: unchecked }, "10.7.0.2")).status).toBe(503);
    expect(stats.verifies).toBe(checks);
    // A header that passed before needs no check, and a token none at all.
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, cached)).status).toBe(200);
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${fastToken}` }, "10.7.0.3")).status).toBe(200);

    now += 61_000;
    expect((await post(server, "/v1/traces", traces(), { authorization: unchecked }, "10.7.0.2")).status).toBe(200);
  });

  test("past 4 bodies being received at once, a sender is told to come back with 503", async () => {
    const server = listener();
    const bytes = spansFrom("held-box");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = () =>
      server.handle(
        new Request("http://ingest.local/v1/traces", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" },
          body: new ReadableStream<Uint8Array>({
            async pull(c) {
              await gate;
              c.enqueue(bytes);
              c.close();
            },
          }),
          duplex: "half",
        } as RequestInit),
        "10.0.0.1",
      );

    const first = Array.from({ length: 4 }, held);
    await Bun.sleep(20);
    const fifth = await post(server, "/v1/traces", traces());
    expect(fifth.status).toBe(503);
    expect(fifth.headers.get("retry-after")).toBe("2");

    release();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await post(server, "/v1/traces", traces())).status).toBe(200);
  });

  test("a body still coming in past its time is answered 408, and its place is free again", async () => {
    const server = listener({}, { bodyTimeoutMs: 100 });
    // A byte every 10 ms, never the end.
    const trickle = () =>
      server.handle(
        new Request("http://ingest.local/v1/traces", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" },
          body: new ReadableStream<Uint8Array>({
            async pull(c) {
              await Bun.sleep(10);
              c.enqueue(Uint8Array.of(0x0a));
            },
          }),
          duplex: "half",
        } as RequestInit),
        "10.0.0.1",
      );

    const slow = Array.from({ length: 4 }, trickle);
    await Bun.sleep(20);
    expect((await post(server, "/v1/traces", traces())).status).toBe(503);

    expect((await Promise.all(slow)).map((r) => r.status)).toEqual([408, 408, 408, 408]);
    expect((await post(server, "/v1/traces", traces())).status).toBe(200);
    expect(server.stats().rejected).toBe(5);
  });

  test("basic auth failures that check no password never make every address wait", async () => {
    const stats = { verifies: 0 };
    const unset = new IngestAuth(join(tempDir(), "home"), () => now, async () => {
      stats.verifies++;
      return false;
    });
    const noUser = listener({}, { auth: unset });
    const from = (i: number) => `10.6.${i >> 8}.${i & 0xff}`;
    // No basic auth user is set: nothing to check a password against.
    const unchecked = [];
    for (let i = 0; i < 1000; i++) unchecked.push((await post(noUser, "/v1/traces", traces(), { authorization: wrongPassword(i) }, from(i))).status);
    expect(statusCounts(unchecked.map((status) => new Response(null, { status })))).toEqual({ 401: 1000 });
    expect(stats.verifies).toBe(0);

    // A header of no user and password, with a user set.
    const { auth: fast, stats: fastStats } = await fastAuth();
    const server = listener({}, { auth: fast });
    const noColon = (i: number) => `Basic ${Buffer.from(`no colon ${i}`).toString("base64")}`;
    for (let i = 0; i < 1000; i++) expect((await post(server, "/v1/traces", traces(), { authorization: noColon(i) }, from(i))).status).toBe(401);
    expect(fastStats.verifies).toBe(0);
    expect((await post(server, "/v1/traces", traces(), { authorization: rightPassword }, "10.5.0.1")).status).toBe(200);
    expect(fastStats.verifies).toBe(1);
  });

  test("basic auth failures that check no password never let an address that waits check passwords again", async () => {
    const { auth: fast, stats } = await fastAuth();
    const server = listener({}, { auth: fast });
    const locked = "203.0.113.9";
    for (let i = 0; i < 10; i++) await post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, locked);
    expect((await post(server, "/v1/traces", traces(), { authorization: wrongPassword(10) }, locked)).status).toBe(429);

    // More addresses than are remembered, each with a header of no user and password.
    const noColon = `Basic ${Buffer.from("no colon").toString("base64")}`;
    const v6 = (i: number) => `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
    for (let i = 0; i < 10_001; i++) await server.handle(new Request("http://ingest.local/v1/traces", { method: "POST", headers: { authorization: noColon } }), v6(i));

    expect((await post(server, "/v1/traces", traces(), { authorization: wrongPassword(11) }, locked)).status).toBe(429);
    expect(stats.verifies).toBe(10);
  });

  test("wrong passwords sent all at once from one address are checked one at a time, at most 10 a minute", async () => {
    const { auth: slow, stats } = await slowAuth(5);
    const server = listener({}, { auth: slow });
    const ip = "198.51.100.9";

    const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, ip)));
    expect(stats.verifies).toBeLessThanOrEqual(10);
    expect(statusCounts(burst)[429]).toBeGreaterThanOrEqual(40);

    for (let i = 0; i < 20; i++) await post(server, "/v1/traces", traces(), { authorization: wrongPassword(100 + i) }, ip);
    expect(stats.verifies).toBe(10);
  });

  test("an IPv6 sender is counted by its /64, and an IPv4 one also when mapped into IPv6", async () => {
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("::ffff:192.0.2.50")).toBe("192.0.2.50");
    expect(addressKey("192.0.2.50")).toBe("192.0.2.50");
    // Also when the mapped IPv4 address is written in hex: never all such senders under one ::/64.
    expect(addressKey("::ffff:102:304")).toBe("1.2.3.4");
    expect(addressKey("0:0:0:0:0:ffff:102:304")).toBe("1.2.3.4");
    expect(addressKey("::FFFF:C000:0232")).toBe("192.0.2.50");
    expect(addressKey("::ffff:0:0")).toBe("0.0.0.0");
    expect(addressKey("::")).toBe("0:0:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("::ffff:1.300.0.0")).toBe("::ffff:1.300.0.0");

    const { auth: fast } = await fastAuth();
    const server = listener({}, { auth: fast });
    // Another wrong password: 429 while the address waits, 401 when it doesn't.
    const signIn = (ip: string, i = 100) => post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, ip);
    for (let i = 1; i <= 10; i++) expect((await signIn(`2001:db8:1:2::${i.toString(16)}`, i)).status).toBe(401);
    expect((await signIn("2001:db8:1:2:ffff::1")).status).toBe(429);
    expect((await signIn("2001:db8:1:3::1")).status).toBe(401);

    for (let i = 0; i < 10; i++) await signIn("::ffff:192.0.2.50", i);
    expect((await signIn("192.0.2.50")).status).toBe(429);
    expect((await signIn("::ffff:c000:232")).status).toBe(429);
    expect((await signIn("::ffff:c000:233")).status).toBe(401);
  });

  test("password checks from many addresses at once past what may wait get 503 with Retry-After", async () => {
    const { auth: slow, stats } = await slowAuth(30);
    const server = listener({}, { auth: slow });

    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => post(server, "/v1/traces", traces(), { authorization: wrongPassword(i) }, `203.0.113.${i + 1}`)));
    expect(statusCounts(responses)).toEqual({ 401: 10, 503: 2 });
    expect(responses.find((r) => r.status === 503)!.headers.get("retry-after")).toBeTruthy();
    expect(stats.verifies).toBe(10);
  });

  test("anything but protobuf or JSON, or another encoding, is refused with 415", async () => {
    const server = listener();
    expect((await post(server, "/v1/traces", traces(), { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(server, "/v1/traces", traces(), { "content-type": "" })).status).toBe(415);
    expect((await post(server, "/v1/traces", traces(), { "content-encoding": "br" })).status).toBe(415);
  });

  test("a read-only database answers 409, a database that can't be written 503", async () => {
    expect((await post(listener({ writable: () => false }), "/v1/traces", traces())).status).toBe(409);

    const readOnly = openDb(app.dbPath, { readonly: true });
    try {
      const res = await post(listener({ db: readOnly }), "/v1/traces", spansFrom("never-written"));
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBeTruthy();
    } finally {
      readOnly.close();
    }
    expect(usageOf("never-written")).toBe(0);
  });

  test("metrics are taken and dropped, and noted when nothing else came", async () => {
    const server = listener();
    const res = await post(server, "/v1/metrics", "{}", { "content-type": "application/json" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("{}");
    expect(server.stats().metricsOnly).toBe(true);

    await post(server, "/v1/traces", traces());
    expect(server.stats().metricsOnly).toBe(false);
  });

  test("records of a credential's hosts past MAX_HOSTS are skipped, counted with their reason and told in the log once a minute", async () => {
    const sender = await fastAuth();
    const server = listener({}, { auth: sender.auth });
    const send = (hosts: string[]) =>
      post(
        server,
        "/v1/traces",
        encodeTraces(
          hosts.flatMap((host) => {
            const traceId = createHash("sha256").update(`cap:${host}`).digest("hex").slice(0, 32);
            return hermesSpans({ host }).map((r) => ({ ...r, records: r.records.map((s) => ({ ...s, traceId })) }));
          }),
        ),
        { authorization: `Bearer ${sender.token}` },
      );
    const records = hermesSpans()[0]!.records.length;

    // 50 hosts a request at most: MAX_HOSTS in four.
    for (let from = 0; from < MAX_HOSTS; from += 50) {
      expect((await send(Array.from({ length: 50 }, (_, i) => `cap-box-${from + i}`))).status).toBe(200);
    }
    expect(server.stats()).toMatchObject({ skipped: 0, lastSkipReason: null });

    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await send(["cap-box-new"])).status).toBe(200);
      expect(server.stats()).toMatchObject({ skipped: records, lastSkipReason: "hosts" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toBe(`[ingest] Skipped ${records} records: ${records} of new hosts past ${MAX_HOSTS} per credential`);

      // Within the minute, only counted. Past it, the log tells of every record skipped since.
      await send(["cap-box-new-2"]);
      expect(warn).toHaveBeenCalledTimes(1);
      now += 61_000;
      await send(["cap-box-new-3"]);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toStartWith(`[ingest] Skipped ${2 * records} records:`);
      expect(server.stats()).toMatchObject({ skipped: 3 * records, lastSkipReason: "hosts" });
      // A known host's records are still taken.
      expect((await send(["cap-box-7"])).status).toBe(200);
      expect(server.stats().skipped).toBe(3 * records);
    } finally {
      warn.mockRestore();
    }
  });

  test("open windows hear of new usage like after a scan, at most every 2 seconds", async () => {
    const events: AppEvent[] = [];
    const unsubscribe = app.subscribe((e) => events.push(e));
    try {
      const server = listener();
      await post(server, "/v1/logs", logsJson(claudeLogs({ host: "event-box" })), { "content-type": "application/json" });
      expect(events).toEqual([{ type: "scan", result: expect.objectContaining({ usageRows: 1, prompts: 1 }) }]);

      await post(server, "/v1/logs", logsJson(claudeLogs({ host: "event-box-2" })), { "content-type": "application/json" });
      expect(events).toHaveLength(1);
      // What waits for the next one is told when the listener stops at the latest.
      server.stop();
      expect(events).toHaveLength(2);
      expect(events[1]).toEqual({ type: "scan", result: expect.objectContaining({ usageRows: 1 }) });
    } finally {
      unsubscribe();
    }
  });
});

describe("VS Code tokens", () => {
  /** A vscode token and a plain one on the same auth file, and a listener using it. */
  function vscodeListener() {
    const own = new IngestAuth(join(tempDir(), "home"), () => now);
    const vscode = own.addToken("VS Code (Code)", { purpose: "vscode", flavor: "Code" });
    const plain = own.addToken("ci");
    if ("error" in vscode || "error" in plain) throw new Error("token");
    return { server: listener({}, { auth: own }), vscode: vscode.token, plain: plain.token };
  }

  /** What writeOtlp is asked to do with the `local` option for a request, with the real write going on. */
  async function localOf(server: IngestServer, tok: string, ip: string): Promise<unknown> {
    const spy = spyOn(otlpWrite, "writeOtlp");
    try {
      const res = await post(server, "/v1/traces", traces(), { authorization: `Bearer ${tok}` }, ip);
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      return spy.mock.calls[0]![4].local;
    } finally {
      spy.mockRestore();
    }
  }

  test("a vscode token over loopback is written as this machine's own, a plain token as remote", async () => {
    const { server, vscode, plain } = vscodeListener();
    const me = { host: app.identity.host, user: app.identity.user };

    expect(await localOf(server, vscode, "127.0.0.1")).toEqual(me);
    expect(await localOf(server, vscode, "::1")).toEqual(me);
    expect(await localOf(server, vscode, "::ffff:127.0.0.1")).toEqual(me);
    expect(await localOf(server, plain, "127.0.0.1")).toBeNull();
    expect(await localOf(server, plain, "10.0.0.5")).toBeNull();
  });

  test("a vscode token from another address is refused like a wrong token and writes nothing", async () => {
    const { server, vscode } = vscodeListener();
    const spy = spyOn(otlpWrite, "writeOtlp");
    try {
      for (const ip of ["10.0.0.5", "unknown", "2001:db8::1"]) {
        const res = await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}` }, ip);
        expect(res.status).toBe(401);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(server.stats()).toMatchObject({ lastVscodeAt: null, lastAt: null, usage: 0, rejected: 3 });

    // The refusals count against the address: past the limit it is told to wait, a valid token over loopback still passes.
    for (let i = 0; i < 10; i++) await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}` }, "10.0.0.6");
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}` }, "10.0.0.6")).status).toBe(429);
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}` }, "127.0.0.1")).status).toBe(200);
    expect(server.stats().lastVscodeAt).toBe(now);
  });

  test("the time of the last accepted request from a vscode token is kept, a plain token leaves it alone", async () => {
    const { server, vscode, plain } = vscodeListener();
    expect(server.stats().lastVscodeAt).toBeNull();

    await post(server, "/v1/traces", traces(), { authorization: `Bearer ${plain}` }, "127.0.0.1");
    expect(server.stats().lastVscodeAt).toBeNull();

    now += 5000;
    await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}` }, "127.0.0.1");
    expect(server.stats().lastVscodeAt).toBe(now);

    // A refused request doesn't count.
    now += 5000;
    const before = server.stats().lastVscodeAt;
    expect((await post(server, "/v1/traces", traces(), { authorization: `Bearer ${vscode}`, "content-type": "text/plain" }, "127.0.0.1")).status).toBe(415);
    expect(server.stats().lastVscodeAt).toBe(before);
  });

  test.each([
    ["127.0.0.1", true],
    ["127.255.0.9", true],
    ["::1", true],
    ["0:0:0:0:0:0:0:1", true],
    ["::ffff:127.0.0.1", true],
    ["::ffff:7f00:1", true],
    ["128.0.0.1", false],
    ["::ffff:10.0.0.1", false],
    ["::2", false],
    ["fe80::1", false],
    ["127.0.0.256", false],
    ["unknown", false],
  ])("%s as a peer address is loopback: %p", (ip, expected) => {
    expect(isLoopbackPeer(ip)).toBe(expected);
  });
});

describe("OTLP listener server", () => {
  const ingestCfg = (over: Partial<AppConfig["ingest"]>): AppConfig => ({ ...defaultConfig(), ingest: { ...defaultConfig().ingest, enabled: true, ...over } });

  test("listens on its own port and takes a protobuf export over HTTP", async () => {
    const server = listener();
    try {
      const status = server.reconcile(ingestCfg({ port: 0 }), 4317);
      expect(status).toMatchObject({ state: "listening", error: null });
      const [endpoint] = server.endpoints();
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(status.address).toBe(endpoint!.slice("http://".length));

      const res = await fetch(`${endpoint}/v1/traces`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-protobuf" }, body: spansFrom("over-http") });
      expect(res.status).toBe(200);
      expect(usageOf("over-http")).toBe(2);
      // Not the dashboard: none of its API.
      expect((await fetch(`${endpoint}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    } finally {
      server.stop();
    }
    expect(server.status().state).toBe("off");
  });

  test("a port in use is reported in the status, not thrown", () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
    const server = listener();
    try {
      const status = server.reconcile(ingestCfg({ port: blocker.port }), 4317);
      expect(status).toMatchObject({ state: "error", error: "in-use", address: null });
      expect(status.message).toBeTruthy();
    } finally {
      server.stop();
      blocker.stop(true);
    }
  });

  test("a port in use is tried again until it binds, and each change of status is told once", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
    const port = blocker.port!;
    const seen: IngestStatus[] = [];
    const server = listener({}, { retryBindMs: 25, onStatus: (s) => seen.push(s) });
    try {
      expect(server.reconcile(ingestCfg({ port }), 4317)).toMatchObject({ state: "error", error: "in-use" });
      await Bun.sleep(80);
      expect(server.status().state).toBe("error");

      blocker.stop(true);
      await Bun.sleep(120);
      expect(server.status()).toMatchObject({ state: "listening", address: `127.0.0.1:${port}` });
      expect(seen.map((s) => s.state)).toEqual(["error", "listening"]);
    } finally {
      server.stop();
      blocker.stop(true);
    }
    expect(seen.map((s) => s.state)).toEqual(["error", "listening", "off"]);
  });

  test("a stopped listener tries no more", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") });
    const server = listener({}, { retryBindMs: 20 });
    try {
      server.reconcile(ingestCfg({ port: blocker.port }), 4317);
      server.stop();
      blocker.stop(true);
      await Bun.sleep(80);
      expect(server.status().state).toBe("off");
    } finally {
      server.stop();
      blocker.stop(true);
    }
  });

  test("a bind that fails as in use on an address this machine doesn't have is the address, as Bun reports it on macOS and Windows", () => {
    const inUse = Object.assign(new Error("Failed to start server. Is port 45123 in use?"), { code: "EADDRINUSE" });
    expect(bindError(inUse, "192.0.2.123")).toBe("address");
    expect(bindError(inUse, "127.0.0.1")).toBe("in-use");
    expect(bindError(inUse, "0.0.0.0")).toBe("in-use");
    expect(bindError(inUse, "::")).toBe("in-use");
    expect(bindError(Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" }), "127.0.0.1")).toBe("address");
    expect(bindError(new Error("x"), "127.0.0.1")).toBe("other");
  });

  test("an address this machine doesn't have is reported, and the dashboard's port is refused without binding", () => {
    const server = listener();
    expect(server.reconcile(ingestCfg({ bind: "192.0.2.123", port: 45_123 }), 4317)).toMatchObject({ state: "error", error: "address" });
    expect(server.reconcile(ingestCfg({ port: 4317 }), 4317)).toMatchObject({ state: "error", error: "port-conflict", message: null });
    expect(server.reconcile(ingestCfg({ enabled: false }), 4317)).toMatchObject({ state: "off", error: null });
  });

  test("listening on every network lists each IPv4 address of this machine", () => {
    const server = listener();
    server.reconcile(ingestCfg({ enabled: false, bind: "0.0.0.0", port: 4400 }), 4317);
    const v4 = Object.values(networkInterfaces()).flatMap((l) => l ?? []).filter((a) => !a.internal && String(a.family).endsWith("4")).map((a) => `http://${a.address}:4400`);
    expect(server.endpoints()).toEqual(v4);

    server.reconcile(ingestCfg({ enabled: false, bind: "::1", port: 4400 }), 4317);
    expect(server.endpoints()).toEqual(["http://[::1]:4400"]);
  });
});

describe("OTLP listener settings API", () => {
  const dashboardToken = "d".repeat(64);
  let handle: (req: Request) => Promise<Response>;
  let bare: (req: Request) => Promise<Response>;
  const server = () => listener();

  beforeAll(() => {
    handle = createHandler(app, { get: async () => null }, { shutdown() {}, ingest: server() }, { token: dashboardToken, port: 4317 });
    bare = createHandler(app, { get: async () => null }, { shutdown() {} }, { token: dashboardToken, port: 4317 });
  });

  const call = (h: typeof handle, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    h(
      new Request(`http://localhost:4317${path}`, {
        method,
        headers: { host: "localhost:4317", cookie: `hd_auth_4317=${dashboardToken}`, "x-harness-dashboard": "1", "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  test("GET /api/ingest shows the listener, the tokens and the basic auth user, never a secret", async () => {
    const res = await call(handle, "/api/ingest");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      config: { enabled: false, bind: "127.0.0.1", port: 4319, storeText: false },
      status: { state: "off", address: null, error: null, message: null, since: expect.any(Number) },
      loopback: true,
      endpoints: ["http://127.0.0.1:4319"],
      basic: { user: "hermes" },
      stats: { lastAt: null, lastHost: null, usage: 0, rejected: 0, metricsOnly: false, skipped: 0, lastSkipReason: null, lastVscodeAt: null },
    });
    expect(body.tokens[0]).toMatchObject({ label: "ci", prefix: token.slice(0, 11), createdAt: expect.any(Number) });
    expect(Object.keys(body.tokens[0]).sort()).toEqual(["createdAt", "id", "label", "lastUsedAt", "prefix"]);
    expect(text).not.toMatch(SECRET);
    expect(text).not.toContain("hash");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("$argon2");
  });

  test("a token is made and shown once, and revoked by id", async () => {
    const res = await call(handle, "/api/ingest/tokens", "POST", { label: "laptop" });
    expect(res.status).toBe(200);
    const made = (await res.json()) as { token: string; item: { id: string; label: string } };
    expect(made.token).toMatch(SECRET);
    expect(made.item).toMatchObject({ label: "laptop" });
    expect(made.item).not.toHaveProperty("hash");

    const listed = await (await call(handle, "/api/ingest")).text();
    expect(listed).toContain(made.item.id);
    expect(listed).not.toContain(made.token);

    expect((await call(handle, "/api/ingest/tokens", "POST", { label: "" })).status).toBe(400);
    expect((await call(handle, "/api/ingest/tokens", "DELETE", { id: made.item.id })).status).toBe(200);
    expect((await call(handle, "/api/ingest/tokens", "DELETE", { id: made.item.id })).status).toBe(404);
    expect(await auth.authenticate(`Bearer ${made.token}`)).toBeNull();
  });

  test("the basic auth user is set and cleared, a bad one refused", async () => {
    expect((await call(handle, "/api/ingest/basic", "PUT", { user: "a:b", password: PASSWORD })).status).toBe(400);
    expect((await call(handle, "/api/ingest/basic", "PUT", { user: "proxy", password: "short" })).status).toBe(400);

    const set = await call(handle, "/api/ingest/basic", "PUT", { user: "proxy", password: "a long enough password" });
    expect(await set.json()).toEqual({ basic: { user: "proxy" } });
    const cleared = await call(handle, "/api/ingest/basic", "DELETE");
    expect(await cleared.json()).toEqual({ basic: null });
    expect(auth.basic()).toBeNull();
    await auth.setBasic("hermes", PASSWORD);
  });

  test("the routes need the sign-in and the custom header, and are not there without the listener", async () => {
    expect((await call(handle, "/api/ingest", "GET", undefined, { cookie: "" })).status).toBe(401);
    expect((await call(handle, "/api/ingest/tokens", "POST", { label: "x" }, { "x-harness-dashboard": "" })).status).toBe(403);
    for (const [path, method] of [["/api/ingest", "GET"], ["/api/ingest/tokens", "POST"], ["/api/ingest/tokens", "DELETE"], ["/api/ingest/basic", "PUT"], ["/api/ingest/basic", "DELETE"]] as const) {
      expect((await call(bare, path, method, method === "GET" ? undefined : {})).status, `${method} ${path}`).toBe(404);
    }
  });

  test("settings carry the listener's config but no secret, and refuse a bad address or port", async () => {
    for (const res of [await call(handle, "/api/settings"), await call(handle, "/api/settings", "POST", { ingest: { storeText: true } })]) {
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toMatch(SECRET);
      expect(text).not.toContain("hash");
      expect(text).not.toContain(PASSWORD);
    }
    // A change of one field keeps the others.
    expect(app.cfg.ingest).toEqual({ enabled: false, bind: "127.0.0.1", port: 4319, storeText: true });

    for (const ingest of [{ bind: "example.com" }, { port: app.cfg.port }, { port: 80 }, { enabled: "yes" }]) {
      const res = await call(handle, "/api/settings", "POST", { ingest });
      expect(res.status, JSON.stringify(ingest)).toBe(400);
    }
    expect(app.cfg.ingest.storeText).toBe(true);
  });

  test("a settings change is passed on to the listener", async () => {
    const seen: AppConfig["ingest"][] = [];
    const off = app.onConfigChange((cfg) => seen.push(cfg.ingest));
    try {
      await call(handle, "/api/settings", "POST", { ingest: { port: 4400 } });
    } finally {
      off();
    }
    expect(seen).toEqual([{ enabled: false, bind: "127.0.0.1", port: 4400, storeText: true }]);
  });

  test("a credentials file that can't be read is never written over: changes answer 500 ingest-auth-unreadable", async () => {
    const dir = join(tempDir(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, AUTH_FILE), "{ broken");
    const broken = createHandler(app, { get: async () => null }, { shutdown() {}, ingest: listener({}, { auth: new IngestAuth(dir) }) }, { token: dashboardToken, port: 4317 });

    for (const [path, method, body] of [["/api/ingest/tokens", "POST", { label: "x" }], ["/api/ingest/tokens", "DELETE", { id: "0".repeat(16) }], ["/api/ingest/basic", "PUT", { user: "proxy", password: "a long enough password" }], ["/api/ingest/basic", "DELETE", undefined]] as const) {
      const res = await call(broken, path, method, body);
      expect(res.status, `${method} ${path}`).toBe(500);
      expect(await res.json()).toEqual({ error: "ingest-auth-unreadable" });
    }
    expect(readFileSync(join(dir, AUTH_FILE), "utf8")).toBe("{ broken");
    expect((await call(broken, "/api/ingest")).status).toBe(200);
  });

  test.skipIf(process.platform === "win32")("the credentials file is private to this account", () => {
    expect(statSync(join(home, AUTH_FILE)).mode & 0o777).toBe(0o600);
  });
});
