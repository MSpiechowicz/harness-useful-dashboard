<script lang="ts">
  import {
    Activity, Bot, Boxes, Cpu, Database, FileCode, FolderKanban, Gauge, Lightbulb, Menu, MessageSquareText,
    PanelsTopLeft, Settings as SettingsIcon, Sparkles, TrendingUp, Users, Wrench, X, Layers,
  } from "@lucide/svelte";
  import FilterBar from "./components/FilterBar.svelte";
  import LangPicker from "./components/LangPicker.svelte";
  import ThemeToggle from "./components/ThemeToggle.svelte";
  import UpdateBanner from "./components/UpdateBanner.svelte";
  import { network } from "./lib/api.svelte.ts";
  import { relative } from "./lib/format.ts";
  import { t, type MessageKey } from "./lib/i18n.svelte.ts";
  import { live } from "./lib/live.svelte.ts";
  import { store } from "./lib/state.svelte.ts";
  import Breakdown from "./pages/Breakdown.svelte";
  import Cache from "./pages/Cache.svelte";
  import Files from "./pages/Files.svelte";
  import Overview from "./pages/Overview.svelte";
  import PromptDetail from "./pages/PromptDetail.svelte";
  import Prompts from "./pages/Prompts.svelte";
  import SessionDetail from "./pages/SessionDetail.svelte";
  import Sessions from "./pages/Sessions.svelte";
  import Settings from "./pages/Settings.svelte";
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
      { page: "trends", label: "nav.trends", icon: TrendingUp },
    ] },
    { label: "nav.group.analyze", items: [
      { page: "projects", label: "nav.projects", icon: FolderKanban },
      { page: "models", label: "nav.models", icon: Cpu },
      { page: "providers", label: "nav.providers", icon: Boxes },
      { page: "users", label: "nav.users", icon: Users },
      { page: "skills", label: "nav.skills", icon: Sparkles },
      { page: "agents", label: "nav.agents", icon: Bot },
    ] },
    { label: "nav.group.activity", items: [
      { page: "sessions", label: "nav.sessions", icon: Layers },
      { page: "prompts", label: "nav.prompts", icon: MessageSquareText },
      { page: "tools", label: "nav.tools", icon: Wrench },
      { page: "files", label: "nav.files", icon: FileCode },
    ] },
    { label: "nav.group.optimize", items: [
      { page: "cache", label: "nav.cache", icon: Database },
      { page: "tips", label: "nav.tips", icon: Lightbulb },
    ] },
    { label: "nav.group.app", items: [
      { page: "settings", label: "nav.settings", icon: SettingsIcon },
    ] },
  ];

  let menuOpen = $state(false);
  const page = $derived(store.route.page);
  const id = $derived(store.route.id);
  const showFilters = $derived(page !== "settings" && !(page === "sessions" && id) && !(page === "prompts" && id));
  // Re-render relative "updated x ago" text periodically.
  let now = $state(Date.now());
  $effect(() => {
    const h = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(h);
  });

  const ago = $derived.by(() => {
    void now;
    return relative(live.lastScanAt);
  });

  // Show the top progress bar only for loads that take a moment, so quick refreshes don't flicker it.
  let busy = $state(false);
  $effect(() => {
    if (network.inflight === 0) {
      busy = false;
      return;
    }
    const h = setTimeout(() => (busy = true), 150);
    return () => clearTimeout(h);
  });

  function isActive(p: string): boolean {
    return page === p;
  }
</script>

{#if busy}
  <div class="progress-bar" role="progressbar" aria-label={t("common.loading")}></div>
{/if}

<div class="flex min-h-screen">
  <!-- Sidebar -->
  <aside
    class="fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0"
    class:-translate-x-full={!menuOpen}
  >
    <div class="flex h-14 items-center gap-2.5 px-4">
      <img src="/favicon.svg" alt="" class="h-7 w-7 shrink-0" />
      <div class="truncate text-[15px] font-semibold tracking-tight">{t("app.name")}</div>
      <button class="ml-auto lg:hidden" aria-label="Close menu" onclick={() => (menuOpen = false)}><X size={18} /></button>
    </div>
    <nav class="flex-1 overflow-y-auto px-2 py-2">
      {#each groups as g, gi (gi)}
        {#if g.label}<div class="mt-4 mb-1 px-3 text-[11px] font-medium tracking-wide text-muted uppercase">{t(g.label)}</div>{/if}
        {#each g.items as item (item.page)}
          <a
            href="#/{item.page}"
            onclick={() => (menuOpen = false)}
            class="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors {isActive(item.page) ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}"
            aria-current={isActive(item.page) ? "page" : undefined}
          >
            <item.icon size={16} />{t(item.label)}
          </a>
        {/each}
      {/each}
    </nav>
    <!-- Language and theme, then the live status: lined up with the menu's highlight boxes (the nav's px-2). -->
    <div class="flex flex-col gap-3 border-t border-line px-2 py-3">
      <UpdateBanner />
      <div class="flex items-center justify-between gap-2">
        <LangPicker />
        <ThemeToggle />
      </div>
      <div class="flex items-center gap-2 px-1 text-[11px] text-muted" title={live.status?.dbPath}>
        <span class="inline-block h-2 w-2 shrink-0 rounded-full" style:background={live.connected ? "var(--status-good)" : "var(--status-critical)"}></span>
        {#if live.scanning}
          <Gauge size={12} class="animate-pulse" />{t("status.scanning", live.scanning)}
        {:else if live.connected}
          {t("status.lastScan", { ago })}
        {:else}
          {t("status.offline")}
        {/if}
        <span class="ml-auto">v{live.status?.version ?? ""}</span>
      </div>
    </div>
  </aside>
  {#if menuOpen}
    <button class="fixed inset-0 z-30 bg-black/30 lg:hidden" aria-label="Close menu" onclick={() => (menuOpen = false)}></button>
  {/if}

  <!-- Main -->
  <div class="flex min-w-0 flex-1 flex-col">
    <header class="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur" class:lg:hidden={!showFilters}>
      <div class="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-2.5 sm:px-6">
        <button class="btn !px-2 lg:hidden" aria-label="Open menu" onclick={() => (menuOpen = true)}><Menu size={16} /></button>
        {#if showFilters}
          <div class="min-w-0 flex-1"><FilterBar /></div>
        {:else}
          <div class="flex-1"></div>
        {/if}
      </div>
    </header>
    <main class="mx-auto w-full max-w-[1500px] flex-1 px-4 py-6 sm:px-6">
      {#key page + (id ?? "")}
        {#if page === "overview"}<Overview />
        {:else if page === "trends"}<Trends />
        {:else if page === "projects"}<Breakdown dim="project" />
        {:else if page === "models"}<Breakdown dim="model" />
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
        {:else if page === "cache"}<Cache />
        {:else if page === "tips"}<Tips />
        {:else if page === "settings"}<Settings />
        {:else}<Overview />
        {/if}
      {/key}
    </main>
  </div>
</div>
