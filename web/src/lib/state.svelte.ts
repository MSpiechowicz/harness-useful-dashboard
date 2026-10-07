import { tick } from "svelte";

export type RangePreset = "today" | "7d" | "30d" | "90d" | "month" | "all" | "custom";
export type Metric = "tokens" | "cost";
export type ThemePref = "system" | "light" | "dark";
export type FilterKey = "provider" | "project" | "user" | "model" | "skill" | "agent";
export const FILTER_KEYS: FilterKey[] = ["provider", "project", "user", "model", "skill", "agent"];

export interface Filters {
  from?: number;
  to?: number;
  provider?: string;
  project?: string;
  user?: string;
  model?: string;
  skill?: string;
  agent?: string;
}

function load<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage unavailable (private mode, previews) */
  }
  return fallback;
}

function loadDay(key: string): string {
  try {
    const v = localStorage.getItem(key) ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export interface Route {
  page: string;
  id: string | null;
}

/** The route and its query: "#/sessions/<id>?range=custom&from=2026-09-01&provider=claude". */
function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "").split("?")[0]!;
  const [page, ...rest] = h.split("/");
  return { page: page || "overview", id: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

function hashQuery(): URLSearchParams {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : location.hash.slice(i + 1));
}

const RANGES = ["today", "7d", "30d", "90d", "month", "all", "custom"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Where each view was scrolled to, by route: going back to a list returns to the row it was left at. */
const scrolled = new Map<string, number>();
const routeKey = (hash: string) => hash.replace(/^#\/?/, "").split("?")[0] || "overview";

function startOfDay(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

class Store {
  range = $state<RangePreset>(load("hd.range", RANGES, "30d"));
  customFrom = $state<string>(loadDay("hd.customFrom"));
  customTo = $state<string>(loadDay("hd.customTo"));
  provider = $state("");
  project = $state("");
  user = $state("");
  model = $state("");
  skill = $state("");
  agent = $state("");
  metric = $state<Metric>(load("hd.metric", ["tokens", "cost"] as const, "cost"));
  /** Whether project views list the work done outside any project ("No project"). */
  showNoProject = $state<boolean>(load("hd.showNoProject", ["true", "false"] as const, "true") === "true");
  theme = $state<ThemePref>(load("hd.theme", ["system", "light", "dark"] as const, "system"));
  /** Whether the model drift charts mark client updates. */
  showDriftUpdates = $state<boolean>(load("hd.showDriftUpdates", ["true", "false"] as const, "true") === "true");
  /** The sidebar shows only icons (on wide screens, where it stays open). */
  navCollapsed = $state<boolean>(load("hd.navCollapsed", ["true", "false"] as const, "false") === "true");
  systemDark = $state(typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches);
  /** Bumped whenever new data was ingested; data hooks refetch on change. */
  refreshTick = $state(0);
  route = $state<Route>(parseHash());
  /** Where to scroll once the view shows, when it was visited before (see restoreScroll). */
  private pendingScroll: number | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      // The app puts each view back where it was itself: the browser's own restoring would race it.
      history.scrollRestoration = "manual";
      this.applyQuery(hashQuery());
      window.addEventListener("hashchange", (e) => {
        const from = routeKey(new URL(e.oldURL).hash);
        const to = routeKey(location.hash);
        this.applyQuery(hashQuery());
        if (from === to) return; // only the filters changed: stay where you are
        scrolled.set(from, window.scrollY);
        this.route = parseHash();
        this.pendingScroll = scrolled.get(to) ?? null;
        window.scrollTo({ top: 0 });
      });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => (this.systemDark = e.matches));
      // The range and filters live in the address too, so a view can be bookmarked, shared or reloaded as it is.
      // replaceState: changing a filter adds no history entry of its own.
      $effect.root(() => {
        $effect(() => {
          const query = this.query();
          const path = location.hash.replace(/^#\/?/, "").split("?")[0];
          const next = `#/${path}${query ? `?${query}` : ""}`;
          if (next !== location.hash) history.replaceState(history.state, "", next);
        });
      });
    }
  }

  /** The range and filters as a query string, without defaults. */
  query(): string {
    const q = new URLSearchParams();
    if (this.range !== "30d") q.set("range", this.range);
    if (this.range === "custom") {
      if (this.customFrom) q.set("from", this.customFrom);
      if (this.customTo) q.set("to", this.customTo);
    }
    for (const k of FILTER_KEYS) if (this[k]) q.set(k, this[k]);
    return q.toString();
  }

  /** Takes the range and filters from the address. Without a query (an old bookmark, the sign-in redirect), the saved range stays. */
  private applyQuery(q: URLSearchParams): void {
    if (![...q.keys()].length) return;
    const range = q.get("range");
    const from = q.get("from") ?? "";
    const to = q.get("to") ?? "";
    this.range = (RANGES as readonly string[]).includes(range ?? "") ? (range as RangePreset) : "30d";
    if (this.range === "custom") {
      this.customFrom = DAY.test(from) ? from : "";
      this.customTo = DAY.test(to) ? to : "";
    }
    for (const k of FILTER_KEYS) this[k] = q.get(k) ?? "";
  }

  /** Called when a view has its content: back on a list, it scrolls to where it was left. */
  restoreScroll(): void {
    const top = this.pendingScroll;
    this.pendingScroll = null;
    // Once the view's content is in the page, so there is room to scroll to.
    if (top) void tick().then(() => window.scrollTo({ top }));
  }

  get dark(): boolean {
    return this.theme === "dark" || (this.theme === "system" && this.systemDark);
  }

  setTheme(pref: ThemePref): void {
    this.theme = pref;
    save("hd.theme", pref);
    if (pref === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = pref;
  }

  setRange(r: RangePreset): void {
    this.range = r;
    save("hd.range", r);
    // A custom range is kept with its days, so a reload doesn't show "… – …" over all-time data.
    if (r === "custom") {
      save("hd.customFrom", this.customFrom);
      save("hd.customTo", this.customTo);
    }
  }

  setShowDriftUpdates(show: boolean): void {
    this.showDriftUpdates = show;
    save("hd.showDriftUpdates", String(show));
  }

  setNavCollapsed(collapsed: boolean): void {
    this.navCollapsed = collapsed;
    save("hd.navCollapsed", String(collapsed));
  }

  setShowNoProject(show: boolean): void {
    this.showNoProject = show;
    save("hd.showNoProject", String(show));
  }

  setMetric(m: Metric): void {
    this.metric = m;
    save("hd.metric", m);
  }

  setFilter(key: FilterKey, value: string): void {
    this[key] = value;
  }

  clearFilters(): void {
    for (const k of FILTER_KEYS) this[k] = "";
  }

  get activeFilterCount(): number {
    return FILTER_KEYS.filter((k) => this[k]).length;
  }

  get filters(): Filters {
    const f: Filters = {};
    const now = new Date();
    switch (this.range) {
      case "today":
        f.from = startOfDay(now);
        break;
      case "7d":
        f.from = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
        break;
      case "30d":
        f.from = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
        break;
      case "90d":
        f.from = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 89));
        break;
      case "month":
        f.from = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        break;
      case "custom":
        if (this.customFrom) f.from = new Date(this.customFrom + "T00:00:00").getTime();
        if (this.customTo) f.to = new Date(this.customTo + "T00:00:00").getTime() + 86_400_000;
        break;
    }
    for (const k of FILTER_KEYS) if (this[k]) f[k] = this[k];
    return f;
  }

  /** Suggested time bucket for the current range. */
  get bucket(): "hour" | "day" | "week" {
    if (this.range === "today") return "hour";
    const f = this.filters;
    if (f.from == null) return "week";
    const days = ((f.to ?? Date.now()) - f.from) / 86_400_000;
    return days <= 2 ? "hour" : days <= 120 ? "day" : "week";
  }
}

export const store = new Store();

/** Goes to a view, keeping the range and filters. */
export function navigate(page: string, id?: string | null): void {
  location.hash = withQuery(id ? `#/${page}/${encodeURIComponent(id)}` : `#/${page}`);
}

/** A "#/…" route with the current range and filters, unless it brings its own. */
export function withQuery(to: string): string {
  if (to.includes("?")) return to;
  const q = store.query();
  return q ? `${to}?${q}` : to;
}

const kept = new Map<string, Record<string, unknown>>();

/**
 * A list's sort, search and page, kept per view while the app is open: back on the list, it is as it was left.
 * Made during component setup, so it stays with the view it was made on.
 */
export function keeper() {
  const key = routeKey(location.hash);
  return {
    recall<T>(name: string, fallback: T): T {
      return (kept.get(key)?.[name] as T | undefined) ?? fallback;
    },
    remember(values: Record<string, unknown>): void {
      kept.set(key, values);
    },
  };
}
