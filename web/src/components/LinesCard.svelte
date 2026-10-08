<script lang="ts">
  import SortTh from "./SortTh.svelte";
  import TableCard from "./TableCard.svelte";
  import ValueBar from "./ValueBar.svelte";
  import { apiUrl, useFetch, type LineRow, type Lines } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  /**
   * What the spend bought, split by project, model or provider: the lines each one's edits added and removed, and its
   * cost per 100 of them. On Models it answers which model changes code for the least.
   */
  let { dim }: { dim: "project" | "model" | "provider" } = $props();

  const data = useFetch<Lines>(() => apiUrl("/api/lines", { dim }));
  const rows = $derived((data.data?.rows ?? []).filter((r) => dim !== "project" || store.showNoProject || r.key !== "(none)"));

  type Sort = "changed" | "added" | "removed" | "cost" | "costPer100" | "label";
  let sortKey = $state<Sort>("changed");
  let asc = $state(false);
  const SORTS = $derived<{ value: Sort; label: string; asc?: boolean }[]>([
    { value: "changed", label: t("col.changed") },
    { value: "added", label: t("col.added") },
    { value: "removed", label: t("col.removed") },
    { value: "cost", label: t("col.cost") },
    { value: "costPer100", label: t("col.per100"), asc: true },
    { value: "label", label: t("col.name"), asc: true },
  ]);
  // Without lines a row has no cost per line: it sorts last either way.
  const value = (r: LineRow) => (sortKey === "costPer100" ? (r.costPer100 ?? (asc ? Infinity : -Infinity)) : r[sortKey]);
  const sorted = $derived(
    [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return asc ? r : -r;
    }),
  );
  const maxChanged = $derived(Math.max(1, ...rows.map((r) => r.changed)));
  function sortBy(k: Sort) {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === "label" || k === "costPer100";
    }
  }
  const dir = (k: Sort) => (sortKey === k ? (asc ? "ascending" : "descending") : undefined);
  const signed = (n: number, sign: string) => (n ? `${sign}${compact(n)}` : "0");
</script>

{#if rows.length}
  <TableCard
    title={t("lines.title")}
    subtitle={t("lines.subtitle")}
    rows={sorted}
    searchText={(r) => `${entityLabel(dim, r.key, r.label)} ${r.key}`}
    sorts={SORTS}
    bind:sortKey
    bind:asc
    loading={data.loading}
    exportName={`${dim}-lines`}
  >
    {#snippet children(view)}
      <table class="data" use:resizableColumns={`lines-${dim}`}>
        <thead>
          <tr>
            <SortTh label={t("col.name")} sort={dir("label")} onclick={() => sortBy("label")} />
            <SortTh num label={t("col.added")} sort={dir("added")} onclick={() => sortBy("added")} />
            <SortTh num label={t("col.removed")} sort={dir("removed")} onclick={() => sortBy("removed")} />
            <SortTh num label={t("col.changed")} sort={dir("changed")} onclick={() => sortBy("changed")} />
            <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortBy("cost")} />
            <SortTh num label={t("col.per100")} sort={dir("costPer100")} onclick={() => sortBy("costPer100")} />
          </tr>
        </thead>
        <tbody>
          {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as r (r.key)}
            {@const none = r.key === "(none)"}
            <tr class="cursor-pointer" onclick={() => store.setFilter(dim as FilterKey, r.key)} title={r.key}>
              <td class="max-w-72">
                <div class="flex items-center gap-2">
                  {#if none}
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-muted"></span>
                  {:else}
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor(dim, r.key)}></span>
                  {/if}
                  <!-- A button for the keyboard, without a handler: its click reaches the row's. -->
                  <button type="button" class="truncate text-left" class:italic={none} class:text-ink-2={none}>{entityLabel(dim, r.key, r.label)}</button>
                </div>
              </td>
              <td class="num text-ink-2">{signed(r.added, "+")}</td>
              <td class="num text-ink-2">{signed(r.removed, "−")}</td>
              <td class="num"><ValueBar label={compact(r.changed)} fraction={r.changed / maxChanged} /></td>
              <td class="num text-ink-2">{usd(r.cost)}</td>
              <td class="num font-medium">{r.costPer100 != null ? usd(r.costPer100) : "–"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/snippet}
  </TableCard>
  <p class="text-xs text-muted">{t("lines.hint")}</p>
{/if}
