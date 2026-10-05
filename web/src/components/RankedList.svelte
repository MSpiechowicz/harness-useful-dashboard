<script lang="ts">
  import type { BreakdownRow } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, metricValue, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";

  interface Props {
    rows: BreakdownRow[];
    dim: string;
    limit?: number;
    /** Clicking a row applies it as a global filter. */
    filterKey: FilterKey;
    loading?: boolean;
  }
  let { rows, dim, limit = 8, filterKey, loading = false }: Props = $props();

  const shown = $derived(rows.slice(0, limit));
  const value = (r: BreakdownRow) => (store.metric === "cost" ? r.cost : r.tokens);
  // Bars are scaled to the leader so small differences stay visible; the share column carries the absolute part.
  const max = $derived(Math.max(1e-9, ...shown.map(value)));
</script>

<ul class="-mx-2 flex flex-col transition-opacity" class:loading-dim={loading}>
  {#each shown as r (r.key)}
    {@const share = store.metric === "cost" ? r.share : r.tokenShare}
    {@const name = entityLabel(dim, r.key, r.label)}
    {@const none = r.key === "(none)"}
    <li>
      <button
        type="button"
        class="group grid w-full grid-cols-[minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 text-left hover:bg-surface-2"
        title="{none && dim === 'project' ? `${t('common.noProjectHint')} · ` : ''}{name} · {usd(r.cost)} · {compact(r.tokens)} {t('metric.tokens')}"
        onclick={() => store.setFilter(filterKey, r.key)}
      >
        <span class="truncate text-[13px] text-ink-2 group-hover:text-ink" class:italic={none}>{name}</span>
        <span class="tabular text-right text-[13px] font-medium text-ink">{metricValue(value(r), store.metric)}</span>
        <span class="tabular text-right text-xs text-muted">{percent(share, share < 0.1 ? 1 : 0)}</span>
        <span class="col-span-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
          <span class="block h-full rounded-full" style:width="{Math.max(0.5, (value(r) / max) * 100)}%" style:background={colorFor(dim, r.key)}></span>
        </span>
      </button>
    </li>
  {/each}
</ul>
