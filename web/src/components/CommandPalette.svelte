<script lang="ts">
  import { onMount, untrack, type Component } from "svelte";
  import {
    ArrowDownUp, CalendarRange, Coins, CornerDownLeft, Cpu, Eraser, FolderKanban, GitBranch, Keyboard, Languages, Layers, MessageSquareText, Monitor, Moon, RefreshCw, Search,
    Settings as SettingsIcon, Sun, Tag,
  } from "@lucide/svelte";
  import { getJson, qs, send, type FilterOptions } from "../lib/api.svelte.ts";
  import { entityLabel } from "../lib/format.ts";
  import { i18n, LANGS, t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { highlight, modKey, pushRecent, rank, snippet } from "../lib/palette-search.ts";
  import { navigate, store, type FilterKey, type Metric, type RangePreset, type ThemePref } from "../lib/state.svelte.ts";

  /**
   * The command palette (Ctrl+K): go to a page, run an action, or find a session, prompt, branch, project or model.
   * A modal dialog with a combobox: focus stays in the input, the arrow keys move the highlight through the list.
   * Mounted only while open, so every opening starts fresh.
   */
  interface PageEntry {
    page: string;
    label: MessageKey;
    icon: Component<any>;
  }
  interface Props {
    /** The pages of the menu, in its order, with its icons. */
    pages: PageEntry[];
    /** Opens on the list of shortcuts instead of the results. */
    help?: boolean;
    /** Whether the current view shows the filters: choosing a project or model elsewhere goes to the overview. */
    filtersShown: boolean;
    onclose: () => void;
  }
  let { pages, help = false, filtersShown, onclose }: Props = $props();

  type Group = "recent" | "pages" | "actions" | "sessions" | "prompts" | "branches" | "projects" | "models" | "tags";
  const GROUP_LABEL: Record<Group, MessageKey> = {
    recent: "palette.recent",
    pages: "palette.pages",
    actions: "palette.actions",
    sessions: "nav.sessions",
    prompts: "nav.prompts",
    branches: "nav.branches",
    projects: "nav.projects",
    models: "nav.models",
    tags: "nav.tags",
  };
  interface Item {
    id: string;
    group: Group;
    label: string;
    /** Shown after the label, muted (the project of a session, the section of an action). */
    hint?: string;
    icon: Component<any>;
    keywords?: string[];
    run: () => void;
  }

  /** At most this many results of each kind of data. */
  const PER_GROUP = 5;
  const RECENT_KEY = "hd.paletteRecent";
  const mod = modKey(navigator.platform || navigator.userAgent);

  let query = $state("");
  // Where it starts: after that, the palette switches between the two itself.
  let showHelp = $state(untrack(() => help));
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  let dialog = $state<HTMLDivElement>();
  let recent = $state<string[]>(loadRecent());

  function loadRecent(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function remember(id: string) {
    recent = pushRecent(recent, id);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
    } catch {
      /* storage unavailable */
    }
  }

  /** Settings opens at a section: once the page has drawn it, the section's title is scrolled to below the bar. */
  function openSettings(title: string) {
    navigate("settings");
    const until = Date.now() + 4_000;
    const find = () => {
      const h = [...document.querySelectorAll<HTMLElement>("main h2")].find((el) => el.textContent?.trim() === title);
      if (h) {
        const bar = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
        window.scrollTo({ top: h.getBoundingClientRect().top + window.scrollY - bar - 16 });
      } else if (Date.now() < until) setTimeout(find, 100);
    };
    setTimeout(find, 50);
  }

  function setFilter(key: FilterKey, value: string) {
    store.setFilter(key, value);
    if (!filtersShown) navigate("overview");
  }

  // Pages and actions, in the language shown.
  const pageItems = $derived<Item[]>(
    pages.map((p) => ({ id: `page:${p.page}`, group: "pages", label: t(p.label), icon: p.icon, run: () => navigate(p.page) })),
  );
  const actionItems = $derived.by<Item[]>(() => {
    const items: Item[] = [];
    const themeIcons: Record<ThemePref, Component<any>> = { system: Monitor, light: Sun, dark: Moon };
    for (const pref of ["system", "light", "dark"] as ThemePref[]) {
      if (pref === store.theme) continue;
      items.push({ id: `theme:${pref}`, group: "actions", label: `${t("settings.theme")}: ${t(`settings.theme.${pref}`)}`, icon: themeIcons[pref], run: () => store.setTheme(pref) });
    }
    for (const l of LANGS) {
      if (l.code === i18n.lang) continue;
      items.push({ id: `lang:${l.code}`, group: "actions", label: `${t("settings.language")}: ${l.label}`, icon: Languages, run: () => i18n.set(l.code) });
    }
    for (const m of ["cost", "tokens"] as Metric[]) {
      if (m === store.metric) continue;
      items.push({ id: `metric:${m}`, group: "actions", label: `${t("palette.metric")}: ${t(`metric.${m}`)}`, icon: Coins, run: () => store.setMetric(m) });
    }
    for (const r of ["today", "7d", "30d", "90d", "month", "all"] as RangePreset[]) {
      if (r === store.range) continue;
      items.push({ id: `range:${r}`, group: "actions", label: `${t("range.label")}: ${t(`range.${r}`)}`, icon: CalendarRange, run: () => store.setRange(r) });
    }
    if (store.activeFilterCount) items.push({ id: "filters:clear", group: "actions", label: t("filter.clear"), icon: Eraser, run: () => store.clearFilters() });
    items.push({ id: "scan", group: "actions", label: t("settings.rescan"), icon: RefreshCw, run: () => void send("/api/scan").catch((e) => console.error(e)) });
    const sections: MessageKey[] = ["settings.general", "settings.database", "settings.sources", "settings.limits", "settings.budgets", "settings.pricing", "settings.app"];
    for (const s of sections) {
      const title = t(s);
      items.push({ id: `settings:${s}`, group: "actions", label: `${t("nav.settings")}: ${title}`, icon: SettingsIcon, run: () => openSettings(title) });
    }
    items.push({ id: "help", group: "actions", label: t("palette.shortcuts"), icon: Keyboard, run: () => {} });
    return items;
  });

  // Data: sessions and prompts are searched by the server, over all time and without the filters (a palette finds
  // anything). Branches, projects and models come in one list each, the first time a search needs them.
  interface Found {
    sessions: { id: string; title: string | null; projectLabel: string; project: string | null }[];
    prompts: { id: string; text: string | null; sessionTitle: string | null; projectLabel: string; project: string | null }[];
  }
  interface BranchRow {
    id: string;
    branch: string;
    project: string | null;
    projectLabel: string;
  }
  let found = $state.raw<Found>({ sessions: [], prompts: [] });
  let searching = $state(false);
  let lists = $state.raw<{ branches: BranchRow[]; filters: FilterOptions | null } | null>(null);
  let listsLoading: Promise<void> | null = null;
  /** The query the shown data results belong to: older answers are dropped. */
  let foundFor = $state("");

  const dataQuery = $derived(query.trim().length >= 2 ? query.trim() : "");
  $effect(() => {
    const q = dataQuery;
    if (!q) {
      found = { sessions: [], prompts: [] };
      foundFor = "";
      searching = false;
      return;
    }
    searching = true;
    const ctrl = new AbortController();
    const h = setTimeout(() => {
      listsLoading ??= Promise.all([getJson<{ rows: BranchRow[] }>("/api/branches", ctrl.signal), getJson<FilterOptions>("/api/filters", ctrl.signal)])
        .then(([b, f]) => void (lists = { branches: b.rows, filters: f }))
        .catch(() => void (listsLoading = null));
      const params = { q, limit: PER_GROUP, sort: "recent" };
      Promise.all([getJson<{ rows: Found["sessions"] }>(`/api/sessions${qs(params)}`, ctrl.signal), getJson<{ rows: Found["prompts"] }>(`/api/prompts${qs(params)}`, ctrl.signal)])
        .then(([s, p]) => {
          found = { sessions: s.rows, prompts: p.rows };
          foundFor = q;
        })
        .catch(() => {
          /* aborted by a newer query, or the server is away: nothing to add */
        })
        .finally(() => {
          if (!ctrl.signal.aborted) searching = false;
        });
    }, 200);
    // A newer query (or closing) cancels this one, also when its requests are already on the way.
    return () => {
      clearTimeout(h);
      ctrl.abort();
    };
  });

  const dataItems = $derived.by<Item[]>(() => {
    const q = dataQuery;
    if (!q) return [];
    const items: Item[] = [];
    if (foundFor === q) {
      for (const s of found.sessions) {
        const title = s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
        items.push({ id: `session:${s.id}`, group: "sessions", label: title, hint: entityLabel("project", s.project, s.projectLabel), icon: Layers, run: () => navigate("sessions", s.id) });
      }
      for (const p of found.prompts) {
        const text = p.text ?? p.sessionTitle ?? p.id;
        items.push({ id: `prompt:${p.id}`, group: "prompts", label: snippet(text, q), hint: entityLabel("project", p.project, p.projectLabel), icon: MessageSquareText, run: () => navigate("prompts", p.id) });
      }
    }
    if (lists) {
      const branches = lists.branches
        .filter((b) => b.branch !== "(none)")
        .map((b): Item => ({ id: `branch:${b.id}`, group: "branches", label: b.branch, hint: entityLabel("project", b.project, b.projectLabel), icon: GitBranch, run: () => navigate("branches", b.id) }));
      items.push(...rank(branches, q, [], false).slice(0, PER_GROUP));
      const options = (key: "project" | "model" | "tag", group: Group, icon: Component<any>) =>
        (lists!.filters?.[key] ?? [])
          .filter((o) => o.value !== "(none)")
          .map((o): Item => ({ id: `${key}:${o.value}`, group, label: entityLabel(key, o.value, o.label), hint: t("palette.setFilter"), icon, run: () => setFilter(key, o.value) }));
      items.push(...rank(options("project", "projects", FolderKanban), q, [], false).slice(0, PER_GROUP));
      items.push(...rank(options("model", "models", Cpu), q, [], false).slice(0, PER_GROUP));
      items.push(...rank(options("tag", "tags", Tag), q, [], false).slice(0, PER_GROUP));
    }
    return items;
  });

  /** The results in the order shown: each group under its header. */
  const results = $derived.by<Item[]>(() => {
    const q = query.trim();
    const all = [...pageItems, ...actionItems];
    if (!q) {
      const byId = new Map(all.map((i) => [i.id, i]));
      const recents = recent.flatMap((id) => {
        const item = byId.get(id);
        return item ? [{ ...item, group: "recent" as Group }] : [];
      });
      return [...recents, ...pageItems, ...actionItems];
    }
    return [...rank(pageItems, q, recent), ...rank(actionItems, q, recent), ...dataItems];
  });
  const groups = $derived.by(() => {
    const out: { group: Group; items: { item: Item; index: number }[] }[] = [];
    results.forEach((item, index) => {
      const last = out[out.length - 1];
      if (last?.group === item.group) last.items.push({ item, index });
      else out.push({ group: item.group, items: [{ item, index }] });
    });
    return out;
  });

  // A new query starts at the top. The highlight stays within the list as it changes.
  $effect(() => {
    void query;
    active = 0;
  });
  $effect(() => {
    if (active >= results.length) active = Math.max(0, results.length - 1);
  });
  const optionId = (i: number) => `palette-option-${i}`;
  $effect(() => {
    if (showHelp || !results.length) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.id === "help") {
      showHelp = true;
      query = "";
      return;
    }
    if (item.group !== "sessions" && item.group !== "prompts" && item.group !== "branches") remember(item.id);
    onclose();
    item.run();
  }

  function onInputKey(e: KeyboardEvent) {
    if (showHelp && e.key !== "Escape" && e.key !== "Tab") return;
    const last = results.length - 1;
    if (e.key === "ArrowDown") active = active >= last ? 0 : active + 1;
    else if (e.key === "ArrowUp") active = active <= 0 ? last : active - 1;
    // Home and End move the highlight while the input is empty (or with Ctrl), the caret otherwise, as in a text field.
    else if (e.key === "Home" && (!query || e.ctrlKey)) active = 0;
    else if (e.key === "End" && (!query || e.ctrlKey)) active = last;
    else if (e.key === "PageDown") active = Math.min(last, active + 8);
    else if (e.key === "PageUp") active = Math.max(0, active - 8);
    else if (e.key === "Enter") choose(results[active]);
    else return;
    e.preventDefault();
  }

  function onDialogKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Not also the drawer behind it: one Escape closes one thing.
      e.stopPropagation();
      if (showHelp && !help) showHelp = false;
      else onclose();
    } else if (e.key === "Tab") {
      // Focus stays in the dialog: Tab cycles through what can take it.
      const all = [...(dialog?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i >= all.length - 1 ? 0 : i + 1;
      e.preventDefault();
      all[next]!.focus();
    }
  }

  // Typing in the shortcuts list goes back to the results.
  $effect(() => {
    if (query && showHelp) showHelp = false;
  });

  onMount(() => {
    input?.focus();
    // The page behind doesn't scroll while the palette is open.
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = overflow;
    };
  });

  const SHORTCUTS: { keys: string[]; label: MessageKey }[] = [
    { keys: [mod, "K"], label: "palette.key.palette" },
    { keys: ["/"], label: "palette.key.search" },
    { keys: ["?"], label: "palette.key.help" },
    { keys: ["↑", "↓"], label: "palette.key.move" },
    { keys: ["Enter"], label: "palette.key.choose" },
    { keys: ["Esc"], label: "palette.key.close" },
  ];

  const listId = "palette-list";
  const expanded = $derived(!showHelp && results.length > 0);
</script>

<!-- The backdrop is for the pointer: keyboard users close with Escape. -->
<div
  class="palette-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    bind:this={dialog}
    class="palette card flex max-h-[min(34rem,76vh)] w-full max-w-xl flex-col overflow-hidden !shadow-[var(--shadow-pop)]"
    role="dialog"
    aria-modal="true"
    aria-label={t("palette.label")}
    tabindex="-1"
    onkeydown={onDialogKey}
  >
    <div class="flex items-center gap-2 border-b border-line px-4">
      <Search size={16} class="shrink-0 text-muted" />
      <input
        bind:this={input}
        bind:value={query}
        class="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded ? optionId(active) : undefined}
        aria-label={t("palette.label")}
        placeholder={t("palette.placeholder")}
        autocomplete="off"
        spellcheck="false"
        onkeydown={onInputKey}
      />
      {#if searching}<span class="shrink-0 text-xs text-muted" aria-live="polite">{t("palette.searching")}</span>{/if}
    </div>

    {#if showHelp}
      <div class="overflow-y-auto px-2 py-2">
        <div class="palette-group">{t("palette.shortcuts")}</div>
        <dl class="px-2.5">
          {#each SHORTCUTS as s (s.label)}
            <div class="flex items-center justify-between gap-4 py-1.5 text-[13px]">
              <dt class="text-ink-2">{t(s.label)}</dt>
              <dd class="flex shrink-0 gap-1">{#each s.keys as k (k)}<kbd class="kbd">{k}</kbd>{/each}</dd>
            </div>
          {/each}
        </dl>
      </div>
    {/if}
    <!-- Always in the page, so the input's aria-controls points at something. Hidden behind the shortcuts list. -->
    <div id={listId} class="overflow-y-auto px-2 py-2" class:hidden={showHelp} role="listbox" aria-label={t("palette.label")}>
      {#each groups as g, gi (g.group + gi)}
        <div role="group" aria-labelledby="palette-group-{gi}" class={gi ? "mt-1 border-t border-line pt-1" : ""}>
          <div id="palette-group-{gi}" class="palette-group" role="presentation">{t(GROUP_LABEL[g.group])}</div>
          {#each g.items as { item, index } (item.id)}
            <!-- Options aren't focused (the input keeps focus and points at the highlighted one, a click doesn't take it), so no key handler here. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              tabindex="-1"
              class="palette-option"
              onmousedown={(e) => e.preventDefault()}
              onmousemove={() => (active = index)}
              onclick={() => choose(item)}
            >
              <item.icon size={15} class="shrink-0 {index === active ? 'text-accent' : 'text-muted'}" />
              <span class="min-w-0 truncate">
                {#each highlight(item.label, query) as part, pi (pi)}{#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}
              </span>
              {#if item.hint}<span class="ml-auto shrink-0 truncate pl-2 text-xs text-muted">{item.hint}</span>{/if}
              {#if index === active}<CornerDownLeft size={13} class="shrink-0 text-muted {item.hint ? '' : 'ml-auto'}" />{/if}
            </div>
          {/each}
        </div>
      {:else}
        <div class="px-2.5 py-6 text-center text-xs text-muted">{searching ? t("palette.searching") : t("filter.noMatches")}</div>
      {/each}
    </div>

    <div class="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
      <span class="flex items-center gap-1"><kbd class="kbd"><ArrowDownUp size={10} /></kbd>{t("palette.foot.move")}</span>
      <span class="flex items-center gap-1"><kbd class="kbd"><CornerDownLeft size={10} /></kbd>{t("palette.foot.open")}</span>
      <span class="flex items-center gap-1"><kbd class="kbd">Esc</kbd>{t("palette.key.close")}</span>
      <button type="button" class="ml-auto flex items-center gap-1 rounded hover:text-ink" aria-pressed={showHelp} onclick={() => (showHelp = !showHelp)}>
        <kbd class="kbd">?</kbd>{t("palette.shortcuts")}
      </button>
    </div>
  </div>
</div>

<style>
  .palette-backdrop {
    animation: palette-fade 0.12s ease-out;
  }
  .palette {
    animation: palette-in 0.14s ease-out;
  }
  @keyframes palette-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes palette-in {
    from {
      opacity: 0;
      transform: scale(0.98) translateY(-4px);
    }
  }
  .palette-group {
    padding: 0.375rem 0.625rem 0.25rem;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.025em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .palette-option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    height: 2rem;
    padding: 0 0.625rem;
    border-radius: 6px;
    font-size: 0.8125rem;
    color: var(--ink-2);
    cursor: pointer;
  }
  .palette-option[aria-selected="true"] {
    background: var(--accent-wash);
    color: var(--ink);
  }
  .palette-option mark {
    background: none;
    color: var(--accent-ink);
    font-weight: 600;
  }
  .kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.125rem;
    padding: 0 0.25rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-family: inherit;
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
    color: var(--ink-2);
  }
</style>
