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

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
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

  $effect(() => {
    const u = url();
    void store.refreshTick;
    if (!u) return;
    const mine = ++seq;
    loading = true;
    getJson<T>(u)
      .then((d) => {
        if (mine === seq) {
          data = d;
          error = null;
        }
      })
      .catch((e: Error) => {
        if (mine === seq) error = e.message;
      })
      .finally(() => {
        if (mine === seq) loading = false;
      });
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

export interface Breakdown {
  total: { tokens: number; cost: number };
  rows: BreakdownRow[];
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

export type DriftMetric = "speed" | "ttft" | "toolErrors" | "interrupts" | "steps" | "output";
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
