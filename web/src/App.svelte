<script lang="ts">
  import { tick, type Component } from "svelte";
  import Link from "./components/Link.svelte";
  import {
    Activity, Bot, ChartSpline, Boxes, Cpu, Database, FileCode, FolderKanban, Gauge, GitBranch, Lightbulb, Menu, MessageSquareText, OctagonAlert, Timer, Wallet,
    Info, PanelLeftClose, PanelLeftOpen, PanelsTopLeft, Search, Settings as SettingsIcon, Sparkles, Tag, TrendingUp, Users, Wrench, X, Layers,
  } from "@lucide/svelte";
  import FilterBar from "./components/FilterBar.svelte";
  import LangPicker from "./components/LangPicker.svelte";
  import ThemeToggle from "./components/ThemeToggle.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import { time } from "./lib/format.ts";
  import { i18n, t, type MessageKey } from "./lib/i18n.svelte.ts";
  import { send } from "./lib/api.svelte.ts";
  import { live } from "./lib/live.svelte.ts";
  import { isEditable, modKey, shortcutOf } from "./lib/palette-search.ts";
  import { filtersApply, store } from "./lib/state.svelte.ts";

  // Each page is its own file, loaded when first shown, so the first view doesn't wait for all the others.
  type PageComponent = Component<any>;
  const PAGES = {
    overview: () => import("./pages/Overview.svelte"),
    live: () => import("./pages/Live.svelte"),
    trends: () => import("./pages/Trends.svelte"),
    breakdown: () => import("./pages/Breakdown.svelte"),
    branchDetail: () => import("./pages/BranchDetail.svelte"),
    branches: () => import("./pages/Branches.svelte"),
    drift: () => import("./pages/ModelDrift.svelte"),
    sessionDetail: () => import("./pages/SessionDetail.svelte"),
    sessions: () => import("./pages/Sessions.svelte"),
    promptDetail: () => import("./pages/PromptDetail.svelte"),
    prompts: () => import("./pages/Prompts.svelte"),
    tags: () => import("./pages/Tags.svelte"),
    tools: () => import("./pages/Tools.svelte"),
    files: () => import("./pages/Files.svelte"),
    time: () => import("./pages/Time.svelte"),
    friction: () => import("./pages/Friction.svelte"),
    plans: () => import("./pages/Plans.svelte"),
    cache: () => import("./pages/Cache.svelte"),
    tips: () => import("./pages/Tips.svelte"),
    settings: () => import("./pages/Settings.svelte"),
  } satisfies Record<string, () => Promise<{ default: PageComponent }>>;
  type PageName = keyof typeof PAGES;
  /** The pages loaded so far. A page shown before renders at once, without waiting a turn. */
  let loaded = $state.raw<Partial<Record<PageName, PageComponent>>>({});
  function loadPage(name: PageName): Promise<void> {
    if (loaded[name]) return Promise.resolve();
    return PAGES[name]().then((m) => {
      loaded = { ...loaded, [name]: m.default };
    });
  }

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
      { page: "tags", label: "nav.tags", icon: Tag },
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
  const showFilters = $derived(filtersApply(store.route));
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

  // The page the route shows, and what it is given.
  const BREAKDOWNS: Record<string, string> = { projects: "project", models: "model", providers: "provider", users: "user", skills: "skill", agents: "agent" };
  /** Pages that need what the route gives them: they have no address of their own. */
  const NEEDS_ROUTE = new Set<string>(["breakdown", "branchDetail", "sessionDetail", "promptDetail"]);
  const view = $derived.by((): { name: PageName; props?: Record<string, string> } => {
    if (Object.hasOwn(BREAKDOWNS, page)) return { name: "breakdown", props: { dim: BREAKDOWNS[page] } };
    if (id && page === "branches") return { name: "branchDetail", props: { id } };
    if (id && page === "sessions") return { name: "sessionDetail", props: { id } };
    if (id && page === "prompts") return { name: "promptDetail", props: { id } };
    const plain = Object.hasOwn(PAGES, page) && !NEEDS_ROUTE.has(page);
    return { name: plain ? (page as PageName) : "overview" };
  });
  const Page = $derived(loaded[view.name]);
  $effect(() => {
    loadPage(view.name).catch((e) => console.error(e));
  });
  // Once the first page shows, the others load in the background, so moving to one doesn't wait for its file.
  $effect(() => {
    const h = setTimeout(() => {
      for (const name of Object.keys(PAGES) as PageName[]) loadPage(name).catch(() => {});
    }, 3_000);
    return () => clearTimeout(h);
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

  // The command palette (Ctrl+K or Cmd+K): its own file, loaded the first time it opens.
  let Palette = $state.raw<Component<any>>();
  let paletteOpen = $state(false);
  let paletteHelp = $state(false);
  /** Where focus was when the palette opened: it goes back there when it closes. */
  let paletteOpener: HTMLElement | null = null;
  const mod = modKey(navigator.platform || navigator.userAgent);
  const navPages = groups.flatMap((g) => g.items);
  async function openPalette(help = false) {
    paletteOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    paletteHelp = help;
    if (!Palette) Palette = (await import("./components/CommandPalette.svelte")).default;
    paletteOpen = true;
  }
  function closePalette() {
    paletteOpen = false;
    // Opened from the drawer, which closed: back to the button that opens it.
    if (paletteOpener?.closest("[inert]")) openButton?.focus();
    else paletteOpener?.focus();
    paletteOpener = null;
  }
  /** `/` goes to the search box of the page's table, when it has one. */
  function focusTableSearch(): boolean {
    const box = [...(main?.querySelectorAll<HTMLInputElement>("input[type=search]") ?? [])].find((el) => el.offsetParent !== null);
    if (!box) return false;
    box.focus();
    box.select();
    return true;
  }
  function onKey(e: KeyboardEvent) {
    // Shortcuts never take keys that are typed into a field, except Ctrl+K, which has no text to type.
    const shortcut = e.defaultPrevented ? null : shortcutOf(e, isEditable(e.target as HTMLElement | null));
    if (shortcut === "palette") {
      e.preventDefault();
      if (paletteOpen) closePalette();
      else void openPalette();
    } else if (shortcut === "help" && !paletteOpen) {
      e.preventDefault();
      void openPalette(true);
    } else if (shortcut === "search" && !paletteOpen) {
      if (focusTableSearch()) e.preventDefault();
    } else if (e.key === "Escape" && menuOpen && !wide) closeMenu();
  }
</script>

<svelte:window onkeydown={onKey} />

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
    <!-- Search and commands, above the menu: its icon lines up with the menu's (px-2, then px-3 inside). -->
    <div class="px-2 pt-1">
      <button
        type="button"
        class="btn w-full !gap-2.5 !px-3 font-normal text-muted {collapsed ? 'lg:justify-center lg:!px-0' : ''}"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        aria-label={collapsed ? t("palette.open") : undefined}
        title={`${t("palette.key.palette")} (${mod}+K)`}
        onclick={() => {
          if (!wide) menuOpen = false;
          void openPalette();
        }}
      >
        <Search size={16} class="shrink-0" /><span class="truncate" class:lg:hidden={collapsed}>{t("palette.open")}</span>
        <span class="ml-auto flex shrink-0 gap-0.5" class:lg:hidden={collapsed} aria-hidden="true">
          {#each [mod, "K"] as k (k)}<kbd class="inline-flex h-[1.125rem] min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-sans text-[10px] leading-none text-ink-2">{k}</kbd>{/each}
        </span>
      </button>
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
        <!-- Nothing while its file loads: the page's own loading state takes over once it renders. -->
        {#if Page}<Page {...view.props} />{/if}
      {/key}
    </main>
  </div>
</div>

{#if paletteOpen && Palette}
  <Palette pages={navPages} help={paletteHelp} filtersShown={showFilters} onclose={closePalette} />
{/if}
