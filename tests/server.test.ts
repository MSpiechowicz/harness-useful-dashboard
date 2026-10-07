import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import { parseSettings, scanInterval } from "../src/core/config.ts";
import { ensureAppDataDir } from "../src/core/paths.ts";
import { App } from "../src/server/app.ts";
import { createHandler, parseFilters } from "../src/server/http.ts";
import { assetName, compareVersions, installedPath, installedVersion } from "../src/server/update.ts";
import { claudeAssistant, claudeUser, CLAUDE_SESSION, tempDir, writeJsonl } from "./helpers.ts";

describe("update helpers", () => {
  test("asset names per platform", () => {
    expect(assetName("darwin", "arm64")).toBe("harness-dashboard-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("harness-dashboard-linux-x64");
    expect(assetName("win32", "x64")).toBe("harness-dashboard-windows-x64.exe");
  });
  test("version comparison", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
  });
  test("the install path drops the suffix Linux adds once the running binary was replaced", () => {
    expect(installedPath("/home/u/.local/bin/harness-dashboard (deleted)")).toBe("/home/u/.local/bin/harness-dashboard");
    expect(installedPath("/home/u/.local/bin/harness-dashboard")).toBe("/home/u/.local/bin/harness-dashboard");
    expect(installedPath("C:\\Users\\u\\harness-dashboard.exe")).toBe("C:\\Users\\u\\harness-dashboard.exe");
  });
  test("reads the version of the installed binary, or nothing when there is none", () => {
    const dir = tempDir();
    const fake = join(dir, "harness-dashboard");
    writeFileSync(fake, "#!/bin/sh\necho 1.3.2\n", { mode: 0o755 });
    if (process.platform !== "win32") expect(installedVersion(fake)).toBe("1.3.2");
    expect(installedVersion(join(dir, "missing"))).toBeNull();
  });
});

describe("cli args", () => {
  test("defaults to serve and parses flags", () => {
    expect(parseArgs([])).toEqual({ cmd: "serve", positional: [], flags: {} });
    expect(parseArgs(["--db", "/x/usage.db", "--no-open", "--port=5000"])).toEqual({ cmd: "serve", positional: [], flags: { db: "/x/usage.db", "no-open": true, port: "5000" } });
    expect(parseArgs(["import-cursor", "file.csv"]).positional).toEqual(["file.csv"]);
    expect(parseArgs(["scan", "--full"]).flags.full).toBe(true);
  });
});

describe("parseFilters", () => {
  test("reads numeric range and string filters", () => {
    expect(parseFilters(new URLSearchParams("from=10&to=abc&provider=claude&model="))).toEqual({
      from: 10, to: undefined, provider: "claude", project: undefined, user: undefined, model: undefined, skill: undefined, agent: undefined,
    });
  });
});

describe("settings input", () => {
  test("keeps known keys of the right type and rounds numbers into range", () => {
    expect(parseSettings({ userName: " ada ", scanIntervalSec: 1.4, promptTextLimit: -5, openMode: "browser", other: 1 })).toEqual({
      patch: { userName: "ada", scanIntervalSec: 5, promptTextLimit: 0, openMode: "browser" },
    });
    expect(parseSettings({ sources: { claudeDirs: ["/a"], enabled: { codex: false } }, limits: { omp: false } })).toEqual({
      patch: { sources: { claudeDirs: ["/a"], enabled: { codex: false } }, limits: { omp: false } },
    });
  });
  test("refuses values of the wrong type", () => {
    for (const body of [null, [], { scanIntervalSec: "5" }, { scanIntervalSec: Number.NaN }, { port: 70000 }, { openMode: "kiosk" }, { checkUpdates: "yes" }, { sources: { claudeDirs: "/a" } }, { sources: { enabled: { claude: 1 } } }, { limits: [] }]) {
      expect("error" in parseSettings(body), JSON.stringify(body)).toBe(true);
    }
  });
  test("a scan interval is off, or between 5 seconds and a day", () => {
    expect([scanInterval(0), scanInterval(-1), scanInterval("x"), scanInterval(0.001), scanInterval(30), scanInterval(1e9)]).toEqual([0, 0, 0, 5, 30, 86_400]);
  });
});

describe("app data folder", () => {
  test.skipIf(process.platform === "win32")("is private to this account, also when an older version left it open", () => {
    const dir = join(tempDir(), "home");
    mkdirSync(dir, { mode: 0o755 });
    writeFileSync(join(dir, "usage.db"), "", { mode: 0o644 });
    writeFileSync(join(dir, "config.json"), "{}", { mode: 0o644 });
    ensureAppDataDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "usage.db")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "usage.db-wal"))).toBe(false);
  });
});

describe("HTTP API", () => {
  let app: App;
  let handle: (req: Request) => Promise<Response>;
  const prevHome = process.env.HARNESS_DASHBOARD_HOME;
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  const prevCodex = process.env.CODEX_HOME;
  const prevOmp = process.env.PI_CODING_AGENT_DIR;

  beforeAll(async () => {
    const root = tempDir();
    process.env.HARNESS_DASHBOARD_HOME = join(root, "home");
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    process.env.CODEX_HOME = join(root, "codex");
    process.env.PI_CODING_AGENT_DIR = join(root, "omp");
    // pi and OpenCode have no environment override this test can use: point their folders into the temp root.
    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(join(root, "home", "config.json"), JSON.stringify({ sources: { piDirs: [join(root, "pi")], opencodeDirs: [join(root, "opencode")] } }));
    writeJsonl(join(root, "claude", "projects", "-work-alpha", `${CLAUDE_SESSION}.jsonl`), [
      claudeUser("hello", { uuid: "u1", ts: "2026-09-01T10:00:00.000Z" }),
      claudeAssistant({ id: "m1", ts: "2026-09-01T10:00:01.000Z" }),
    ]);
    app = new App(join(root, "test.db"));
    await app.scanNow();
    handle = createHandler(app, { get: async (p) => (p === "/index.html" ? new Response("<html>ui</html>") : null) }, { restart() {}, shutdown() {} });
  });

  afterAll(() => {
    app.close();
    process.env.HARNESS_DASHBOARD_HOME = prevHome;
    if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
    if (prevOmp === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevOmp;
  });

  const get = (path: string, host = "localhost:4317") => handle(new Request(`http://${host}${path}`, { headers: { host } }));

  test("serves JSON endpoints", async () => {
    for (const path of ["/api/status", "/api/summary", "/api/timeseries?group=model", "/api/breakdown?dim=model", "/api/heatmap", "/api/calendar", "/api/sessions", "/api/prompts", "/api/tools", "/api/files", "/api/files/hotspots?project=%2Fwork%2Falpha", "/api/files/list?q=a", "/api/cache", "/api/drift", "/api/tips", "/api/filters", "/api/settings", "/api/pricing"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/json");
      await res.json();
    }
    const summary = (await (await get("/api/summary")).json()) as { messages: number };
    expect(summary.messages).toBe(1);
  });

  test("falls back to index.html for client routes", async () => {
    expect(await (await get("/sessions/whatever")).text()).toBe("<html>ui</html>");
  });

  test("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await get("/api/status", "evil.example:4317")).status).toBe(403);
    expect((await get("/api/status", "127.0.0.1:4317")).status).toBe(200);
  });

  test("state-changing requests need the custom header", async () => {
    const bare = await handle(new Request("http://localhost/api/scan", { method: "POST", headers: { host: "localhost" } }));
    expect(bare.status).toBe(403);
    const ok = await handle(new Request("http://localhost/api/scan", { method: "POST", headers: { host: "localhost", "x-harness-dashboard": "1" } }));
    expect(ok.status).toBe(200);
  });

  test("every response carries the security headers", async () => {
    for (const res of [await get("/"), await get("/api/status"), await get("/api/status", "evil.example")]) {
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self';");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  test("the API refuses requests a browser marks as coming from another site", async () => {
    const req = (headers: Record<string, string>) => handle(new Request("http://localhost/api/limits?force=1", { headers: { host: "localhost", ...headers } }));
    expect((await req({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await req({ "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await req({ origin: "https://evil.example" })).status).toBe(403);
    expect((await req({ origin: "null" })).status).toBe(403);
    expect((await get("/api/status")).status).toBe(200);
    const same = await handle(new Request("http://localhost/api/status", { headers: { host: "localhost", "sec-fetch-site": "same-origin", origin: "http://localhost:5173" } }));
    expect(same.status).toBe(200);
    // Pages are still served, so the app opens from a link or a bookmark.
    expect((await handle(new Request("http://localhost/", { headers: { host: "localhost", "sec-fetch-site": "cross-site" } }))).status).toBe(200);
  });

  test("settings with a bad value are refused and change nothing", async () => {
    const post = (body: unknown) =>
      handle(new Request("http://localhost/api/settings", { method: "POST", headers: { host: "localhost", "x-harness-dashboard": "1", "content-type": "application/json" }, body: JSON.stringify(body) }));
    const interval = app.cfg.scanIntervalSec;
    const res = await post({ scanIntervalSec: "0.001", userName: "mallory" });
    expect(res.status).toBe(400);
    expect(app.cfg.scanIntervalSec).toBe(interval);
    expect(app.cfg.userName).not.toBe("mallory");
    expect((await post({ dbPath: 42 })).status).toBe(400);
    const bad = await handle(new Request("http://localhost/api/settings", { method: "POST", headers: { host: "localhost", "x-harness-dashboard": "1" }, body: "{" }));
    expect(bad.status).toBe(400);
  });

  test("tip state: hides rules and marks keys read, and keeps them in the config", async () => {
    const post = (body: unknown) =>
      handle(new Request("http://localhost/api/tips/state", { method: "POST", headers: { host: "localhost", "x-harness-dashboard": "1", "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(await (await get("/api/tips/state")).json()).toEqual({ hidden: [], read: [] });
    await post({ hide: ["spike", "spike"], read: ["low-cache-hit", "spike:2026-09-01"] });
    expect(await (await post({ unread: ["low-cache-hit"], read: [42] })).json()).toEqual({ hidden: ["spike"], read: ["spike:2026-09-01"] });
    expect(app.cfg.tips).toEqual({ hidden: ["spike"], read: ["spike:2026-09-01"] });
    await post({ unhide: ["spike"], unread: ["spike:2026-09-01"] });
  });

  test("pricing updates re-price history", async () => {
    const before = ((await (await get("/api/summary")).json()) as { cost: number }).cost;
    const res = await handle(
      new Request("http://localhost/api/pricing", {
        method: "PUT",
        headers: { host: "localhost", "x-harness-dashboard": "1", "content-type": "application/json" },
        body: JSON.stringify([{ pattern: "claude-opus-5-5*", input: 400, output: 2000, cacheRead: 20 }]),
      }),
    );
    expect(res.status).toBe(200);
    const after = ((await (await get("/api/summary")).json()) as { cost: number }).cost;
    expect(after).toBeCloseTo(before * 100, 6);
  });

  test("price rules of the wrong shape are skipped, not a server error", async () => {
    const res = await handle(
      new Request("http://localhost/api/pricing", {
        method: "PUT",
        headers: { host: "localhost", "x-harness-dashboard": "1", "content-type": "application/json" },
        body: JSON.stringify([{ pattern: 5, input: 1, output: 1 }, { pattern: "x*", input: -1, output: 1 }, null]),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("unknown routes 404", async () => {
    expect((await get("/api/nope")).status).toBe(404);
  });
});
