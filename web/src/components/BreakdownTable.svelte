<script lang="ts" module>
  export type BreakdownSortKey = "label" | "cost" | "tokens" | "sessions" | "prompts" | "cacheHitRate" | "lastTs" | "whatIf" | "whatIfChange";
</script>

<script lang="ts">
  import SortTh from "./SortTh.svelte";
  import ValueBar from "./ValueBar.svelte";
  import type { BreakdownRow, WhatIf } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, percent, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { whatIfChange, whatIfTone } from "../lib/whatif.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  interface Props {
    rows: BreakdownRow[];
    dim: string;
    /** Clicking a row applies it as a global filter (when the dimension is filterable). */
    filterKey?: FilterKey;
    compactCols?: boolean;
    /** The page shown: rows from `offset`, at most `limit`, counted after sorting, so paging never changes the order. */
    offset?: number;
    limit?: number;
    /** Sort column and direction; bindable, so a sort control outside the table stays in step with the headers. */
    sortKey?: BreakdownSortKey;
    asc?: boolean;
    /** Models: what each would have cost on the candidate, as two columns at the end (none for a model it has no figure for). */
    whatIf?: WhatIf | null;
  }
  let { rows, dim, filterKey, compactCols = false, offset = 0, limit, sortKey = $bindable(store.metric === "cost" ? "cost" : "tokens"), asc = $bindable(false), whatIf = null }: Props = $props();

  const showWhatIf = $derived(!!whatIf && !compactCols);
  const fixedCols = $derived(dim === "model" && !compactCols);
  const whatIfRows = $derived(new Map((whatIf?.rows ?? []).map((r) => [r.model, r])));
  const whatIfCost = (key: string) => whatIfRows.get(key)?.whatIf ?? null;
  const changeOf = (key: string) => {
    const r = whatIfRows.get(key);
    return r ? whatIfChange(r.actual, r.whatIf) : null;
  };
  const signed = (c: number | null) => (c == null ? "–" : `${c > 0 ? "+" : ""}${percent(c, Math.abs(c) < 0.1 ? 1 : 0)}`);
  // A model without a figure sorts last either way.
  const sortValue = (r: BreakdownRow) => {
    const missing = asc ? Infinity : -Infinity;
    if (sortKey === "whatIf") return whatIfCost(r.key) ?? missing;
    if (sortKey === "whatIfChange") return changeOf(r.key) ?? missing;

    return r[sortKey];
  };

  const sorted = $derived(
    [...rows].sort((a, b) => {
      const x = sortValue(a);
      const y = sortValue(b);
      const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return asc ? r : -r;
    }),
  );
  const visible = $derived(limit == null ? sorted : sorted.slice(offset, offset + limit));
  const maxShare = $derived(Math.max(0.0001, ...rows.map((r) => (store.metric === "cost" ? r.share : r.tokenShare))));

  function sortBy(k: BreakdownSortKey) {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === "label";
    }
  }

  const dir = (k: BreakdownSortKey) => (sortKey === k ? (asc ? "ascending" : "descending") : undefined);
</script>

<!-- The models table keeps its column widths whether or not the comparison is on, and whatever model it is with: picking another changes only the numbers. -->
<table class="data" class:fixed-cols={fixedCols} use:resizableColumns={`breakdown-${dim}${compactCols ? "-compact" : dim === "model" ? "-v2" : ""}`}>
  {#if fixedCols}
    <colgroup>
      <col />
      <col class="w-28" />
      <col class="w-28" />
      <col class="w-44" />
      <col class="w-24" />
      <col class="w-24" />
      <col class="w-24" />
      <col class="w-28" />
      {#if showWhatIf}
        <col class="w-36" />
        <col class="w-28" />
      {/if}
    </colgroup>
  {/if}
  <thead>
    <tr>
      <SortTh label={t("col.name")} sort={dir("label")} onclick={() => sortBy("label")} />
      <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortBy("cost")} />
      <SortTh num label={t("col.tokens")} sort={dir("tokens")} onclick={() => sortBy("tokens")} />
      <th class="num">{t("col.share")}</th>
      {#if !compactCols}
        <SortTh num label={t("col.sessions")} sort={dir("sessions")} onclick={() => sortBy("sessions")} />
        <SortTh num label={t("col.prompts")} sort={dir("prompts")} onclick={() => sortBy("prompts")} />
        <SortTh num label={t("col.cacheHit")} sort={dir("cacheHitRate")} onclick={() => sortBy("cacheHitRate")} />
        <SortTh num label={t("col.lastSeen")} sort={dir("lastTs")} onclick={() => sortBy("lastTs")} />
      {/if}
      {#if showWhatIf}
        <SortTh num label={t("whatif.costIfSwitched")} sort={dir("whatIf")} onclick={() => sortBy("whatIf")} />
        <SortTh num label={t("whatif.change")} sort={dir("whatIfChange")} onclick={() => sortBy("whatIfChange")} />
      {/if}
    </tr>
  </thead>
  <tbody>
    {#each visible as r (r.key)}
      {@const share = store.metric === "cost" ? r.share : r.tokenShare}
      {@const none = r.key === "(none)"}
      <tr class:cursor-pointer={!!filterKey} onclick={() => filterKey && store.setFilter(filterKey, r.key)} title={none && dim === "project" ? t("common.noProjectHint") : r.key}>
        <td class="max-w-72">
          <div class="flex items-center gap-2">
            <!-- "(none)" is an absence, not an entity: an empty dashed marker and an italic label. -->
            {#if none}
              <span class="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-muted"></span>
            {:else}
              <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor(dim, r.key)}></span>
            {/if}
            <!-- Filterable, the name is a button for the keyboard. It has no handler: its click reaches the row's. -->
            {#if filterKey}
              <button type="button" class="truncate text-left" class:italic={none} class:text-ink-2={none}>{entityLabel(dim, r.key, r.label)}</button>
            {:else}
              <span class="truncate" class:italic={none} class:text-ink-2={none}>{entityLabel(dim, r.key, r.label)}</span>
            {/if}
            {#if r.estimated}<span class="rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("common.estimatedHint")}>{t("common.estimated")}</span>{/if}
          </div>
        </td>
        <td class="num font-medium">{usd(r.cost)}</td>
        <td class="num text-ink-2">{compact(r.tokens)}</td>
        <td class="num text-ink-2"><ValueBar label={percent(share, share < 0.1 ? 1 : 0)} fraction={share / maxShare} color={colorFor(dim, r.key)} /></td>
        {#if !compactCols}
          <td class="num text-ink-2">{compact(r.sessions)}</td>
          <td class="num text-ink-2">{compact(r.prompts)}</td>
          <td class="num text-ink-2">{percent(r.cacheHitRate)}</td>
          <td class="num text-muted">{relative(r.lastTs)}</td>
        {/if}
        {#if showWhatIf}
          {@const cost = whatIfCost(r.key)}
          {@const change = changeOf(r.key)}
          {@const tone = whatIfTone(change)}
          <td class="num text-ink-2">{cost != null ? usd(cost) : "–"}</td>
          <td class="num" class:text-bad={tone === "bad"} class:text-good={tone === "good"} class:text-ink-2={tone === "neutral"}>{signed(change)}</td>
        {/if}
      </tr>
    {/each}
  </tbody>
  {#if showWhatIf && whatIf}
    {@const tone = whatIfTone(whatIf.change)}
    <tfoot>
      <tr class="border-t border-line font-medium text-ink">
        <td>{t("common.total")}</td>
        <td class="num">{usd(whatIf.actual)}</td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td></td>
        <td class="num">{usd(whatIf.whatIf)}</td>
        <td class="num" class:text-bad={tone === "bad"} class:text-good={tone === "good"} class:text-ink-2={tone === "neutral"}>{signed(whatIf.change)}</td>
      </tr>
    </tfoot>
  {/if}
</table>
