import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir, ensureAppDataDir } from "../core/paths.ts";

/**
 * The secret that lets a request into the API. Anything that can't read the app data folder (another account on the
 * machine, a web page) can't send it. Made once per install and kept, so windows stay signed in across restarts and
 * updates.
 */
export function loadToken(dir = appDataDir()): string {
  const path = join(dir, "auth-token");
  try {
    const token = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  } catch {
    /* not made yet */
  }
  ensureAppDataDir(dir);
  const token = randomBytes(32).toString("hex");
  try {
    // "wx": a second process starting at the same moment keeps the token the first one wrote.
    writeFileSync(path, token, { mode: 0o600, flag: "wx" });
    return token;
  } catch {
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
    writeFileSync(path, token, { mode: 0o600 });
    return token;
  }
}

/** Opening this signs the browser in: it sets the cookie and goes on to the app. The root path: see http.ts. */
export function signInUrl(base: string, token: string): string {
  return `${base}/?k=${token}`;
}

/** Cookies are kept per host, not per port: the port in the name keeps a dev server and the installed app apart. */
export function cookieName(port: number): string {
  return `hd_auth_${port}`;
}

export function sameToken(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * GET /api/hello?nonce=<32 hex> answers without the token, so a program can tell this install's dashboard from whatever
 * else holds the port before it sends the token there: another account on the machine may have taken the port to
 * catch it. The proof is an HMAC of the nonce under the token, so only a server that holds the token can make it. The
 * port is part of the message: a listener on one port can't pass on what the real dashboard on another port answers.
 */
export interface Hello {
  app: "harness-dashboard";
  version: string;
  /** Run by the app shell (`serve --shell`). */
  shell: boolean;
  proof: string;
}

export const HELLO_NONCE = /^[0-9a-f]{32}$/;

/** A version as a dashboard reports it. Anything else from a server is neither trusted nor printed. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function helloProof(token: string, port: number, nonce: string): string {
  return createHmac("sha256", token).update(`harness-dashboard-hello ${port} ${nonce}`).digest("hex");
}

/** The longest answer to /api/hello read: ours is about 200 characters. */
const HELLO_CHARS = 4096;

/** What answers on a port: this install's dashboard, something else, or nothing within the wait. */
export type PortProbe = { state: "ours"; version: string; shell: boolean } | { state: "other" } | { state: "silent" };

/** How long one /api/hello may take: a dashboard busy with its first scan or an import answers slowly. */
const HELLO_TIMEOUT_MS = 2000;

/**
 * Who answers on `port`. "ours" is the dashboard of this install. "other" is whatever answered without the proof: another
 * program, or a dashboard too old to prove itself (1.25 and older). "silent" is no answer, after one retry: nothing
 * listens there, or what does is too busy or stuck. Sends nothing secret: the token goes to a server only after this.
 */
export async function probeDashboard(port: number, token: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<PortProbe> {
  const first = await askHello(port, token, timeoutMs);
  if (first.state !== "silent") return first;

  return askHello(port, token, timeoutMs);
}

async function askHello(port: number, token: string, timeoutMs: number): Promise<PortProbe> {
  const nonce = randomBytes(16).toString("hex");

  let res: Response;
  let text: string;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/hello?nonce=${nonce}`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch {
    return { state: "silent" };
  }

  if (!res.ok || text.length > HELLO_CHARS) return { state: "other" };

  let body: Partial<Record<keyof Hello, unknown>>;
  try {
    body = JSON.parse(text);
  } catch {
    return { state: "other" };
  }

  if (body.app !== "harness-dashboard" || typeof body.proof !== "string" || !/^[0-9a-f]{64}$/.test(body.proof)) return { state: "other" };
  if (!sameToken(body.proof, helloProof(token, port, nonce))) return { state: "other" };
  if (typeof body.version !== "string" || !VERSION_PATTERN.test(body.version)) return { state: "other" };

  return { state: "ours", version: body.version, shell: body.shell === true };
}
