<script lang="ts">
  import { CheckCheck } from "@lucide/svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import Card from "../components/Card.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import Pager from "../components/Pager.svelte";
  import SearchInput from "../components/SearchInput.svelte";
  import TipCard from "../components/TipCard.svelte";
  import { apiUrl, settled, TIP_CATEGORIES, useFetch, type Tip, type TipCategory } from "../lib/api.svelte.ts";
  import { i18n, t, tMaybe } from "../lib/i18n.svelte.ts";
  import { tipStore, type TipStatus } from "../lib/tips.svelte.ts";

  const tips = useFetch<Tip[]>(() => apiUrl("/api/tips"));

  type Show = TipStatus | "all";
  type Sort = "priority" | "impact" | "category" | "name";
  let show = $state<Show>("active");
  let category = $state<TipCategory | "">("");
  let sort = $state<Sort>("priority");
  let query = $state("");
  const PAGE = 10;
  let page = $state(1);

  const all = $derived(tips.data ?? []);
  const counts = $derived.by(() => {
    const c: Record<Show, number> = { active: 0, read: 0, hidden: 0, all: all.length };
    for (const tip of all) c[tipStore.status(tip)]++;
    return c;
  });
  const SHOWS: Show[] = ["active", "read", "hidden", "all"];

  const CATEGORIES = $derived([{ value: "" as const, label: t("filter.all") }, ...TIP_CATEGORIES.map((c) => ({ value: c, label: t(`tips.cat.${c}` as "tips.cat.cache") }))]);
  const SORTS = $derived((["priority", "impact", "category", "name"] as const).map((value) => ({ value: value as Sort, label: t(`tips.sort.${value}` as "tips.sort.priority") })));

  // Search the words the user reads, in the current language: the title and the text with their numbers filled in.
  const text = (tip: Tip) => `${tMaybe(`tip.${tip.id}.title`, tip.params) ?? tip.id} ${tMaybe(`tip.${tip.id}.body`, tip.params) ?? ""} ${t(`tips.cat.${tip.category}` as "tips.cat.cache")}`;

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((tip) => (show === "all" || tipStore.status(tip) === show) && (!category || tip.category === category) && (!q || text(tip).toLowerCase().includes(q)));
    // The API orders by priority: severity first, then the money at stake.
    const order = new Map(all.map((tip, i) => [tip.key, i]));
    const byPriority = (a: Tip, b: Tip) => order.get(a.key)! - order.get(b.key)!;
    const collator = new Intl.Collator(i18n.locale);
    if (sort === "impact") return list.sort((a, b) => b.impact - a.impact || byPriority(a, b));
    if (sort === "category") return list.sort((a, b) => TIP_CATEGORIES.indexOf(a.category) - TIP_CATEGORIES.indexOf(b.category) || byPriority(a, b));
    if (sort === "name") return list.sort((a, b) => collator.compare(text(a), text(b)));
    return list.sort(byPriority);
  });
  const pageRows = $derived(shown.slice((page - 1) * PAGE, page * PAGE));
  const unread = $derived(shown.filter((tip) => tipStore.status(tip) === "active"));

  // Another view, filter or search starts again on page 1. Marking the last tip of a page read moves back a page.
  $effect(() => {
    void show;
    void category;
    void sort;
    void query;
    page = 1;
  });
  $effect(() => {
    const pages = Math.max(1, Math.ceil(shown.length / PAGE));
    if (page > pages) page = pages;
  });

  const emptyTitle = $derived(
    query.trim() || category ? t("filter.noMatches") : show === "active" ? t("tips.noneActive") : show === "read" ? t("tips.noneRead") : show === "hidden" ? t("tips.noneHidden") : t("tips.none"),
  );
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("tips.title")} subtitle={t("tips.subtitle")}>
    {#if all.length}
      <div class="seg" role="radiogroup" aria-label={t("tips.show")}>
        {#each SHOWS as s (s)}
          <button role="radio" aria-checked={show === s} onclick={() => (show = s)}>
            {t(`tips.show.${s}` as "tips.show.active")} <span class="tabular text-muted">{counts[s]}</span>
          </button>
        {/each}
      </div>
    {/if}
  </PageHeader>
  <ViewGate ready={settled(tips) && tipStore.loaded}>
    {#if all.length === 0}
      <div class="card"><Empty title={t("tips.none")} compact /></div>
    {:else}
      <Card title={t(`tips.list.${show}` as "tips.list.active")} subtitle={t(`tips.listHint.${show}` as "tips.listHint.active")} pad={false}>
        {#snippet actions()}
          <SearchInput bind:value={query} />
          <Dropdown label={t("tips.category")} prefix labelWhenEmpty bind:value={category} options={CATEGORIES} active={!!category} />
          <Dropdown label={t("common.sortBy")} bind:value={sort} options={SORTS} />
          {#if show === "active"}
            <button class="btn" disabled={!unread.length} onclick={() => tipStore.setRead(unread, true)}><CheckCheck size={14} />{t("tips.markAllRead")}</button>
          {/if}
        {/snippet}
        {#if pageRows.length}
          <div class="transition-opacity" class:loading-dim={tips.loading}>
            {#each pageRows as tip (tip.key)}<TipCard {tip} flat />{/each}
          </div>
          <Pager {page} total={shown.length} size={PAGE} onpage={(p) => (page = p)} />
        {:else}
          <Empty compact title={emptyTitle} />
        {/if}
      </Card>
    {/if}
  </ViewGate>
</div>
