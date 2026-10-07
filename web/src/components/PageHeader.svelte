<script lang="ts">
  import type { Snippet } from "svelte";
  import { dayWithYear, entityLabel } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { FILTER_KEYS, filtersApply, store } from "../lib/state.svelte.ts";
  let { title, subtitle, children }: { title: string; subtitle?: string; children?: Snippet } = $props();

  // On paper the filter bar is gone: a line under the title says what the page shows, with the range's days.
  const scope = $derived.by(() => {
    if (!filtersApply(store.route)) return "";
    const f = store.filters;
    const last = f.to != null ? f.to - 86_400_000 : Date.now();
    const days = f.from == null ? "" : dayWithYear(f.from) === dayWithYear(last) ? dayWithYear(last) : `${dayWithYear(f.from)} – ${dayWithYear(last)}`;
    const range = store.range === "custom" && days ? days : days ? `${t(`range.${store.range}` as "range.7d")}, ${days}` : t(`range.${store.range}` as "range.7d");
    const filters = FILTER_KEYS.filter((k) => store[k]).map((k) => `${t(`filter.${k}` as "filter.provider")}: ${entityLabel(k, store[k], store[k])}`);
    return [range, ...filters, t(`metric.${store.metric}`)].join(" · ");
  });
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
  <div class="min-w-0">
    <h1 class="text-xl font-semibold tracking-tight text-ink">{title}</h1>
    {#if subtitle}<p class="mt-0.5 text-sm text-muted">{subtitle}</p>{/if}
    {#if scope}<p class="print-only mt-1 text-xs text-ink-2">{scope}</p>{/if}
  </div>
  {#if children}<div class="flex items-center gap-2">{@render children()}</div>{/if}
</div>
