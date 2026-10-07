<script lang="ts">
  import { tick } from "svelte";
  import Link from "./components/Link.svelte";
  import {
    Activity, Bot, ChartSpline, Boxes, Cpu, Database, FileCode, FolderKanban, Gauge, GitBranch, Lightbulb, Menu, MessageSquareText, OctagonAlert, Timer, Wallet,
    Info, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Settings as SettingsIcon, Sparkles, TrendingUp, Users, Wrench, X, Layers,
  } from "@lucide/svelte";
  import FilterBar from "./components/FilterBar.svelte";
  import LangPicker from "./components/LangPicker.svelte";
  import ThemeToggle from "./components/ThemeToggle.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import { time } from "./lib/format.ts";
  import { i18n, t, type MessageKey } from "./lib/i18n.svelte.ts";
  import { send } from "./lib/api.svelte.ts";
  import { live } from "./lib/live.svelte.ts";
  import { store } from "./lib/state.svelte.ts";
  import BranchDetail from "./pages/BranchDetail.svelte";
  import Branches from "./pages/Branches.svelte";
  import Breakdown from "./pages/Breakdown.svelte";
  import Cache from "./pages/Cache.svelte";
  import Files from "./pages/Files.svelte";
  import Friction from "./pages/Friction.svelte";
  import Live from "./pages/Live.svelte";
  import ModelDrift from "./pages/ModelDrift.svelte";
  import Overview from "./pages/Overview.svelte";
  import Plans from "./pages/Plans.svelte";
  import PromptDetail from "./pages/PromptDetail.svelte";
  import Prompts from "./pages/Prompts.svelte";
  import SessionDetail from "./pages/SessionDetail.svelte";
  import Sessions from "./pages/Sessions.svelte";
  import Settings from "./pages/Settings.svelte";
  import Time from "./pages/Time.svelte";
  import Tips from "./pages/Tips.svelte";
  import Tools from "./pages/Tools.svelte";
  import Trends from "./pages/Trends.svelte";

  interface NavItem {
    page: string;
    label: MessageKey;
    icon: typeof Activity;
  }
  const groups: { label: MessageKey | null; items: NavItem[] }[] = [
    { label: null, items: [
      { page: "overview", label: "nav.overview", icon: PanelsTopLeft },
      { page: "live", label: "nav.live", icon: Activity },
      { page: "trends", label: "nav.trends", icon: TrendingUp },
    ] },
    { label: "nav.group.analyze", items: [
      { page: "projects", label: "nav.projects", icon: FolderKanban },
      { page: "branches", label: "nav.branches", icon: GitBranch },
      { page: "models", label: "nav.models", icon: Cpu },
      { page: "drift", label: "nav.drift", icon: ChartSpline },
      { page: "providers", label: "nav.providers", icon: Boxes },
      { page: "users", label: "nav.users", icon: Users },
      { page: "skills", label: "nav.skills", icon: Sparkles },
      { page: "agents", label: "nav.agents", icon: Bot },
    ] },
    { label: "nav.group.activity", items: [
      { page: "sessions", label: "nav.sessions", icon: Layers },
      { page: "prompts", label: "nav.prompts", icon: MessageSquareText },
      { page: "time", label: "nav.time", icon: Timer },
      { page: "tools", label: "nav.tools", icon: Wrench },
      { page: "files", label: "nav.files", icon: FileCode },
    ] },
    { label: "nav.group.optimize", items: [
      { page: "plans", label: "nav.plans", icon: Wallet },
      { page: "friction", label: "nav.friction", icon: OctagonAlert },
      { page: "cache", label: "nav.cache", icon: Database },
      { page: "tips", label: "nav.tips", icon: Lightbulb },
    ] },
    { label: "nav.group.app", items: [
      { page: "settings", label: "nav.settings", icon: SettingsIcon },
    ] },
  ];

  let menuOpen = $state(false);
  // Collapsed, the sidebar keeps only the icons. It applies on wide screens: on small ones the menu is a drawer.
  const collapsed = $derived(store.navCollapsed);
  const page = $derived(store.route.page);
  const id = $derived(store.route.id);
  // Live shows the last minutes as they happen: the range and filters don't apply to it.
  /** Why a page has no filters, shown where they would be. */
  const noFiltersNote = $derived<MessageKey>(
    page === "live" ? "filters.none.live" : page === "settings" ? "filters.none.settings" : page === "prompts" ? "filters.none.prompt" : page === "branches" ? "filters.none.branch" : "filters.none.session",
  );
  const showFilters = $derived(page !== "settings" && page !== "live" && !(page === "sessions" && id) && !(page === "prompts" && id) && !(page === "branches" && id));
  // Desktop alerts come from the server: it writes them in the language the UI shows.
  $effect(() => {
    const language = i18n.lang;
    send("/api/language", { language }).catch(() => {});
  });

  // For the Live menu icon below. A minute is precise enough.
  let now = $state(Date.now());
  $effect(() => {
    const h = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(h);
  });

  // When the data on screen was loaded. A clock time, so it changes only when the page reloads, at most once a minute.
  const updated = $derived(live.updatedAt ? t("status.updatedAt", { time: time(live.updatedAt) }) : "");

  // Background scans take a moment and need no notice. Only one that runs longer, such as the first, shows its progress.
  let longScan = $state(false);
  const scanning = $derived(live.scanning !== null);
  $effect(() => {
    if (!scanning) {
      longScan = false;
      return;
    }
    const h = setTimeout(() => (longScan = true), 3_000);
    return () => clearTimeout(h);
  });

  // New usage came in during the last few minutes: the Live menu icon animates.
  const receiving = $derived(live.connected && live.lastDataAt !== null && now - live.lastDataAt < 3 * 60_000);

  function isActive(p: string): boolean {
    return page === p;
  }

  // Below lg the sidebar is a drawer. Closed, it is only moved off screen: inert keeps its links out of the tab order.
  const wideQuery = matchMedia("(min-width: 64rem)");
  let wide = $state(wideQuery.matches);
  $effect(() => {
    const onChange = (e: MediaQueryListEvent) => (wide = e.matches);
    wideQuery.addEventListener("change", onChange);
    return () => wideQuery.removeEventListener("change", onChange);
  });
  let openButton = $state<HTMLButtonElement>();
  let closeButton = $state<HTMLButtonElement>();
  function openMenu() {
    menuOpen = true;
    // After the drawer stops being inert, or it can't take focus.
    tick().then(() => closeButton?.focus());
  }
  function closeMenu() {
    menuOpen = false;
    openButton?.focus();
  }

  // The tab title names the view, e.g. "Models · Harness Dashboard".
  const pageLabel = $derived(groups.flatMap((g) => g.items).find((i) => i.page === page)?.label);
  $effect(() => {
    document.title = pageLabel ? `${t(pageLabel)} · ${t("app.name")}` : t("app.name");
  });

  // After moving to another view, focus goes to its heading (or the content, while it has none), so a screen reader
  // announces the new view and Tab continues from there. Not on the first load, and without scrolling: the page is
  // already at the top.
  let main = $state<HTMLElement>();
  let firstRoute = true;
  $effect(() => {
    void page;
    void id;
    if (firstRoute) {
      firstRoute = false;
      return;
    }
    tick().then(() => focusContent(true));
  });
  function focusContent(heading: boolean) {
    const h = heading ? main?.querySelector<HTMLElement>("h1") : null;
    const target = h ?? main;
    if (!target) return;
    if (h) h.tabIndex = -1;
    target.focus({ preventScroll: true });
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape" && menuOpen && !wide) closeMenu();
  }}
/>

<button type="button" class="skip-link" onclick={() => focusContent(false)}>{t("nav.skip")}</button>

<div class="flex min-h-screen">
  <!-- Sidebar -->
  <aside
    class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-[translate,width] duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 {collapsed ? 'lg:w-16' : ''}"
    class:-translate-x-full={!menuOpen}
    inert={!menuOpen && !wide}
  >
    <div class="flex h-14 items-center gap-2.5 px-4 {collapsed ? 'lg:justify-center lg:px-0' : ''}">
      <img src="/favicon.svg" alt="" class="h-7 w-7 shrink-0" />
      <div class="truncate text-[15px] font-semibold tracking-tight" class:lg:hidden={collapsed}>{t("app.name")}</div>
      <button bind:this={closeButton} class="ml-auto lg:hidden" aria-label={t("nav.closeMenu")} title={t("nav.closeMenu")} onclick={closeMenu}><X size={18} /></button>
    </div>
    <nav class="flex-1 overflow-y-auto px-2 py-2" aria-label={t("nav.label")}>
      {#each groups as g, gi (gi)}
        {#if g.label}
          <div class="mt-3 mb-1 h-4 px-3 text-[11px] leading-4 font-medium tracking-wide text-muted uppercase" class:lg:hidden={collapsed}>{t(g.label)}</div>
          <!-- Collapsed, a rule takes the place of the group's name, at the same height (12 + 16 + 4). -->
          {#if collapsed}<div class="mx-3 hidden h-8 items-center lg:flex"><div class="h-px w-full bg-line"></div></div>{/if}
        {/if}
        {#each g.items as item (item.page)}
          <Link
            to="#/{item.page}"
            onclick={() => (menuOpen = false)}
            class="flex h-7 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors {collapsed ? 'lg:justify-center lg:px-0' : ''} {isActive(item.page) ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}"
            aria-current={isActive(item.page) ? "page" : undefined}
            aria-label={collapsed ? t(item.label) : undefined}
            title={collapsed ? t(item.label) : undefined}
          >
            <item.icon size={16} class="shrink-0 {item.page === 'live' && receiving ? 'live-trace' : ''}" /><span class="truncate" class:lg:hidden={collapsed}>{t(item.label)}</span>
          </Link>
        {/each}
      {/each}
      <!-- The last menu item, under Settings: collapse to icons, or expand again. Wide screens only: small ones use the drawer. -->
      <button
        type="button"
        class="hidden h-7 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink lg:flex {collapsed ? 'lg:justify-center lg:px-0' : ''}"
        aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
        title={collapsed ? t("nav.expand") : t("nav.collapse")}
        aria-expanded={!collapsed}
        onclick={() => store.setNavCollapsed(!collapsed)}
      >
        {#if collapsed}<PanelLeftOpen size={16} class="shrink-0" />{:else}<PanelLeftClose size={16} class="shrink-0" /><span class="truncate">{t("nav.collapse")}</span>{/if}
      </button>
    </nav>
    <!-- Language and theme, then the live status: lined up with the menu's highlight boxes (the nav's px-2). -->
    <div class="flex flex-col gap-3 border-t border-line px-2 py-3">
      <div class="flex flex-col gap-3" class:lg:hidden={collapsed}>
        <UpdateBanner />
        <div class="flex items-center justify-between gap-2">
          <LangPicker up />
          <ThemeToggle />
        </div>
      </div>
      <!-- A fixed height: the scanning icon must not grow the footer, which would push the menu above it. -->
      <div class="flex h-4 items-center gap-2 px-1 text-[11px] text-muted {collapsed ? 'lg:justify-center' : ''}" title={collapsed ? `${live.connected ? updated : t("status.offline")} · v${live.status?.version ?? ""}` : live.status?.dbPath}>
        <!-- Connected, the dot pulses: the dashboard keeps updating on its own. Offline it stays still and red. -->
        <span class="relative flex size-2 shrink-0">
          {#if live.connected}<span class="absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden" style:background="var(--status-good)"></span>{/if}
          <span class="relative inline-flex size-2 rounded-full" style:background={live.connected ? "var(--status-good)" : "var(--status-critical)"}></span>
        </span>
        <span class="flex min-w-0 flex-1 items-center gap-2" class:lg:hidden={collapsed}>
          <span class="flex min-w-0 items-center gap-1 truncate" title={live.connected ? updated : undefined}>
          {#if live.scanning && longScan}
            <Gauge size={12} class="animate-pulse" />{t("status.scanning", live.scanning)}
          {:else if live.connected}
            {updated}
          {:else}
            {t("status.offline")}
          {/if}
          </span>
          <span class="ml-auto shrink-0">v{live.status?.version ?? ""}</span>
        </span>
      </div>
    </div>
  </aside>
  {#if menuOpen}
    <!-- The backdrop is for the pointer: keyboard users have the close button and Escape. -->
    <button class="fixed inset-0 z-30 bg-black/30 lg:hidden" tabindex="-1" aria-hidden="true" onclick={closeMenu}></button>
  {/if}

  <!-- Main -->
  <div class="flex min-w-0 flex-1 flex-col">
    <!-- On every page, so content starts at the same height. Where the filters don't apply it is an empty row. -->
    <header class="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur">
      <!-- Top-aligned: when the filters wrap onto more lines, the menu button stays level with the first one. -->
      <div class="mx-auto flex max-w-[1500px] items-start gap-3 px-4 py-2.5 sm:px-6">
        <button bind:this={openButton} class="btn shrink-0 !px-2 lg:hidden" aria-label={t("nav.openMenu")} aria-expanded={menuOpen} title={t("nav.openMenu")} onclick={openMenu}><Menu size={16} /></button>
        {#if showFilters}
          <div class="min-w-0 flex-1"><FilterBar /></div>
        {:else}
          <!-- As tall as a row of controls (2rem), so the bar keeps its height, with why there are no filters here. -->
          <div class="flex h-8 min-w-0 flex-1 items-center gap-1.5 text-xs text-muted">
            <Info size={14} class="shrink-0" /><span class="truncate" title={t(noFiltersNote)}>{t(noFiltersNote)}</span>
          </div>
        {/if}
      </div>
    </header>
    <main bind:this={main} tabindex="-1" class="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 outline-none sm:px-6">
      {#key page + (id ?? "")}
        {#if page === "overview"}<Overview />
        {:else if page === "live"}<Live />
        {:else if page === "trends"}<Trends />
        {:else if page === "projects"}<Breakdown dim="project" />
        {:else if page === "branches" && id}<BranchDetail {id} />
        {:else if page === "branches"}<Branches />
        {:else if page === "models"}<Breakdown dim="model" />
        {:else if page === "drift"}<ModelDrift />
        {:else if page === "providers"}<Breakdown dim="provider" />
        {:else if page === "users"}<Breakdown dim="user" />
        {:else if page === "skills"}<Breakdown dim="skill" />
        {:else if page === "agents"}<Breakdown dim="agent" />
        {:else if page === "sessions" && id}<SessionDetail {id} />
        {:else if page === "sessions"}<Sessions />
        {:else if page === "prompts" && id}<PromptDetail {id} />
        {:else if page === "prompts"}<Prompts />
        {:else if page === "tools"}<Tools />
        {:else if page === "files"}<Files />
        {:else if page === "time"}<Time />
        {:else if page === "friction"}<Friction />
        {:else if page === "plans"}<Plans />
        {:else if page === "cache"}<Cache />
        {:else if page === "tips"}<Tips />
        {:else if page === "settings"}<Settings />
        {:else}<Overview />
        {/if}
      {/key}
    </main>
  </div>
</div>
