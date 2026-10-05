import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How much of their plan limits the user has left, from the places that know:
 *  - "claude": Anthropic, asked with the Claude Code login on this machine (what Claude Code's /usage shows).
 *  - "omp": every account omp is logged in to (`omp usage --json`): Claude, ChatGPT/Codex, Copilot, Gemini, …
 *  - "codex": the readings Codex writes into its session logs, stored while ingesting. No network.
 * Credentials never leave this process except to their own provider, and errors carry fixed messages only.
 */

export type LimitSource = "claude" | "omp" | "codex";

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
  constructor(readonly code: LimitProblem["code"]) {
    super(code);
  }
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

export async function claudeLimits(deps: LimitDeps = {}): Promise<LimitReport | null> {
  const d = withDefaults(deps);
  const login = await claudeLogin(d);
  if (!login) return null;
  // Renewing the login would sign Claude Code out (the refresh token rotates), so an expired one is reported instead.
  if (login.expiresAt != null && login.expiresAt <= d.now()) throw new LimitError("expired");
  let res: Response;
  try {
    res = await d.fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${login.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new LimitError("unreachable");
  }
  if (res.status === 401 || res.status === 403) throw new LimitError("unauthorized");
  if (res.status === 429) throw new LimitError("rate-limited");
  if (!res.ok) throw new LimitError("failed");
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new LimitError("failed");
  }
  return { key: "claude:login", provider: "claude", plan: login.plan, account: null, source: "claude", observedAt: d.now(), windows: claudeWindows(body) };
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
 * logs, omp against whatever it billed the call through (Copilot, an Anthropic or ChatGPT login). Cursor reports none.
 */
export function planFor(provider: string, billing: string | null): ActivePlan | null {
  if (provider === "claude") return { provider: "claude", source: "claude" };
  if (provider === "codex") return { provider: "codex", source: "codex" };
  if (provider === "omp" && billing) return { provider: OMP_PROVIDERS[billing] ?? billing, source: "omp" };
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

/** Network sources are asked at most once a minute (failures every 30 seconds), however often the page polls. */
const FRESH_MS = 60_000;
const RETRY_MS = 30_000;

export class LimitsCache {
  private cached = new Map<LimitSource, { at: number; reports: LimitReport[]; problem: LimitProblem | null }>();
  private pending = new Map<LimitSource, Promise<void>>();

  constructor(private deps: LimitDeps = {}) {}

  /** With `active`, only the sources those plans need are asked, and only their reports come back. */
  async get(db: Database, host: string, enabled: Record<LimitSource, boolean>, force = false, active?: ActivePlan[]): Promise<LimitsResult> {
    const now = (this.deps.now ?? Date.now)();
    if (active) enabled = { claude: enabled.claude && active.some((a) => a.source === "claude"), omp: enabled.omp && active.some((a) => a.source === "omp"), codex: enabled.codex && active.some((a) => a.source === "codex") };
    const remote: [LimitSource, () => Promise<LimitReport[]>][] = [
      ["claude", async () => ((r) => (r ? [r] : []))(await claudeLimits(this.deps))],
      ["omp", () => ompLimits(this.deps)],
    ];
    await Promise.all(
      remote
        .filter(([s]) => enabled[s])
        .map(([source, load]) => {
          const c = this.cached.get(source);
          const stale = !c || now - c.at > (c.problem ? RETRY_MS : FRESH_MS) || (force && now - c.at > 10_000);
          if (!stale) return Promise.resolve();
          let p = this.pending.get(source);
          if (!p) {
            p = load()
              .then((reports) => void this.cached.set(source, { at: now, reports, problem: null }))
              .catch((e) => void this.cached.set(source, { at: now, reports: [], problem: { source, code: e instanceof LimitError ? e.code : "failed" } }))
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
      if (!enabled[source] || !c) continue;
      reports.push(...c.reports);
      // omp missing is not a problem worth showing: most people don't use it.
      if (c.problem && c.problem.code !== "not-installed") problems.push(c.problem);
    }
    if (enabled.codex) {
      const codex = codexLimits(db, host, now);
      if (codex) reports.push(codex);
    }
    const shown = active ? reports.filter((r) => active.some((a) => a.provider === r.provider && a.source === r.source)) : reports;
    return { reports: shown, problems, fetchedAt: now };
  }
}
