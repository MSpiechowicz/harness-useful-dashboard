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

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [page, ...rest] = h.split("/");
  return { page: page || "overview", id: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

function startOfDay(d = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

class Store {
  range = $state<RangePreset>(load("hd.range", ["today", "7d", "30d", "90d", "month", "all", "custom"] as const, "30d"));
  customFrom = $state<string>("");
  customTo = $state<string>("");
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

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", () => {
        this.route = parseHash();
        window.scrollTo({ top: 0 });
      });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => (this.systemDark = e.matches));
    }
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

export function navigate(page: string, id?: string | null): void {
  location.hash = id ? `#/${page}/${encodeURIComponent(id)}` : `#/${page}`;
}
