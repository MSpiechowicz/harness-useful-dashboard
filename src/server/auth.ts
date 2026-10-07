import { randomBytes, timingSafeEqual } from "node:crypto";
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

/** Opening this signs the browser in: it sets the cookie and goes on to the app. */
export function signInUrl(base: string, token: string): string {
  return `${base}/api/auth?k=${token}`;
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
