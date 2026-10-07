import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMeta, setMeta } from "./db.ts";
import { type CursorEvent, writeCursorEvent } from "./ingest/cursor.ts";
import type { IngestSink } from "./ingest/types.ts";

/**
 * Cursor keeps usage on its servers only. With the user's opt-in (Settings → Sync Cursor usage) this asks cursor.com for
 * the account's usage events, as its web dashboard does, with the login the Cursor editor keeps on this machine. The
 * login is read from Cursor's own database each time and never stored, logged or sent anywhere but cursor.com. It is
 * never renewed either: renewing would rotate it under Cursor. Failures carry fixed codes only, never cursor.com's reply.
 * Rows are written like a CSV import's (ingest/cursor.ts), so the two never count a call twice.
 */

export type CursorSyncCode = "not-signed-in" | "expired" | "unauthorized" | "rate-limited" | "unreachable" | "failed";

/** What Settings shows about the sync. Kept in the meta table per host, so a restart doesn't ask again early. */
export interface CursorSyncState {
  /** The last sync that went through, epoch ms. */
  syncedAt: number | null;
  /** New rows that sync wrote. */
  added: number;
  /** The newest event synced so far: the next sync starts a day before it. */
  cursor: number | null;
  /** The last try, epoch ms. */
  triedAt: number | null;
  code: CursorSyncCode | null;
  /** Not asked again before this, epoch ms. */
  nextAt: number | null;
  /** Failures in a row, for the backoff. */
  failures: number;
  /** When the login cursor.com refused expires: it isn't sent again, a new login from Cursor is. Not secret. */
  refusedExp?: number | null;
}

export interface CursorSyncDeps {
  now?: () => number;
  fetch?: typeof fetch;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How often usage is synced in the background. */
export const CURSOR_SYNC_MS = 6 * HOUR;
/** A sync starts this long before the newest event it has: events can show up late. Rows already there are kept. */
const OVERLAP_MS = DAY;
/** How far back the first sync reaches. */
const FIRST_SYNC_MS = 30 * DAY;
/** Without a login nothing is sent: looking again for one is a local read, so it's done often. */
const LOCAL_RETRY_MS = 10 * 60_000;
/** Sync now asks again only once the last try is a minute old. */
const FORCE_AFTER_MS = 60_000;
const RETRY_MS = 30 * 60_000;
const RATE_LIMITED_MS = 30 * 60_000;
const MAX_BACKOFF_MS = CURSOR_SYNC_MS;
const PAGE_SIZE = 500;
/** At most this many pages a sync: 50,000 calls, far more than a month brings. */
const MAX_PAGES = 100;

const ORIGIN = "https://cursor.com";
const EVENTS_URL = `${ORIGIN}/api/dashboard/get-filtered-usage-events`;

class SyncError extends Error {
  constructor(
    readonly code: CursorSyncCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

function withDefaults(d: CursorSyncDeps): Required<CursorSyncDeps> {
  return { now: d.now ?? Date.now, fetch: d.fetch ?? fetch, home: d.home ?? homedir(), platform: d.platform ?? process.platform, env: d.env ?? process.env };
}

/** Cursor's own database: <settings folder>/Cursor/User/globalStorage/state.vscdb, as VS Code keeps it. */
export function cursorStatePath(deps: CursorSyncDeps = {}): string {
  const { home, platform, env } = withDefaults(deps);
  const base =
    platform === "darwin"
      ? join(home, "Library", "Application Support")
      : platform === "win32"
        ? (env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

export interface CursorLogin {
  /** The value of the session cookie cursor.com's dashboard sends. */
  cookie: string;
  /** When the login expires, epoch ms, when it says. */
  expiresAt: number | null;
}

/** A text value SQLite hands back as bytes: UTF-16LE when every second byte is zero, else UTF-8. */
function blobText(b: Uint8Array): string {
  const utf16 = b.length >= 2 && b.length % 2 === 0 && b.every((x, i) => i % 2 === 0 || x === 0);
  return Buffer.from(b).toString(utf16 ? "utf16le" : "utf8");
}

/** The claims of a JWT, unverified: only to read the user id and expiry Cursor's own login carries. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The login the Cursor editor keeps, read from its database without changing it (read-only, Cursor may have it open).
 * Null when Cursor isn't installed or isn't signed in.
 */
export function readCursorLogin(deps: CursorSyncDeps = {}): CursorLogin | null {
  let raw: unknown;
  try {
    const db = new Database(cursorStatePath(deps), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 1000");
      raw = db.query<{ value: unknown }, [string]>("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken")?.value;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
  let token = raw instanceof Uint8Array ? blobText(raw) : typeof raw === "string" ? raw : "";
  // The value is plain text. Should a version keep it as a JSON string, its quotes come off.
  if (token.startsWith('"')) {
    try {
      token = String(JSON.parse(token));
    } catch {
      return null;
    }
  }
  token = token.trim();
  // A JWT has three base64url parts: anything else is not a login this can use, and can't smuggle into a header.
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
  const claims = jwtClaims(token);
  // The subject is "<identity provider>|<user id>", e.g. "auth0|user_01J…".
  const sub = typeof claims?.sub === "string" ? claims.sub : "";
  const userId = sub.split("|").filter(Boolean).pop() ?? "";
  if (!/^[\w.-]+$/.test(userId)) return null;
  const exp = typeof claims?.exp === "number" ? claims.exp * 1000 : null;
  return { cookie: `${userId}%3A%3A${token}`, expiresAt: exp };
}

/** A Retry-After header: seconds, or an HTTP date. */
function retryAfter(res: Response, now: number): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/** One page of usage events. Failures carry fixed codes only: never cursor.com's reply. */
async function eventsPage(d: Required<CursorSyncDeps>, login: CursorLogin, from: number, to: number, page: number): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await d.fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        // cursor.com's dashboard endpoints refuse a POST without its own origin (CSRF protection).
        Origin: ORIGIN,
        "User-Agent": "harness-dashboard",
        Cookie: `WorkosCursorSessionToken=${login.cookie}`,
      },
      body: JSON.stringify({ startDate: String(from), endDate: String(to), page, pageSize: PAGE_SIZE }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SyncError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new SyncError("unauthorized");
  if (res.status === 429) throw new SyncError("rate-limited", retryAfter(res, d.now()));
  if (!res.ok) throw new SyncError("failed");
  try {
    const body = await res.json();
    if (!body || typeof body !== "object") throw new Error();
    return body as Record<string, any>;
  } catch {
    throw new SyncError("failed");
  }
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** How a call was billed, in the words the CSV export uses ("Included", "On-Demand", …). */
function kindLabel(kind: unknown): string | null {
  if (typeof kind !== "string" || !kind) return null;
  if (/^USAGE_EVENT_KIND_(INCLUDED|FREE_CREDIT)/.test(kind)) return "Included";
  if (kind === "USAGE_EVENT_KIND_USAGE_BASED") return "On-Demand";
  if (kind === "USAGE_EVENT_KIND_ERRORED_NOT_CHARGED") return "Errored, No Charge";
  const words = kind.replace(/^USAGE_EVENT_KIND_/, "").toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A usage event of cursor.com's dashboard as a call to write, null when it carries no time. */
export function cursorEvent(e: Record<string, any>): CursorEvent | null {
  const ts = num(e.timestamp);
  if (!ts) return null;
  const t = e.tokenUsage && typeof e.tokenUsage === "object" ? (e.tokenUsage as Record<string, unknown>) : {};
  // What the call was charged, in cents, as the CSV export's Cost column. An included call is charged nothing and is
  // priced from the price book, like an import's "Included".
  const cents = num(e.chargedCents) || (e.kind === "USAGE_EVENT_KIND_USAGE_BASED" ? num(t.totalCents) : 0);
  return {
    ts,
    user: null,
    model: typeof e.model === "string" && e.model ? e.model : null,
    kind: kindLabel(e.kind),
    input: Math.round(num(t.inputTokens)),
    cacheWrite: Math.round(num(t.cacheWriteTokens)),
    cacheRead: Math.round(num(t.cacheReadTokens)),
    output: Math.round(num(t.outputTokens)),
    cost: cents ? cents / 100 : null,
  };
}

/** Every usage event from `from` to `to`, page by page. */
async function fetchEvents(d: Required<CursorSyncDeps>, login: CursorLogin, from: number, to: number): Promise<CursorEvent[]> {
  const events: CursorEvent[] = [];
  let seen = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await eventsPage(d, login, from, to, page);
    // An empty range answers {}, and the page after the last one leaves the list out.
    const list = body.usageEventsDisplay;
    if (list !== undefined && !Array.isArray(list)) throw new SyncError("failed");
    const items = (list ?? []) as unknown[];
    for (const item of items) {
      const ev = item && typeof item === "object" ? cursorEvent(item as Record<string, any>) : null;
      if (ev) events.push(ev);
    }
    seen += items.length;
    const total = num(body.totalUsageEventsCount);
    // Pages can overlap at their edges: rows written twice are the same row.
    if (items.length < PAGE_SIZE || (total && seen >= total)) break;
  }
  return events;
}

const metaKey = (host: string) => `cursor_sync:${host}`;

export function syncState(db: Database, host: string): CursorSyncState {
  const empty: CursorSyncState = { syncedAt: null, added: 0, cursor: null, triedAt: null, code: null, nextAt: null, failures: 0 };
  try {
    const raw = getMeta(db, metaKey(host));
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<CursorSyncState>) } : empty;
  } catch {
    return empty;
  }
}

function cursorRows(db: Database, host: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM usage WHERE provider = 'cursor' AND host = ?").get(host)?.n ?? 0;
}

/**
 * Syncs when due: every 6 hours, and after a failure once its backoff is over. `force` (Sync now) asks right away,
 * except while cursor.com has asked to wait. Writes nothing and asks nothing while the sync is off.
 */
export async function syncCursor(
  db: Database,
  host: string,
  sink: () => IngestSink,
  opts: { enabled: boolean; force?: boolean },
  deps: CursorSyncDeps = {},
): Promise<CursorSyncState> {
  const d = withDefaults(deps);
  const state = syncState(db, host);
  if (!opts.enabled) return state;
  const now = d.now();
  const waiting = state.nextAt != null && now < state.nextAt;
  const recent = state.triedAt != null && now - state.triedAt < FORCE_AFTER_MS;
  if (opts.force ? recent || (waiting && state.code === "rate-limited") : waiting || (state.syncedAt != null && state.code == null && now - state.syncedAt < CURSOR_SYNC_MS)) return state;

  const save = (next: CursorSyncState) => {
    setMeta(db, metaKey(host), JSON.stringify(next));
    return next;
  };
  const fail = (code: CursorSyncCode, retryAfterMs: number | null = null, refusedExp = state.refusedExp ?? null): CursorSyncState => {
    const failures = state.failures + 1;
    // Without a usable login nothing was sent, and looking again for a new one is a local read.
    const wait =
      code === "not-signed-in" || code === "expired" || code === "unauthorized"
        ? LOCAL_RETRY_MS
        : code === "rate-limited"
          ? Math.min(MAX_BACKOFF_MS, Math.max(retryAfterMs ?? 0, RATE_LIMITED_MS * 2 ** (failures - 1)))
          : Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** (failures - 1));
    if (code !== state.code) console.error(`[cursor] sync failed: ${code}`);
    return save({ ...state, triedAt: now, code, nextAt: now + wait, failures, refusedExp });
  };

  const login = readCursorLogin(d);
  if (!login) return fail("not-signed-in");
  // Renewing the login would rotate it under Cursor and sign Cursor out, so an expired one is reported instead. One
  // that runs out within the minute counts as expired too.
  if (login.expiresAt != null && login.expiresAt - now <= 60_000) return fail("expired");
  // A login cursor.com refused is sent again only on Sync now: a new one from Cursor has a new expiry.
  if (!opts.force && state.code === "unauthorized" && login.expiresAt === (state.refusedExp ?? null)) return fail("unauthorized");
  const from = state.cursor != null ? state.cursor - OVERLAP_MS : now - FIRST_SYNC_MS;
  let events: CursorEvent[];
  try {
    events = await fetchEvents(d, login, from, now);
  } catch (e) {
    const err = e instanceof SyncError ? e : new SyncError("failed");
    return fail(err.code, err.retryAfterMs, err.code === "unauthorized" ? login.expiresAt : null);
  }
  const before = cursorRows(db, host);
  const writer = sink();
  const seen = new Set<string>();
  db.transaction(() => {
    for (const ev of events) writeCursorEvent(ev, writer, seen);
  })();
  const newest = events.reduce((m, e) => Math.max(m, e.ts), state.cursor ?? 0);
  return save({ syncedAt: now, added: cursorRows(db, host) - before, cursor: newest || null, triedAt: now, code: null, nextAt: now + CURSOR_SYNC_MS, failures: 0, refusedExp: null });
}
