<script lang="ts">
  import type { BreakdownRow } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, percent, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";

  interface Props {
    rows: BreakdownRow[];
    dim: string;
    /** Clicking a row applies it as a global filter (when the dimension is filterable). */
    filterKey?: FilterKey;
    compactCols?: boolean;
  }
  let { rows, dim, filterKey, compactCols = false }: Props = $props();

  type SortKey = "label" | "cost" | "tokens" | "sessions" | "prompts" | "cacheHitRate" | "lastTs";
  let sortKey = $state<SortKey>(store.metric === "cost" ? "cost" : "tokens");
  let asc = $state(false);

  const sorted = $derived(
    [...rows].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return asc ? r : -r;
    }),
  );
  const maxShare = $derived(Math.max(0.0001, ...rows.map((r) => (store.metric === "cost" ? r.share : r.tokenShare))));

  function sortBy(k: SortKey) {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === "label";
    }
  }

  function arrow(k: SortKey) {
    return sortKey === k ? (asc ? " ↑" : " ↓") : "";
  }
</script>

<table class="data">
  <thead>
    <tr>
      <th><button onclick={() => sortBy("label")}>{t("col.name")}{arrow("label")}</button></th>
      <th class="num"><button onclick={() => sortBy("cost")}>{t("col.cost")}{arrow("cost")}</button></th>
      <th class="num"><button onclick={() => sortBy("tokens")}>{t("col.tokens")}{arrow("tokens")}</button></th>
      <th class="w-40">{t("col.share")}</th>
      {#if !compactCols}
        <th class="num"><button onclick={() => sortBy("sessions")}>{t("col.sessions")}{arrow("sessions")}</button></th>
        <th class="num"><button onclick={() => sortBy("prompts")}>{t("col.prompts")}{arrow("prompts")}</button></th>
        <th class="num"><button onclick={() => sortBy("cacheHitRate")}>{t("col.cacheHit")}{arrow("cacheHitRate")}</button></th>
        <th class="num"><button onclick={() => sortBy("lastTs")}>{t("col.lastSeen")}{arrow("lastTs")}</button></th>
      {/if}
    </tr>
  </thead>
  <tbody>
    {#each sorted as r (r.key)}
      {@const share = store.metric === "cost" ? r.share : r.tokenShare}
      <tr class:cursor-pointer={!!filterKey} onclick={() => filterKey && store.setFilter(filterKey, r.key)} title={r.key}>
        <td class="max-w-72">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor(dim, r.key)}></span>
            <span class="truncate">{r.label}</span>
            {#if r.estimated}<span class="rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("common.estimatedHint")}>{t("common.estimated")}</span>{/if}
          </div>
        </td>
        <td class="num font-medium">{usd(r.cost)}</td>
        <td class="num text-ink-2">{compact(r.tokens)}</td>
        <td>
          <div class="flex items-center gap-2">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div class="h-full rounded-full" style:width="{(share / maxShare) * 100}%" style:background={colorFor(dim, r.key)}></div>
            </div>
            <span class="tabular w-12 text-right text-xs text-ink-2">{percent(share, share < 0.1 ? 1 : 0)}</span>
          </div>
        </td>
        {#if !compactCols}
          <td class="num text-ink-2">{compact(r.sessions)}</td>
          <td class="num text-ink-2">{compact(r.prompts)}</td>
          <td class="num text-ink-2">{percent(r.cacheHitRate)}</td>
          <td class="num text-muted">{relative(r.lastTs)}</td>
        {/if}
      </tr>
    {/each}
  </tbody>
</table>
