<script lang="ts">
  import { SlidersHorizontal, X } from "@lucide/svelte";
  import { filterParams, qs, useFetch, type FilterOptions } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { FILTER_KEYS, store, type FilterKey } from "../lib/state.svelte.ts";
  import RangePicker from "./RangePicker.svelte";

  // Options come from the selected time range only, so every value stays selectable.
  const opts = useFetch<FilterOptions>(() => {
    const f = filterParams();
    return `/api/filters${qs({ from: f.from, to: f.to })}`;
  });

  const visible = $derived(
    FILTER_KEYS.filter((k) => {
      const list = opts.data?.[k] ?? [];
      // Hide dimensions with nothing to choose between, unless a value is selected.
      return store[k] !== "" || list.length > 1;
    }),
  );

  // Phones: dimension filters fold behind a toggle so the bar stays one row.
  let expanded = $state(false);

  function labelFor(k: FilterKey): string {
    return t(`filter.${k}` as "filter.provider");
  }
</script>

<div class="flex flex-wrap items-center gap-2">
  <RangePicker />
  <button class="btn sm:hidden" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
    <SlidersHorizontal size={14} />
    {#if store.activeFilterCount}<span class="rounded-full bg-accent px-1.5 text-[10px] text-white">{store.activeFilterCount}</span>{/if}
  </button>
  <div class="w-full flex-wrap gap-2 sm:contents {expanded ? 'flex' : 'hidden'}">
  {#each visible as k (k)}
    <label class="relative">
      <span class="sr-only">{labelFor(k)}</span>
      <select
        class="input max-w-44 cursor-pointer"
        class:!border-accent={store[k] !== ""}
        class:!bg-accent-wash={store[k] !== ""}
        value={store[k]}
        onchange={(e) => store.setFilter(k, (e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">{labelFor(k)}: {t("filter.all")}</option>
        {#each opts.data?.[k] ?? [] as o (o.value)}
          <option value={o.value}>{o.label}</option>
        {/each}
        {#if store[k] && !(opts.data?.[k] ?? []).some((o) => o.value === store[k])}
          <option value={store[k]}>{store[k]}</option>
        {/if}
      </select>
    </label>
  {/each}
  {#if store.activeFilterCount > 0}
    <button class="btn !px-2 text-ink-2" onclick={() => store.clearFilters()}>
      <X size={14} />{t("filter.clear")}
    </button>
  {/if}
  </div>
  <div class="seg ml-auto" role="group" aria-label={t("metric.cost") + " / " + t("metric.tokens")}>
    <button aria-pressed={store.metric === "cost"} onclick={() => store.setMetric("cost")}>{t("metric.cost")}</button>
    <button aria-pressed={store.metric === "tokens"} onclick={() => store.setMetric("tokens")}>{t("metric.tokens")}</button>
  </div>
</div>
