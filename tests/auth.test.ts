import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { App } from "../src/server/app.ts";
import { cookieName, cookieValue, loadToken, sameToken, signInUrl } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";
import { tempDir } from "./helpers.ts";

describe("token", () => {
  test("is made once, private to this account, and kept", () => {
    const dir = join(tempDir(), "home");
    const token = loadToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(loadToken(dir)).toBe(token);
    expect(readFileSync(join(dir, "auth-token"), "utf8")).toBe(token);
    if (process.platform !== "win32") expect(statSync(join(dir, "auth-token")).mode & 0o777).toBe(0o600);
  });
  test("a damaged token file is replaced", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "auth-token"), "nope");
    expect(loadToken(dir)).toMatch(/^[0-9a-f]{64}$/);
  });
  test("helpers", () => {
    expect(signInUrl("http://localhost:4317", "abc")).toBe("http://localhost:4317/?k=abc");
    expect(cookieName(4317)).toBe("hd_auth_4317");
    expect(cookieValue("a=1; hd_auth_4317=xyz; b=2", "hd_auth_4317")).toBe("xyz");
    expect(cookieValue("hd_auth_4318=xyz", "hd_auth_4317")).toBeNull();
    expect(sameToken("abc", "abc")).toBe(true);
    expect(sameToken("abd", "abc")).toBe(false);
    expect(sameToken(null, "abc")).toBe(false);
  });
});

describe("signed-in API", () => {
  const token = "a".repeat(64);
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;

  beforeAll(() => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ scanIntervalSec: 0, sources: { enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false } } }));
    app = new App(join(root, "test.db"));
    handle = createHandler(app, { get: async (p) => (p === "/index.html" ? new Response("<html>ui</html>") : null) }, { restart() {}, shutdown() {} }, { token, port: 4317 });
  });
  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
  });

  const req = (path: string, headers: Record<string, string> = {}, method = "GET") => handle(new Request(`http://localhost:4317${path}`, { method, headers: { host: "localhost:4317", ...headers } }));

  test("the API needs the cookie or the token, the page itself doesn't", async () => {
    expect((await req("/api/summary")).status).toBe(401);
    expect((await req("/api/summary", { cookie: `hd_auth_4317=${"b".repeat(64)}` })).status).toBe(401);
    expect((await req("/api/summary", { cookie: `hd_auth_4318=${token}` })).status).toBe(401);
    expect((await req("/api/summary", { cookie: `hd_auth_4317=${token}` })).status).toBe(200);
    expect((await req("/api/summary", { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await req("/")).status).toBe(200);
  });

  test("the sign-in link sets the cookie and goes on to the app, a wrong one doesn't", async () => {
    const ok = await req(`/api/auth?k=${token}`);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(ok.headers.get("set-cookie")).toContain(`hd_auth_4317=${token}`);
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    expect(ok.headers.get("set-cookie")).toContain("SameSite=Strict");
    // Opened from a terminal, a launcher or another page alike.
    expect((await req(`/api/auth?k=${token}`, { "sec-fetch-site": "cross-site" })).status).toBe(303);
    // At the root, so the app window keeps the address that names it on Linux, and its icon.
    const root = await req(`/?k=${token}`);
    expect(root.status).toBe(303);
    expect(root.headers.get("set-cookie")).toContain(`hd_auth_4317=${token}`);
    expect((await req("/?k=nope")).status).toBe(401);
    const bad = await req("/api/auth?k=nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
  });

  test("a window that isn't signed in gets a live stream that only tells it to reload", async () => {
    // A window opened by 1.10 or older reloads on a hello under another version, and stays on "Restarting…" on a 401.
    const res = await req("/api/events", { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain(`data: {"type":"hello","version":"signed-out"}`);
    expect(body).toContain("retry: 3600000");
    expect(body).not.toMatch(/\d+\.\d+\.\d+/);
    // Another site still can't open it.
    expect((await req("/api/events", { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("state-changing requests still need the custom header, signed in or not", async () => {
    expect((await req("/api/scan", { authorization: `Bearer ${token}` }, "POST")).status).toBe(403);
    expect((await req("/api/scan", { authorization: `Bearer ${token}`, "x-harness-dashboard": "1" }, "POST")).status).toBe(200);
    expect((await req("/api/scan", { "x-harness-dashboard": "1" }, "POST")).status).toBe(401);
  });
});
