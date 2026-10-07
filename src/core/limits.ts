import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordReports } from "./plans.ts";

/**
 * How much of their plan limits the user has left, from the places that know:
 *  - "claude": Anthropic, asked with the Claude Code login on this machine (what Claude Code's /usage shows).
 *  - "omp": every account omp is logged in to (`omp usage --json`): Claude, ChatGPT/Codex, Copilot, Gemini, …
 *  - "codex": the readings Codex writes into its session logs, stored while ingesting. No network.
 *  - "pi", "opencode": the logins those harnesses keep (auth.json), each asked at its own provider: Anthropic for a
 *    Claude plan, ChatGPT for a Codex plan, GitHub for Copilot premium requests.
 * Credentials never leave this process except to their own provider, and errors carry fixed messages only.
 */

export type LimitSource = "claude" | "omp" | "codex" | "pi" | "opencode";

export interface LimitWindow {
  id: string;
  /** The window's length, when known: 5 hours, 7 days, … */
  windowMs: number | null;
  /** What the window is limited to, when not everything: a model family ("Opus") or a meter. */
  scope: string | null;
  /** The provider's own name for the window, used when its length is unknown. */
  label: string | null;
  usedFraction: number;
  /** Epoch ms, null when not reported. */
  resetsAt: number | null;
  /** Counted limits (Copilot premium requests): how many of how many. */
  used?: number;
  limit?: number;
  unit?: string;
  /** The reading is older than the window: it has reset since, and its use is unknown but low. */
  reset?: boolean;
}

export interface LimitReport {
  key: string;
  /** "claude", "codex", "copilot", or the provider id omp uses for the others. */
  provider: string;
  plan: string | null;
  /** A short account hint, set only when one provider has several accounts. */
  account: string | null;
  source: LimitSource;
  /** When the reading was taken, epoch ms. */
  observedAt: number;
  windows: LimitWindow[];
}

export interface LimitProblem {
  source: LimitSource;
  code: "expired" | "unauthorized" | "rate-limited" | "unreachable" | "failed" | "not-installed";
  /** When the source is asked again, epoch ms. */
  retryAt?: number;
}

export interface LimitsResult {
  reports: LimitReport[];
  problems: LimitProblem[];
  fetchedAt: number;
}

export interface LimitDeps {
  now?: () => number;
  fetch?: typeof fetch;
  /** Runs a command, returning its stdout, or null when it can't run or fails. */
  run?: (cmd: string[], timeoutMs: number) => Promise<string | null>;
  readFile?: (path: string) => string | null;
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class LimitError extends Error {
  constructor(
    readonly code: LimitProblem["code"],
    /** How long the provider asked us to wait (a 429's Retry-After). */
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
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

async function runCommand(cmd: string[], timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Claude: the usage endpoint behind Claude Code's /usage, with Claude Code's own login.

/** Anthropic's names for the windows: five_hour, seven_day, seven_day_opus, … */
const CLAUDE_WINDOW = /^(five_hour|seven_day)(?:_(.+))?$/;

export function claudeWindows(body: Record<string, unknown>): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const [id, v] of Object.entries(body)) {
    const m = CLAUDE_WINDOW.exec(id);
    if (!m || !v || typeof v !== "object") continue;
    const { utilization, resets_at } = v as { utilization?: unknown; resets_at?: unknown };
    if (typeof utilization !== "number") continue;
    // Usage by third-party apps signed in with the account isn't a limit of its own.
    if (m[2] === "oauth_apps") continue;
    const resets = typeof resets_at === "string" ? Date.parse(resets_at) : NaN;
    windows.push({
      id,
      windowMs: m[1] === "five_hour" ? 5 * HOUR : 7 * DAY,
      scope: m[2] ? m[2].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : null,
      label: null,
      usedFraction: Math.max(0, utilization / 100),
      resetsAt: Number.isFinite(resets) ? resets : null,
    });
  }
  // The 5-hour window first, then the weekly ones, the overall one before the per-model ones.
  return windows.sort((a, b) => (a.windowMs ?? 0) - (b.windowMs ?? 0) || Number(!!a.scope) - Number(!!b.scope));
}

interface ClaudeLogin {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

async function claudeLogin(d: Required<LimitDeps>): Promise<ClaudeLogin | null> {
  const dir = d.env.CLAUDE_CONFIG_DIR ?? join(d.home, ".claude");
  let raw = d.readFile(join(dir, ".credentials.json"));
  // On macOS Claude Code keeps its login in the keychain instead.
  if (raw == null && d.platform === "darwin") raw = await d.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], 5000);
  if (raw == null) return null;
  try {
    const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string") return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      plan: typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/** A GET to a provider with a login, answering JSON. Failures carry fixed codes only: never the provider's reply. */
async function askProvider(d: Required<LimitDeps>, url: string, headers: Record<string, string>): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await d.fetch(url, { headers: { Accept: "application/json", "User-Agent": "harness-dashboard", ...headers }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new LimitError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new LimitError("unauthorized");
  if (res.status === 429) throw new LimitError("rate-limited", retryAfter(res, d.now()));
  if (!res.ok) throw new LimitError("failed");
  try {
    return (await res.json()) as Record<string, any>;
  } catch {
    throw new LimitError("failed");
  }
}

/** A Claude plan's windows, asked with an Anthropic OAuth login (Claude Code's, pi's or OpenCode's). */
async function anthropicWindows(d: Required<LimitDeps>, token: string): Promise<LimitWindow[]> {
  return claudeWindows(await askProvider(d, "https://api.anthropic.com/api/oauth/usage", { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }));
}

export async function claudeLimits(deps: LimitDeps = {}): Promise<LimitReport | null> {
  const d = withDefaults(deps);
  const login = await claudeLogin(d);
  if (!login) return null;
  // Renewing the login would sign Claude Code out (the refresh token rotates), so an expired one is reported instead.
  if (login.expiresAt != null && login.expiresAt <= d.now()) throw new LimitError("expired");
  const windows = await anthropicWindows(d, login.accessToken);
  return { key: "claude:login", provider: "claude", plan: login.plan, account: null, source: "claude", observedAt: d.now(), windows };
}

// ---------------------------------------------------------------------------------------------------------------
// ChatGPT plans (Codex) and GitHub Copilot, asked with a harness's own login.

/** ChatGPT's usage windows: used percent, length and reset of the primary and secondary window. */
export function chatgptWindows(body: Record<string, any>, now: number): LimitWindow[] {
  const windows: LimitWindow[] = [];
  const rate = body?.rate_limit ?? {};
  for (const id of ["primary_window", "secondary_window"] as const) {
    const w = rate[id];
    if (!w || typeof w.used_percent !== "number") continue;
    const resetsAt = typeof w.reset_at === "number" ? w.reset_at * 1000 : typeof w.reset_after_seconds === "number" ? now + w.reset_after_seconds * 1000 : null;
    windows.push({
      id: id === "primary_window" ? "primary" : "secondary",
      windowMs: typeof w.limit_window_seconds === "number" ? w.limit_window_seconds * 1000 : null,
      scope: null,
      label: null,
      usedFraction: Math.max(0, w.used_percent / 100),
      resetsAt,
    });
  }
  return windows.sort((a, b) => (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity));
}

/** Copilot's monthly premium requests: how many of the plan's entitlement are used, until the quota resets. */
export function copilotWindows(body: Record<string, any>): LimitWindow[] {
  const premium = body?.quota_snapshots?.premium_interactions;
  if (!premium || premium.unlimited || typeof premium.entitlement !== "number" || premium.entitlement <= 0 || typeof premium.remaining !== "number") return [];
  const used = Math.max(0, premium.entitlement - premium.remaining);
  const reset = typeof body.quota_reset_date === "string" ? Date.parse(body.quota_reset_date) : NaN;
  return [
    { id: "premium", windowMs: null, scope: null, label: "Premium requests", usedFraction: used / premium.entitlement, resetsAt: Number.isFinite(reset) ? reset : null, used, limit: premium.entitlement, unit: "requests" },
  ];
}

/** The ChatGPT account a Codex login belongs to, from the login token's claims when not stored beside it. */
function chatgptAccount(token: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    const id = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/** One provider's login in a harness's auth.json: an OAuth access token, when it expires, and what else it carries. */
interface StoredLogin {
  access: string | null;
  refresh: string | null;
  /** Epoch ms. */
  expires: number | null;
  accountId: string | null;
}

function storedLogin(v: unknown): StoredLogin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.type !== "oauth") return null; // API keys have no plan limits
  const str = (...keys: string[]) => keys.map((k) => o[k]).find((x): x is string => typeof x === "string" && x.length > 0) ?? null;
  const exp = [o.expires, o.expiresAt].find((x): x is number => typeof x === "number") ?? null;
  return {
    access: str("access", "accessToken"),
    refresh: str("refresh", "refreshToken"),
    // Seconds or milliseconds, whichever was stored.
    expires: exp == null ? null : exp < 1e12 ? exp * 1000 : exp,
    accountId: str("accountId", "account_id"),
  };
}

/** Where pi and OpenCode keep their logins. */
function authFile(source: "pi" | "opencode", d: Required<LimitDeps>): string {
  return source === "pi" ? join(d.home, ".pi", "agent", "auth.json") : join(d.env.XDG_DATA_HOME ?? join(d.home, ".local", "share"), "opencode", "auth.json");
}

/**
 * The plan limits of every account pi or OpenCode is logged in to: a Claude plan at Anthropic, a ChatGPT plan at
 * ChatGPT, Copilot at GitHub. Logins are never renewed (that would sign the harness out): an expired one is reported.
 * A provider that says it's asked too often holds back the whole source; other failures leave the rest standing.
 */
export async function loginLimits(source: "pi" | "opencode", deps: LimitDeps = {}): Promise<{ reports: LimitReport[]; problem: LimitProblem["code"] | null }> {
  const d = withDefaults(deps);
  const raw = d.readFile(authFile(source, d));
  if (raw == null) return { reports: [], problem: null };
  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { reports: [], problem: "failed" };
  }
  const now = d.now();
  const reports: LimitReport[] = [];
  let problem: LimitProblem["code"] | null = null;
  const asks: [string, () => Promise<{ plan: string | null; windows: LimitWindow[] } | null>][] = [
    ["anthropic", async () => {
      const l = storedLogin(auth.anthropic);
      if (!l?.access) return null;
      if (l.expires != null && l.expires <= now) throw new LimitError("expired");
      return { plan: null, windows: await anthropicWindows(d, l.access) };
    }],
    // pi names the ChatGPT login "openai-codex", OpenCode "openai".
    ["codex", async () => {
      const l = storedLogin(auth["openai-codex"]) ?? storedLogin(auth.openai);
      if (!l?.access) return null;
      if (l.expires != null && l.expires <= now) throw new LimitError("expired");
      const account = l.accountId ?? chatgptAccount(l.access);
      const body = await askProvider(d, "https://chatgpt.com/backend-api/wham/usage", { Authorization: `Bearer ${l.access}`, ...(account ? { "ChatGPT-Account-Id": account } : {}) });
      return { plan: typeof body.plan_type === "string" ? body.plan_type : null, windows: chatgptWindows(body, now) };
    }],
    // Copilot's GitHub token is the login's refresh token: the access token is a short-lived Copilot API token.
    ["copilot", async () => {
      const l = storedLogin(auth["github-copilot"]);
      const token = l?.refresh ?? l?.access;
      if (!token) return null;
      const body = await askProvider(d, "https://api.github.com/copilot_internal/user", { Authorization: `token ${token}` });
      return { plan: typeof body.copilot_plan === "string" ? body.copilot_plan : null, windows: copilotWindows(body) };
    }],
  ];
  for (const [provider, ask] of asks) {
    try {
      const r = await ask();
      if (r && r.windows.length) reports.push({ key: `${source}:${provider}`, provider: provider === "anthropic" ? "claude" : provider, plan: r.plan, account: null, source, observedAt: now, windows: r.windows });
    } catch (e) {
      const code = e instanceof LimitError ? e.code : "failed";
      if (code === "rate-limited") throw e;
      problem ??= code;
    }
  }
  if (!reports.length && problem) throw new LimitError(problem);
  return { reports, problem };
}

// ---------------------------------------------------------------------------------------------------------------
// omp: one report per logged-in account and provider.

/** omp's provider ids, as this dashboard names them. */
const OMP_PROVIDERS: Record<string, string> = { anthropic: "claude", "openai-codex": "codex", "github-copilot": "copilot" };

export function ompReports(json: unknown, now: number): LimitReport[] {
  const reports = (json as { reports?: unknown })?.reports;
  if (!Array.isArray(reports)) throw new LimitError("failed");
  const out: LimitReport[] = [];
  reports.forEach((r: Record<string, any>, i) => {
    if (!r || typeof r.provider !== "string" || !Array.isArray(r.limits)) return;
    const windows: LimitWindow[] = [];
    for (const l of r.limits as Record<string, any>[]) {
      const a = l?.amount ?? {};
      const fraction =
        typeof a.usedFraction === "number" ? a.usedFraction : typeof a.used === "number" && typeof a.limit === "number" && a.limit > 0 ? a.used / a.limit : null;
      // Balances (prepaid credit) have no share used: they aren't a limit window.
      if (fraction == null) continue;
      const counted = a.unit && a.unit !== "percent" && typeof a.used === "number" && typeof a.limit === "number";
      windows.push({
        id: String(l.id ?? windows.length),
        windowMs: typeof l.window?.durationMs === "number" ? l.window.durationMs : null,
        scope: typeof l.scope?.modelId === "string" ? l.scope.modelId : typeof l.scope?.tier === "string" ? l.scope.tier : null,
        label: typeof l.label === "string" ? l.label : null,
        usedFraction: Math.max(0, fraction),
        resetsAt: typeof l.window?.resetsAt === "number" ? l.window.resetsAt : null,
        ...(counted ? { used: a.used, limit: a.limit, unit: String(a.unit) } : {}),
      });
    }
    if (!windows.length) return;
    const meta = r.metadata ?? {};
    out.push({
      key: `omp:${r.provider}:${typeof meta.accountId === "string" ? meta.accountId : i}`,
      provider: OMP_PROVIDERS[r.provider] ?? r.provider,
      plan: typeof meta.planType === "string" ? meta.planType : null,
      account: typeof meta.email === "string" ? meta.email : null,
      source: "omp",
      observedAt: typeof r.fetchedAt === "number" ? r.fetchedAt : now,
      windows: windows.sort((a, b) => (a.windowMs ?? Infinity) - (b.windowMs ?? Infinity)),
    });
  });
  // An account hint only helps to tell several accounts of one provider apart.
  for (const r of out) if (out.filter((o) => o.provider === r.provider).length < 2) r.account = null;
  return out;
}

function ompBinary(d: Required<LimitDeps>): string | null {
  const candidates = [Bun.which("omp"), join(d.home, ".bun", "bin", "omp"), join(d.home, ".local", "bin", "omp")];
  return candidates.find((p): p is string => !!p && existsSync(p)) ?? null;
}

export async function ompLimits(deps: LimitDeps = {}): Promise<LimitReport[]> {
  const d = withDefaults(deps);
  const bin = deps.run ? "omp" : ompBinary(d);
  if (!bin) throw new LimitError("not-installed");
  // --redact shortens account emails to a prefix: enough to tell accounts apart, nothing more is needed here.
  const out = await d.run([bin, "usage", "--json", "--redact"], 30_000);
  if (out == null) throw new LimitError("failed");
  try {
    return ompReports(JSON.parse(out), d.now());
  } catch (e) {
    throw e instanceof LimitError ? e : new LimitError("failed");
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Codex: the readings stored from its logs.

export function codexLimits(db: Database, host: string, now: number): LimitReport | null {
  let rows = db
    .query<{ window_id: string; window_minutes: number | null; used_percent: number; resets_at: number | null; plan: string | null; observed_at: number }, [string]>(
      `SELECT window_id, window_minutes, used_percent, resets_at, plan, observed_at FROM plan_limits WHERE provider = 'codex' AND host = ?
       ORDER BY window_minutes`,
    )
    .all(host);
  if (!rows.length) return null;
  // Codex logs every window it has at each reading: one missing from the latest reading is gone (the plan changed).
  const latest = Math.max(...rows.map((r) => r.observed_at));
  rows = rows.filter((r) => r.observed_at >= latest - 60_000);
  return {
    key: "codex:logs",
    provider: "codex",
    plan: rows.find((r) => r.plan)?.plan ?? null,
    account: null,
    source: "codex",
    observedAt: latest,
    windows: rows.map((r) => {
      const reset = r.resets_at != null && r.resets_at <= now;
      return {
        id: r.window_id,
        windowMs: r.window_minutes != null ? r.window_minutes * 60_000 : null,
        scope: null,
        label: null,
        usedFraction: reset ? 0 : r.used_percent / 100,
        resetsAt: reset ? null : r.resets_at,
        ...(reset ? { reset: true } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Which plans are in use: only those are asked about.

/** A plan in use: the provider whose limits apply, and the source that reports them for the harness used. */
export interface ActivePlan {
  provider: string;
  source: LimitSource;
}

/**
 * The plan a call counts against: Claude Code against the Claude plan of its login, Codex against the ChatGPT plan it
 * logs, and omp, pi and OpenCode against whatever they billed the call through (a Claude or ChatGPT login, Copilot),
 * read with their own logins. Cursor reports none.
 */
export function planFor(provider: string, billing: string | null): ActivePlan | null {
  if (provider === "claude") return { provider: "claude", source: "claude" };
  if (provider === "codex") return { provider: "codex", source: "codex" };
  if ((provider === "omp" || provider === "pi" || provider === "opencode") && billing) {
    // OpenCode names its ChatGPT login "openai".
    const plan = provider === "opencode" && billing === "openai" ? "codex" : (OMP_PROVIDERS[billing] ?? billing);
    return { provider: plan, source: provider };
  }
  return null;
}

/** The plans used since `from` (epoch ms), each once. */
export function activePlans(db: Database, from: number): ActivePlan[] {
  const rows = db
    .query<{ provider: string; billing: string | null }, [number]>("SELECT DISTINCT provider, billing FROM usage WHERE ts >= ?")
    .all(from);
  const plans = new Map<string, ActivePlan>();
  for (const r of rows) {
    const plan = planFor(r.provider, r.billing);
    if (plan) plans.set(`${plan.source}:${plan.provider}`, plan);
  }
  return [...plans.values()];
}

// ---------------------------------------------------------------------------------------------------------------

function withDefaults(d: LimitDeps): Required<LimitDeps> {
  return {
    now: d.now ?? Date.now,
    fetch: d.fetch ?? fetch,
    run: d.run ?? runCommand,
    readFile: d.readFile ?? readText,
    home: d.home ?? homedir(),
    platform: d.platform ?? process.platform,
    env: d.env ?? process.env,
  };
}

/**
 * Network sources are asked sparingly, however often pages poll: a reading is kept for 5 minutes (a 5-hour window
 * moves slowly, and Anthropic's usage endpoint answers "too often" quickly, more so beside Claude Code's own /usage),
 * "Refresh" asks again only once it's a minute old, and a failure waits before the next try. When a provider says it's
 * asked too often, the wait starts at 5 minutes (or what it asks for) and doubles each time up to 30. Meanwhile the last
 * good reading is still shown: the one in memory, or after a restart the last one stored (see storedReports).
 */
const FRESH_MS = 5 * 60_000;
/** How old a stored reading may be to stand in for one that can't be taken now. */
const STORED_MAX_AGE_MS = 6 * 60 * 60_000;
const FORCE_AFTER_MS = 60_000;
const RETRY_MS = 2 * 60_000;
const RATE_LIMITED_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

interface Cached {
  /** When the source was last asked. */
  at: number;
  /** The last good reading's reports: kept through failures. */
  reports: LimitReport[];
  problem: LimitProblem | null;
  /** Not asked again before this, epoch ms. */
  nextAt: number;
  /** Failures in a row, for the backoff. */
  failures: number;
}

/**
 * The last readings this machine stored for a source, for when its provider can't be asked right now: the app just
 * started (an update, a restart) and the first answer is "asked too often". Windows that have reset since are left out,
 * their use is no longer known.
 */
export function storedReports(db: Database, host: string, source: LimitSource, now: number): LimitReport[] {
  const rows = db
    .query<
      { key: string; provider: string; plan: string | null; windowId: string; windowMs: number | null; scope: string | null; label: string | null; used: number; resetsAt: number | null; observedAt: number },
      [string, string, number]
    >(
      `SELECT report_key AS key, provider, plan, window_id AS windowId, window_ms AS windowMs, scope, label, used_fraction AS used,
              resets_at AS resetsAt, observed_at AS observedAt
       FROM limit_readings r
       WHERE host = ? AND report_key LIKE ? AND observed_at >= ?
         AND observed_at = (SELECT MAX(observed_at) FROM limit_readings x WHERE x.host = r.host AND x.report_key = r.report_key AND x.window_id = r.window_id)
       ORDER BY report_key, window_ms`,
    )
    .all(host, `${source}:%`, now - STORED_MAX_AGE_MS);
  const reports = new Map<string, LimitReport>();
  for (const r of rows) {
    if (r.resetsAt != null && r.resetsAt <= now) continue;
    let rep = reports.get(r.key);
    if (!rep) reports.set(r.key, (rep = { key: r.key, provider: r.provider, plan: r.plan, account: null, source, observedAt: r.observedAt, windows: [] }));
    rep.observedAt = Math.min(rep.observedAt, r.observedAt);
    rep.windows.push({ id: r.windowId, windowMs: r.windowMs, scope: r.scope, label: r.label, usedFraction: r.used, resetsAt: r.resetsAt });
  }
  return [...reports.values()].filter((r) => r.windows.length);
}

export class LimitsCache {
  private cached = new Map<LimitSource, Cached>();
  private pending = new Map<LimitSource, Promise<void>>();

  constructor(private deps: LimitDeps = {}) {}

  /** With `active`, only the sources those plans need are asked, and only their reports come back. */
  async get(db: Database, host: string, enabled: Partial<Record<LimitSource, boolean>>, force = false, active?: ActivePlan[]): Promise<LimitsResult> {
    const now = (this.deps.now ?? Date.now)();
    const on = (s: LimitSource) => !!enabled[s] && (!active || active.some((a) => a.source === s));
    type Loaded = { reports: LimitReport[]; problem: LimitProblem["code"] | null };
    const remote: [LimitSource, () => Promise<Loaded>][] = [
      ["claude", async () => ({ reports: ((r) => (r ? [r] : []))(await claudeLimits(this.deps)), problem: null })],
      ["omp", async () => ({ reports: await ompLimits(this.deps), problem: null })],
      ["pi", () => loginLimits("pi", this.deps)],
      ["opencode", () => loginLimits("opencode", this.deps)],
    ];
    await Promise.all(
      remote
        .filter(([s]) => on(s))
        .map(([source, load]) => {
          const c = this.cached.get(source);
          // Refresh asks sooner than the schedule, but never during a backoff after a failure.
          const due = !c || now >= c.nextAt || (force && !c.problem && now - c.at >= FORCE_AFTER_MS);
          if (!due) return Promise.resolve();
          let p = this.pending.get(source);
          if (!p) {
            p = load()
              // A login that failed beside others that answered is noted, without holding the source back.
              .then(({ reports, problem }) => void this.cached.set(source, { at: now, reports, problem: problem ? { source, code: problem } : null, nextAt: now + FRESH_MS, failures: 0 }))
              .catch((e) => {
                const err = e instanceof LimitError ? e : new LimitError("failed");
                const failures = (c?.failures ?? 0) + 1;
                const wait =
                  err.code === "rate-limited"
                    ? Math.min(MAX_BACKOFF_MS, Math.max(err.retryAfterMs ?? 0, RATE_LIMITED_MS * 2 ** (failures - 1)))
                    : Math.min(MAX_BACKOFF_MS, RETRY_MS * 2 ** (failures - 1));
                this.cached.set(source, { at: now, reports: c?.reports ?? [], problem: { source, code: err.code, retryAt: now + wait }, nextAt: now + wait, failures });
              })
              .finally(() => this.pending.delete(source));
            this.pending.set(source, p);
          }
          return p;
        }),
    );
    const reports: LimitReport[] = [];
    const problems: LimitProblem[] = [];
    for (const [source] of remote) {
      const c = this.cached.get(source);
      if (!on(source) || !c) continue;
      reports.push(...(c.reports.length || !c.problem ? c.reports : storedReports(db, host, source, now)));
      // omp missing is not a problem worth showing: most people don't use it.
      if (c.problem && c.problem.code !== "not-installed") problems.push(c.problem);
    }
    if (on("codex")) {
      const codex = codexLimits(db, host, now);
      if (codex) reports.push(codex);
    }
    // Fresh readings go into the history the plans view draws. A reading kept from earlier is already there.
    const fresh = reports.filter((r) => now - r.observedAt < FRESH_MS);
    if (fresh.length) {
      try {
        recordReports(db, host, fresh);
      } catch (e) {
        console.error("[limits] could not keep the readings:", e);
      }
    }
    const shown = active ? reports.filter((r) => active.some((a) => a.provider === r.provider && a.source === r.source)) : reports;
    return { reports: shown, problems, fetchedAt: now };
  }
}
