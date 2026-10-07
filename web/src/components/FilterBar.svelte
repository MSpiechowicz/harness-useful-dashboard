<script lang="ts">
  import { SlidersHorizontal, X } from "@lucide/svelte";
  import { filterParams, qs, useFetch, type FilterOptions } from "../lib/api.svelte.ts";
  import { entityLabel } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { FILTER_KEYS, store, type FilterKey } from "../lib/state.svelte.ts";
  import Dropdown from "./Dropdown.svelte";
  import RangePicker from "./RangePicker.svelte";

  // Options come from the selected time range only, so every value stays selectable.
  const opts = useFetch<FilterOptions>(() => {
    const f = filterParams();
    return `/api/filters${qs({ from: f.from, to: f.to })}`;
  });

  const visible = $derived(
    FILTER_KEYS.filter((k) => {
      const list = opts.data?.[k] ?? [];
      // Hide dimensions with nothing to choose between, unless a value is selected. A single tag or kind is a choice still:
      // the sessions with it and the ones without.
      return store[k] !== "" || list.length > (k === "tag" || k === "kind" ? 0 : 1);
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
  <button class="btn sm:hidden" aria-expanded={expanded} aria-label={t("filter.toggle")} title={t("filter.toggle")} onclick={() => (expanded = !expanded)}>
    <SlidersHorizontal size={14} />
    {#if store.activeFilterCount}<span class="rounded-full bg-accent-fill px-1.5 text-[10px] text-white">{store.activeFilterCount}</span>{/if}
  </button>
  <div class="w-full flex-wrap gap-2 sm:contents {expanded ? 'flex' : 'hidden'}">
  {#each visible as k (k)}
    {@const list = opts.data?.[k] ?? []}
    <!-- All filters share one width, whatever their values: symmetric, and nothing shifts when one is chosen. -->
    <!-- Unfiltered, a filter shows just its name ("Provider"), filtered its value too ("Provider: claude"). -->
    <Dropdown
      prefix
      stretch
      labelWhenEmpty
      label={labelFor(k)}
      value={store[k]}
      active={store[k] !== ""}
      class="max-w-52"
      options={[
        { value: "", label: t("filter.all") },
        ...list.map((o) => ({ value: o.value, label: entityLabel(k, o.value, o.label) })),
        // Keep a selection that has no usage in the current range visible.
        ...(store[k] && !list.some((o) => o.value === store[k]) ? [{ value: store[k], label: store[k] }] : []),
      ]}
      onchange={(v) => store.setFilter(k, v)}
    />
  {/each}
  <!-- Always laid out, only hidden while nothing is filtered: choosing the first filter doesn't squeeze the others. -->
  <button
    class="btn !px-2 text-ink-2"
    class:invisible={store.activeFilterCount === 0}
    tabindex={store.activeFilterCount === 0 ? -1 : undefined}
    aria-hidden={store.activeFilterCount === 0}
    title={t("filter.clear")}
    aria-label={t("filter.clear")}
    onclick={() => store.clearFilters()}
  >
    <X size={14} />
  </button>
  </div>
  <div class="seg ml-auto" role="group" aria-label={t("metric.cost") + " / " + t("metric.tokens")}>
    <button aria-pressed={store.metric === "cost"} onclick={() => store.setMetric("cost")}>{t("metric.cost")}</button>
    <button aria-pressed={store.metric === "tokens"} onclick={() => store.setMetric("tokens")}>{t("metric.tokens")}</button>
  </div>
</div>
