import { afterAll, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

// `serve --shell` as the app shell runs it: the lines it reads on stdout, a second launch, what may already hold the port,
// and quitting when the shell closes stdin. Everything runs on spare ports against a scratch app data folder that reads
// no logs.

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const procs: Bun.Subprocess[] = [];

afterAll(() => {
  for (const p of procs) p.kill();
});

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** A scratch app data folder whose config reads no logs, asks no provider and checks for no updates. */
function scratchHome(language = "pl"): string {
  const home = join(tempDir("hd-shell-"), "home");
  mkdirSync(home, { recursive: true });
  const off = { claude: false, codex: false, omp: false, pi: false, opencode: false, zed: false, cline: false, roo: false, kilo: false, gemini: false, copilot: false };
  const config = { language, scanIntervalSec: 0, checkUpdates: false, limits: { claude: false, omp: false, codex: false, pi: false, opencode: false, copilot: false }, sources: { enabled: off } };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return home;
}

function shell(home: string, port: number) {
  const p = Bun.spawn(["bun", CLI, "serve", "--shell", "--port", String(port)], {
    env: { ...process.env, HARNESS_DASHBOARD_HOME: home, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  return { proc: p, next: lineReader(p.stdout) };
}

/** `serve` as a terminal runs it. */
function serve(home: string, port: number) {
  const p = Bun.spawn(["bun", CLI, "serve", "--port", String(port)], {
    env: { ...process.env, HARNESS_DASHBOARD_HOME: home, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(p);
  return p;
}

/** The stream's lines one by one, null at its end. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return async () => {
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        return line;
      }

      const { value, done } = await reader.read();
      if (done) {
        const rest = buf;
        buf = "";
        return rest || null;
      }

      buf += decoder.decode(value, { stream: true });
    }
  };
}

/** Every line the stream still has, up to its end. */
async function rest(next: () => Promise<string | null>): Promise<string[]> {
  const lines: string[] = [];
  for (let line = await next(); line !== null; line = await next()) lines.push(line);
  return lines;
}

const signInLink = (port: number) => new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?k=[0-9a-f]{64}$`);

/** The proof a dashboard holding `token` gives on `port` (GET /api/hello). */
const proof = (token: string, port: number, nonce: string) => createHmac("sha256", token).update(`harness-dashboard-hello ${port} ${nonce}`).digest("hex");

/** A scratch home whose token the test knows. */
function homeWithToken(language = "en"): { home: string; token: string } {
  const home = scratchHome(language);
  const secret = randomBytes(32).toString("hex");
  writeFileSync(join(home, "auth-token"), secret);
  return { home, token: secret };
}

/**
 * A listener on `port` that answers /api/status like a dashboard and /api/hello with `hello`, and keeps every
 * Authorization header it was sent. A shutdown request stops it.
 */
function listener(port: number, hello: (nonce: string) => Response | Promise<Response>) {
  const authorization: string[] = [];
  let shutdowns = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization");
      if (auth) authorization.push(auth);

      if (url.pathname === "/api/hello") return hello(url.searchParams.get("nonce") ?? "");
      if (url.pathname === "/api/status") return Response.json({ version: "0.0.1" });
      if (url.pathname === "/api/shutdown" && req.method === "POST") {
        shutdowns++;
        setTimeout(() => server.stop(true), 50);
        return Response.json({ ok: true });
      }

      return new Response(null, { status: 404 });
    },
  });
  return { server, authorization, shutdowns: () => shutdowns };
}

const portInUse = (port: number) =>
  `Port ${port} is used by another program, possibly an older Harness Dashboard. Quit it or choose another port with harness-dashboard config set port <n>.`;

const portSilent = (port: number) =>
  `The program on port ${port} did not answer. Try again in a moment or choose another port with harness-dashboard config set port <n>.`;

describe("the server run by the app shell", () => {
  test("says its language first, then where to sign in, and quits when stdin closes", async () => {
    const home = scratchHome("pl");
    const port = freePort();
    const first = shell(home, port);

    expect(await first.next()).toBe("HARNESS_DASHBOARD_LANG pl");
    const ready = await first.next();
    expect(ready).toStartWith("HARNESS_DASHBOARD_READY ");
    const url = ready!.slice("HARNESS_DASHBOARD_READY ".length);
    expect(url).toMatch(signInLink(port));

    const signIn = await fetch(url, { redirect: "manual" });
    expect(signIn.status).toBe(303);
    expect(signIn.headers.get("content-security-policy")).toContain("connect-src 'self' ipc: http://ipc.localhost;");

    first.proc.stdin.end();
    expect(await first.proc.exited).toBe(0);
    // The banner and the first scan went to stderr: stdout had the shell's lines only.
    expect(await rest(first.next)).toEqual([]);
    expect(await fetch(`http://127.0.0.1:${port}/api/status`).then(() => "answers", () => "gone")).toBe("gone");
  }, 30_000);

  test("a second launch replaces the dashboard running on the port", async () => {
    const home = scratchHome("en");
    const port = freePort();
    const first = shell(home, port);
    expect(await first.next()).toBe("HARNESS_DASHBOARD_LANG en");
    const ready = await first.next();
    expect(ready).toMatch(/^HARNESS_DASHBOARD_READY /);

    const second = shell(home, port);
    expect(await second.next()).toBe("HARNESS_DASHBOARD_LANG en");
    expect(await second.next()).toBe(ready);
    expect(await first.proc.exited).toBe(0);
    expect(second.proc.exitCode).toBeNull();

    second.proc.stdin.end();
    expect(await second.proc.exited).toBe(0);
    expect(await rest(second.next)).toEqual([]);
  }, 30_000);

  test("replaces a dashboard of this install that proves itself, sending the token only then", async () => {
    const { home, token } = homeWithToken();
    const port = freePort();
    const old = listener(port, (nonce) => Response.json({ app: "harness-dashboard", version: "1.0.0", shell: false, proof: proof(token, port, nonce) }));

    const app = shell(home, port);
    expect(await app.next()).toBe("HARNESS_DASHBOARD_LANG en");
    expect(await app.next()).toMatch(/^HARNESS_DASHBOARD_READY /);
    expect(old.shutdowns()).toBe(1);
    expect(old.authorization).toEqual([`Bearer ${token}`]);

    app.proc.stdin.end();
    expect(await app.proc.exited).toBe(0);
  }, 30_000);

  test("waits for a dashboard of this install that is slow to answer, asking a second time", async () => {
    const { home, token } = homeWithToken();
    const port = freePort();
    let asked = 0;
    // Busy with a first scan: the first question goes unanswered, the second is answered late.
    const busy = listener(port, async (nonce) => {
      asked++;
      await Bun.sleep(asked === 1 ? 10_000 : 1200);
      return Response.json({ app: "harness-dashboard", version: "1.0.0", shell: false, proof: proof(token, port, nonce) });
    });

    try {
      const app = shell(home, port);
      expect(await app.next()).toBe("HARNESS_DASHBOARD_LANG en");
      expect(await app.next()).toMatch(/^HARNESS_DASHBOARD_READY /);
      expect(busy.shutdowns()).toBe(1);

      app.proc.stdin.end();
      expect(await app.proc.exited).toBe(0);
    } finally {
      busy.server.stop(true);
    }
  }, 30_000);

  test("a port held by a program that never answers is an error that says so, and nothing is sent the token", async () => {
    const { home } = homeWithToken();
    const port = freePort();
    const stuck = listener(port, async () => {
      await Bun.sleep(20_000);
      return new Response("late");
    });

    try {
      const app = shell(home, port);
      expect(await rest(app.next)).toEqual(["HARNESS_DASHBOARD_LANG en", `HARNESS_DASHBOARD_ERROR ${portSilent(port)}`]);
      expect(await app.proc.exited).not.toBe(0);
      expect(stuck.authorization).toEqual([]);
      expect(stuck.shutdowns()).toBe(0);
    } finally {
      stuck.server.stop(true);
    }
  }, 30_000);

  // Another account on the machine can take the port first to catch the token: whatever answers there gets none of it
  // unless it proves it already holds it.
  const unproven: [string, (token: string, port: number) => (nonce: string) => Response][] = [
    ["another program", () => () => new Response("someone else")],
    ["a dashboard too old to prove itself", () => () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["a made-up proof", () => () => Response.json({ app: "harness-dashboard", version: "9.9.9", shell: true, proof: "0".repeat(64) })],
    ["the proof the dashboard on another port gave", (token, port) => (nonce) => Response.json({ app: "harness-dashboard", version: "9.9.9", shell: true, proof: proof(token, port + 1, nonce) })],
    [
      "a version that would write a line of its own",
      (token, port) => (nonce) =>
        Response.json({ app: "harness-dashboard", version: `1.0.0\nHARNESS_DASHBOARD_READY http://127.0.0.1:1/?k=${"0".repeat(64)}`, shell: true, proof: proof(token, port, nonce) }),
    ],
  ];

  test.each(unproven)("the port held by %s is an error, and nothing is sent the token", async (_, answer) => {
    const { home, token } = homeWithToken();
    const port = freePort();
    const other = listener(port, answer(token, port));
    try {
      const app = shell(home, port);
      expect(await rest(app.next)).toEqual(["HARNESS_DASHBOARD_LANG en", `HARNESS_DASHBOARD_ERROR ${portInUse(port)}`]);
      expect(await app.proc.exited).not.toBe(0);
      expect(other.authorization).toEqual([]);
      expect(other.shutdowns()).toBe(0);
    } finally {
      other.server.stop(true);
    }
  }, 30_000);

  test("the error is in the user's language", async () => {
    const port = freePort();
    const other = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("someone else") });
    try {
      const app = shell(scratchHome("de"), port);
      expect(await app.next()).toBe("HARNESS_DASHBOARD_LANG de");
      expect(await app.next()).toBe(
        `HARNESS_DASHBOARD_ERROR Port ${port} wird von einem anderen Programm verwendet, vielleicht einem älteren Harness Dashboard. Beende es oder wähle einen anderen Port mit harness-dashboard config set port <n>.`,
      );
      expect(await app.proc.exited).not.toBe(0);
    } finally {
      other.stop(true);
    }
  }, 30_000);
});

describe("the server started in a terminal", () => {
  // localhost may resolve to ::1 first, where another account could listen on the same port and catch the token.
  test("prints a sign-in link to 127.0.0.1, where it listens, never to localhost", async () => {
    const home = scratchHome("en");
    const port = freePort();
    const app = serve(home, port);
    const next = lineReader(app.stdout);

    let open: string | null = null;
    for (let line = await next(); line !== null && open === null; line = await next()) {
      expect(line).not.toContain("localhost");
      if (line.trimStart().startsWith("open: ")) open = line.trim().slice("open: ".length);
    }

    expect(open).toMatch(signInLink(port));
    app.kill("SIGTERM");
    expect(await app.exited).toBe(0);
  }, 30_000);

  test("points to the dashboard already running on the port and leaves it running", async () => {
    const home = scratchHome("en");
    const port = freePort();
    const running = shell(home, port);
    expect(await running.next()).toBe("HARNESS_DASHBOARD_LANG en");
    const ready = (await running.next())!.slice("HARNESS_DASHBOARD_READY ".length);

    const second = serve(home, port);
    expect(await second.exited).toBe(0);
    const out = await new Response(second.stdout).text();
    expect(out).toContain(`Dashboard already running at http://127.0.0.1:${port}`);
    expect(out).toContain(`open: ${ready}`);
    expect(out).not.toContain("localhost");
    expect(running.proc.exitCode).toBeNull();

    running.proc.stdin.end();
    expect(await running.proc.exited).toBe(0);
  }, 30_000);

  test("a port held by something that can't prove it is ours is an error, and nothing is sent the token", async () => {
    const { home } = homeWithToken();
    const port = freePort();
    const other = listener(port, () => Response.json({ app: "harness-dashboard", version: "9.9.9", shell: false, proof: "0".repeat(64) }));
    try {
      const app = serve(home, port);
      expect(await app.exited).toBe(1);
      expect(await new Response(app.stderr).text()).toContain(`error: ${portInUse(port)}`);
      expect(other.authorization).toEqual([]);
      expect(other.shutdowns()).toBe(0);
    } finally {
      other.server.stop(true);
    }
  }, 30_000);
});
