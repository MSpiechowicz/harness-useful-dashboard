/**
 * Retakes the README screenshots in docs/screenshots from made-up demo data. Nothing from this machine is used: the
 * dashboard runs against a scratch database (scripts/demo-data.ts) with an isolated config home that reads no logs,
 * checks for no updates and reads plan limits only from the demo database, and a headless Chromium takes the shots in the dark theme at 1440x1000.
 *
 *   bun run build:web          # once, and after UI changes
 *   bun run screenshots        # all shots
 *   bun run screenshots overview tags   # only these
 *
 * Needs Chrome or Chromium (google-chrome-stable, chromium, chromium-browser, microsoft-edge or brave on the PATH,
 * or set CHROME to the binary). Nothing is installed and nothing outside docs/screenshots and the temp folder is touched.
 */
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "docs/screenshots");
const WIDTH = 1440;
const HEIGHT = 1000;

const CONFIG = {
  scanIntervalSec: 0,
  checkUpdates: false,
  language: "en",
  userName: "alex",
  openMode: "none",
  // Codex limits come from the demo database (plan_limits), the others would ask providers with this machine's logins.
  limits: { claude: false, omp: false, codex: true, pi: false, opencode: false, copilot: false },
  sources: {
    enabled: { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false },
  },
};

/** Spending caps so the Overview shows its Budgets card. No desktop notifications from a demo. */
const BUDGETS = { daily: 40, monthly: 150, notify: false, limitAlerts: false };

interface Shot {
  name: string;
  /** The route after "#/", with its query. */
  route: string;
  /** Runs after the page has loaded, before the shot. */
  prepare?: (page: Page) => Promise<void>;
  /** A wider window, for a view that only sets its cards side by side when it has the room. */
  width?: number;
  /** A page rectangle to cut out instead of the viewport. */
  clip?: (page: Page) => Promise<Clip>;
}
interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SHOTS: Shot[] = [
  { name: "overview", route: "overview" },
  {
    name: "overview-activity",
    route: "overview",
    width: 1600,
    // The cards from "Provider split" to the daily calendar, wherever they sit on the page.
    clip: (p) =>
      p.eval<Clip>(`(() => {
        const card = (title) => [...document.querySelectorAll("main h2, main h3")].find((h) => h.textContent.trim() === title)?.closest(".card");
        const a = card("Provider split"), b = card("Daily activity");
        if (!a || !b) throw new Error("Overview cards not found");
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const x = Math.min(ra.left, rb.left), r = Math.max(ra.right, rb.right);
        const y = ra.top + scrollY, bottom = rb.bottom + scrollY;
        return { x: x - 8, y: y - 8, width: r - x + 16, height: bottom - y + 16 };
      })()`),
  },
  { name: "live", route: "live" },
  { name: "trends", route: "trends" },
  { name: "projects", route: "projects" },
  { name: "branches", route: "branches" },
  { name: "models", route: "models" },
  { name: "model-drift", route: "drift" },
  { name: "providers", route: "providers" },
  { name: "users", route: "users" },
  { name: "skills", route: "skills" },
  { name: "agents", route: "agents" },
  { name: "tags", route: "tags" },
  { name: "sessions", route: "sessions" },
  { name: "session-detail", route: "sessions", prepare: (p) => openFirst(p, "#/sessions/") },
  { name: "prompts", route: "prompts" },
  { name: "prompt-detail", route: "prompts", prepare: (p) => openFirst(p, "#/prompts/") },
  { name: "time", route: "time" },
  { name: "tools", route: "tools" },
  { name: "files", route: "files" },
  { name: "friction", route: "friction" },
  { name: "cache", route: "cache" },
  { name: "tips", route: "tips" },
  { name: "settings", route: "settings" },
  {
    name: "palette",
    route: "overview",
    prepare: async (p) => {
      await p.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`);
      await p.waitFor(`!!document.querySelector("[role=dialog] input, [role=combobox], dialog input")`, "the command palette");
      await p.send("Input.insertText", { text: "inv" });
      await p.settle(400);
      await p.idle();
    },
  },
];

/** Clicks the first row of the page's table, which opens its detail page ("#/sessions/<id>"). */
async function openFirst(p: Page, prefix: string): Promise<void> {
  await p.waitFor(`!!document.querySelector("main tbody tr.cursor-pointer")`, "a table row");
  await p.eval(`document.querySelector("main tbody tr.cursor-pointer").click()`);
  await p.waitFor(`location.hash.startsWith(${JSON.stringify(prefix)})`, "the detail page");
  await p.settle(300);
  await p.idle();
  await p.settle(500);
}

// ---------------------------------------------------------------------------------------------------------------

/** Counts the API requests in flight, so "the page has loaded its data" can be told. */
const HOOK = `(() => {
  const hd = (window.__hd = { pending: 0, last: Date.now() });
  const real = window.fetch;
  window.fetch = function (...args) {
    hd.pending++;
    hd.last = Date.now();
    return real.apply(this, args).finally(() => {
      hd.pending--;
      hd.last = Date.now();
    });
  };
})();
`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fail(msg: string): never {
  throw new Error(msg);
}

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

function findChrome(): string {
  const fromEnv = process.env.CHROME;
  if (fromEnv) return Bun.which(fromEnv) ?? (existsSync(fromEnv) ? fromEnv : fail(`CHROME=${fromEnv} is not a browser binary`));
  for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave", "brave-browser"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return fail("No Chrome or Chromium found. Install one or set CHROME to its path.");
}

/** One page of the browser, driven over the DevTools protocol. */
class Page {
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(
    private ws: WebSocket,
    private sessionId: string,
  ) {}

  /** Routes the socket's messages: the answers to calls. */
  handle(msg: any): void {
    if (msg.id !== undefined && this.waiting.has(msg.id)) {
      const w = this.waiting.get(msg.id)!;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`${msg.error.message}`));
      else w.resolve(msg.result);
      return;
    }
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  settle(ms: number): Promise<void> {
    return sleep(ms);
  }

  async waitFor(expression: string, what: string, timeoutMs = 20_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval<boolean>(expression).catch(() => false)) return;
      await sleep(100);
    }
    fail(`timed out waiting for ${what}`);
  }

  /** No API request for a while (counted by the hook in HOOK), and no loading marks or spinners on the page. */
  async idle(timeoutMs = 15_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const done = await this.eval<boolean>(`window.__hd.pending === 0 && Date.now() - window.__hd.last >= 800 && !document.querySelector(".loading-dim, main [role=status]")`).catch(() => false);
      if (done) return;
      await sleep(100);
    }
    const state = await this.eval<string>(`JSON.stringify({ pending: window.__hd.pending, marks: [...document.querySelectorAll(".loading-dim, main [role=status]")].map((e) => e.className) })`).catch(() => "?");
    fail(`the page never finished loading ${state}`);
  }

  async goto(url: string): Promise<void> {
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState === "complete"`, "the page to load");
  }

  /** Same-document route change: a hash change keeps the app, so the page is told to reload data via its router. */
  async route(url: string, fresh = false): Promise<void> {
    await this.goto("about:blank");
    // After the first load a route change is only the address's hash, as when someone clicks a menu link.
    if (fresh) await this.goto("about:blank");
    if (!fresh && url.split("#")[0] === (await this.eval<string>(`location.href.split("#")[0]`))) await this.eval(`location.hash = ${JSON.stringify(url.slice(url.indexOf("#")))}`);
    else await this.goto(url);
    await this.waitFor(`!!document.querySelector("main")`, "the app to render");
    await this.settle(300);
    await this.idle();
    // Charts animate in; with reduced motion this is only the first paint.
    await this.waitFor(`[...document.querySelectorAll("canvas")].every((c) => c.width > 0)`, "charts");
    await this.settle(500);
  }

  async viewport(width: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
  }

  async shoot(file: string, clip?: Clip): Promise<void> {
    const r = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !!clip,
      clip: clip ? { ...clip, scale: 1 } : { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    });
    writeFileSync(file, Buffer.from(r.data, "base64"));
  }
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const unknown = only.filter((n) => !SHOTS.some((s) => s.name === n));
  if (unknown.length) fail(`unknown shot: ${unknown.join(", ")}. Shots: ${SHOTS.map((s) => s.name).join(", ")}`);
  const shots = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;

  if (!existsSync(join(ROOT, "web/dist/index.html"))) fail("web/dist is missing. Build the UI first: bun run build:web");
  const chrome = findChrome();

  const scratch = mkdtempSync(join(tmpdir(), "hd-shots-"));
  const procs: Subprocess[] = [];
  let browserWs: WebSocket | undefined;
  const failures: string[] = [];
  try {
    // Demo data and an isolated home: nothing of the real dashboard is read or changed.
    const db = join(scratch, "demo.db");
    const home = join(scratch, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify(CONFIG, null, 2));
    const demo = Bun.spawnSync(["bun", join(ROOT, "scripts/demo-data.ts"), db], { cwd: ROOT, stderr: "pipe", stdout: "pipe" });
    if (demo.exitCode !== 0) fail(`demo data failed: ${demo.stderr.toString()}`);

    const port = freePort();
    const server = spawn(["bun", "src/cli.ts", "serve", "--no-open", "--port", String(port), "--db", db], {
      cwd: ROOT,
      env: { ...process.env, HARNESS_DASHBOARD_HOME: home },
      stdout: "ignore",
      stderr: "pipe",
    });
    procs.push(server);
    const base = `http://localhost:${port}`;
    const tokenFile = join(home, "auth-token");
    for (let i = 0; ; i++) {
      if (existsSync(tokenFile) && (await fetch(`${base}/`).then((r) => r.status < 500, () => false))) break;
      if (server.exitCode !== null) fail(`the server stopped: ${await new Response(server.stderr as ReadableStream).text()}`);
      if (i > 150) fail("the server did not start");
      await sleep(100);
    }
    const token = readFileSync(tokenFile, "utf8").trim();

    // Budget caps, so the Overview shows its Budgets card.
    const res = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Harness-Dashboard": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ budgets: BUDGETS }),
    });
    if (!res.ok) fail(`setting budgets failed: ${res.status} ${await res.text()}`);

    // The browser.
    const userData = join(scratch, "chrome");
    const args = ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userData}`, "--hide-scrollbars", `--window-size=${WIDTH},${HEIGHT}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--force-color-profile=srgb", "--disable-features=Translate", "about:blank"];
    if (process.getuid?.() === 0) args.push("--no-sandbox");
    const browser = spawn([chrome, ...args], { stdout: "ignore", stderr: "pipe" });
    procs.push(browser);
    const wsUrl = await devtoolsUrl(browser);

    const ws = new WebSocket(wsUrl);
    browserWs = ws;
    await new Promise<void>((ok, bad) => {
      ws.onopen = () => ok();
      ws.onerror = () => bad(new Error("could not connect to the browser"));
    });
    let page: Page | undefined;
    const early = new Map<number, (m: any) => void>();
    let eseq = 0;
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id !== undefined && early.has(msg.id)) early.get(msg.id)!(msg);
      else page?.handle(msg);
    };
    const call = (method: string, params: object = {}) =>
      new Promise<any>((ok, bad) => {
        const id = ++eseq + 1_000_000;
        early.set(id, (m) => (early.delete(id), m.error ? bad(new Error(m.error.message)) : ok(m.result)));
        ws.send(JSON.stringify({ id, method, params }));
      });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    page = new Page(ws, sessionId);

    await page.send("Page.enable");
    await page.viewport(WIDTH);
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: HOOK + `try { localStorage.setItem("hd.theme", "dark"); localStorage.setItem("hd.lang", "en"); localStorage.setItem("hd.range", "30d"); } catch {}`,
    });

    // Sign in once: the link sets the cookie and redirects to the app.
    await page.goto(`${base}/?k=${token}`);
    await page.waitFor(`!!document.querySelector("main")`, "the dashboard after signing in");

    mkdirSync(OUT, { recursive: true });
    for (const shot of shots) {
      // A page that never settles (a stuck request) is tried again from a fresh load.
      let last = "";
      await page.viewport(shot.width ?? WIDTH);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.route(`${base}/#/${shot.route}`, attempt > 0);
          await shot.prepare?.(page);
          await verify(page);
          const clip = await shot.clip?.(page);
          await page.shoot(join(OUT, `${shot.name}.png`), clip);
          last = "";
          break;
        } catch (e) {
          last = (e as Error).message;
        }
      }
      if (last) {
        failures.push(shot.name);
        console.error(`FAIL ${shot.name}: ${last}`);
        continue;
      }
      console.log(`ok   ${shot.name}`);
    }
  } finally {
    try {
      browserWs?.close();
    } catch {}
    for (const p of procs) {
      try {
        p.kill();
        await Promise.race([p.exited, sleep(2000)]);
      } catch {}
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  if (failures.length) fail(`${failures.length} shot(s) failed: ${failures.join(", ")}`);
}

/** Refuses a page that would give the wrong picture: light theme, an update banner or an unsigned-in screen. */
async function verify(page: Page): Promise<void> {
  const bad = await page.eval<string | null>(`(() => {
    const bg = getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);
    if (bg[0] + bg[1] + bg[2] > 200) return "light theme (background " + getComputedStyle(document.body).backgroundColor + ")";
    if (/Version [\\d.]+ is available/i.test(document.body.innerText)) return "an update banner is showing";
    return null;
  })()`);
  if (bad) fail(bad);
}

/** Reads "DevTools listening on ws://…" from the browser's stderr. */
async function devtoolsUrl(browser: Subprocess<"ignore", "ignore", "pipe">): Promise<string> {
  const reader = (browser.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const r = await Promise.race([reader.read(), sleep(500).then(() => null)]);
    if (r?.done) break;
    if (r?.value) text += decoder.decode(r.value);
    const m = text.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      // Keep draining so the browser never blocks on a full pipe.
      void (async () => {
        while (!(await reader.read().catch(() => ({ done: true }))).done);
      })();
      return m[1]!;
    }
  }
  return fail(`the browser did not report a DevTools address:\n${text}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`screenshots: ${(e as Error).message}`);
    process.exit(1);
  },
);
