import { type Filters, store } from "./state.svelte.ts";

type QueryValue = string | number | boolean | null | undefined;

export function qs(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function filterParams(f: Filters = store.filters): Record<string, QueryValue> {
  return { ...f };
}

/** Builds an API URL scoped by the global filters. Reading it inside useFetch makes the fetch reactive. */
export function apiUrl(path: string, extra: Record<string, QueryValue> = {}): string {
  return `${path}${qs({ ...filterParams(), ...extra })}`;
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** POST/PUT with the header the server requires for state-changing requests. */
export async function send<T>(path: string, body?: unknown, method = "POST", contentType = "application/json"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "X-Harness-Dashboard": "1", "Content-Type": contentType },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Whether every request has finished its first round, with data or with an error (so a failure can't hang a view). */
export function settled(...fetches: { data: unknown; error: string | null }[]): boolean {
  return fetches.every((f) => f.data != null || f.error != null);
}

/** How many of the requests on screen failed their last attempt, so a view can say so instead of going blank. */
export const apiHealth = $state({ failing: 0, message: null as string | null });

/**
 * Reactive fetch: re-runs when the URL returned by `url()` changes or new data is ingested.
 * Keeps the previous data while reloading so charts hold their frame.
 * Must be created during component initialisation.
 */
export function useFetch<T>(url: () => string | null) {
  let data = $state<T | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let seq = 0;
  let lastUrl: string | null = null;
  let failed = false;

  const setFailed = (v: boolean, message: string | null = null) => {
    if (v !== failed) apiHealth.failing += v ? 1 : -1;
    failed = v;
    if (v) apiHealth.message = message;
  };
  $effect(() => () => setFailed(false));

  $effect(() => {
    const u = url();
    void store.refreshTick;
    if (!u) return;
    const mine = ++seq;
    // Other filters dim what's on screen until the answer comes. A refresh of the same view (new usage came in)
    // swaps the data in place without a flicker.
    if (u !== lastUrl) loading = true;
    lastUrl = u;
    const ctrl = new AbortController();
    getJson<T>(u, ctrl.signal)
      .then((d) => {
        if (mine === seq) {
          data = d;
          error = null;
          setFailed(false);
        }
      })
      .catch((e: Error) => {
        if (mine !== seq || ctrl.signal.aborted) return;
        error = e.message;
        setFailed(true, e.message);
      })
      .finally(() => {
        if (mine === seq) loading = false;
      });
    // Superseded or left: the answer isn't needed any more.
    return () => ctrl.abort();
  });

  return {
    get data() {
      return data;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
  };
}

// ---- API response shapes -------------------------------------------------

export interface Totals {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
  messages: number;
}

export interface Summary extends Totals {
  sessions: number;
  prompts: number;
  estimatedCost: number;
  firstTs: number | null;
  lastTs: number | null;
  activeDays: number;
  cacheHitRate: number;
  costPerPrompt: number;
  previous: (Totals & { sessions: number; prompts: number }) | null;
}

export interface Series {
  key: string;
  name: string;
  data: number[];
}
export interface TimeSeries {
  buckets: string[];
  series: Series[];
  costs?: number[];
}

export interface BreakdownRow extends Totals {
  key: string;
  label: string;
  sessions: number;
  prompts: number;
  firstTs: number;
  lastTs: number;
  estimated: number;
  cacheHitRate: number;
  share: number;
  tokenShare: number;
}
/** Usage by the plan or account it was billed through (/api/billing). */
export interface BillingRow {
  /** The reported plan ("github-copilot", "openai-codex", …), or the harness when it reports none. */
  key: string;
  reported: boolean;
  calls: number;
  tokens: number;
  cost: number;
  premiumRequests: number;
  estimated: boolean;
}

/** One tag's usage (/api/tags): the sessions that carry it, a subagent's included. */
export interface TagRow extends BreakdownRow {
  added: number;
  removed: number;
  changed: number;
  costPer100: number | null;
}

export interface Breakdown {
  total: { tokens: number; cost: number };
  rows: BreakdownRow[];
}

/** Lines the agents' edits added and removed, and the cost per 100 of them (/api/lines). */
export interface LineTotals {
  added: number;
  removed: number;
  changed: number;
  edits: number;
  files: number;
  cost: number;
  costPer100: number | null;
}
export interface LineRow extends LineTotals {
  key: string;
  label: string;
}
export interface Lines {
  total: LineTotals;
  rows: LineRow[];
}
export interface LinesSeries {
  buckets: string[];
  added: number[];
  removed: number[];
  cost: number[];
}

export interface FilterOption {
  value: string;
  label: string;
  n: number;
}
export interface FilterOptions {
  provider: FilterOption[];
  project: FilterOption[];
  user: FilterOption[];
  model: FilterOption[];
  skill: FilterOption[];
  agent: FilterOption[];
  tag: FilterOption[];
  kind: FilterOption[];
  range: { minTs: number | null; maxTs: number | null; rows: number };
}

export interface Tip {
  id: string;
  severity: "info" | "warn" | "critical";
  params: Record<string, string | number | null>;
  link?: string;
  impact: number;
  category: TipCategory;
  key: string;
}

export type TipCategory = "cache" | "context" | "models" | "workflow" | "spend";
export const TIP_CATEGORIES: TipCategory[] = ["cache", "context", "models", "workflow", "spend"];

export interface Status {
  version: string;
  dbPath: string;
  scanning: boolean;
  lastScanAt: number | null;
  identity: { user: string; host: string };
  compiled: boolean;
  platform: string;
  /** "newer-schema" when a newer app upgraded the shared database and this one only reads it. Absent on older servers. */
  readOnly?: "newer-schema" | null;
  /** Schema version of the open database. Absent on older servers. */
  schemaVersion?: number;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  releaseUrl: string | null;
  notes: string | null;
  canSelfUpdate: boolean;
  error?: string;
  disabled?: boolean;
}

export type DriftMetric = "speed" | "ttft" | "toolErrors" | "apiErrors" | "interrupts" | "steps" | "output";
export interface DriftComparison {
  recent: number | null;
  baseline: number | null;
  recentN: number;
  baselineN: number;
  change: number | null;
  status: "stable" | "changed" | "insufficient";
  better: boolean | null;
  band: { lo: number; mid: number; hi: number } | null;
}
export interface Drift {
  window: { baselineFrom: number; recentFrom: number; to: number; recentDays: number; baselineDays: number; minSamples: number };
  models: { model: string; provider: string; responses: number; metrics: Record<DriftMetric, DriftComparison> }[];
  model: string | null;
  effort: string | null;
  efforts: string[];
  days: string[];
  series: { key: DriftMetric; values: (number | null)[]; counts: number[]; comparison: DriftComparison; providers: string[] }[];
  versions: { day: string; label: string }[];
}

/** Chart note from /api/notes. `ts` is epoch ms, `day` is a local "YYYY-MM-DD" for a whole-day note, else null. */
export interface Note {
  id: string;
  ts: number;
  day: string | null;
  text: string;
  createdAt: number;
  updatedAt: number;
}

/** One before or after window of /api/notes/compare. `from` and `to` are epoch ms, rates are 0..1, null when there is no data. */
export interface NoteWindow {
  from: number;
  to: number;
  cost: number;
  prompts: number;
  costPerPrompt: number | null;
  tokensPerPrompt: number | null;
  cacheHitRate: number | null;
  toolErrorRate: number | null;
  apiErrorRate: number | null;
}

/** /api/notes/compare. `clipped` is true when the after window was cut off at now. */
export interface NoteCompare {
  note: Note;
  days: 7 | 14 | 30;
  clipped: boolean;
  before: NoteWindow;
  after: NoteWindow;
}

/** /api/whatif. `change` is the relative difference (whatIf / actual - 1), null when actual is 0. `estimated` marks prices without a list price, `reported` marks costs the providers reported themselves. */
export interface WhatIf {
  candidate: string;
  candidates: { inUse: string[]; priced: string[] };
  actual: number;
  whatIf: number;
  change: number | null;
  estimated: boolean;
  reported: boolean;
  rows: { model: string; tokens: number; actual: number; whatIf: number }[];
}

/** Commit found in an agent transcript. `ts` is epoch ms. `subject` is null unless prompt text is stored, `url` only for known github.com repos. */
export interface GitCommit {
  id: string;
  ts: number;
  branch: string | null;
  sha: string | null;
  subject: string | null;
  project: string | null;
  sessionId: string;
  provider: string;
  url?: string | null;
}

/** Pull request found in an agent transcript. `ts` is epoch ms. */
export interface GitPr {
  id: string;
  ts: number;
  repo: string | null;
  number: number | null;
  url: string | null;
  branch: string | null;
  sessionId: string;
  provider: string;
}

/** Context compaction of a session. `ts` is epoch ms. `estimated` is true when costUsd is derived from tokens. */
export interface Compaction {
  id: string;
  ts: number;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  costUsd: number;
  estimated: boolean;
  model: string | null;
  agent: string;
}
