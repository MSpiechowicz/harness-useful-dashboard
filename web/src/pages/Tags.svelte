<script lang="ts">
  import { Info } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import RankedList from "../components/RankedList.svelte";
  import SortTh from "../components/SortTh.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch, type TagRow } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, percent, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  type SortKey = "label" | "cost" | "tokens" | "sessions" | "changed" | "costPer100" | "lastTs";

  const data = useFetch<{ total: { tokens: number; cost: number }; rows: TagRow[] }>(() => apiUrl("/api/tags"));
  // The kinds of work (AI session labels, Settings): shown below once sessions have been labelled.
  const kinds = useFetch<{ total: { tokens: number; cost: number }; rows: TagRow[] }>(() => apiUrl("/api/kinds"));
  const kindRows = $derived(kinds.data?.rows ?? []);
  const maxKindShare = $derived(Math.max(0.0001, ...kindRows.map((r) => (store.metric === "cost" ? r.share : r.tokenShare))));
  const rows = $derived(data.data?.rows ?? []);
  // The untagged sessions are listed in the table (what is left out of every tag) but are no tag to filter by.
  const tagged = $derived(rows.filter((r) => r.key !== "(none)"));

  const SORTS: { value: SortKey; label: string; asc?: boolean }[] = $derived([
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "sessions", label: t("col.sessions") },
    { value: "changed", label: t("col.lines") },
    { value: "lastTs", label: t("col.lastSeen") },
    { value: "label", label: t("col.name"), asc: true },
  ]);
  let sortKey = $state<SortKey>(store.metric === "cost" ? "cost" : "tokens");
  let asc = $state(false);

  const sorted = (list: TagRow[]) =>
    [...list].sort((a, b) => {
      const x = a[sortKey];
      const y = b[sortKey];
      // A tag without changed lines has no cost per line: it goes last either way.
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return asc ? r : -r;
    });
  function sortBy(k: SortKey) {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === "label";
    }
  }
  const dir = (k: SortKey) => (sortKey === k ? (asc ? "ascending" : "descending") : undefined);
  const maxShare = $derived(Math.max(0.0001, ...rows.map((r) => (store.metric === "cost" ? r.share : r.tokenShare))));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("nav.tags")} subtitle={t("tags.subtitle")} />
  <ViewGate ready={settled(data, kinds)}>
    {#if data.data && !tagged.length}
      <div class="card"><Empty title={t("tags.empty")} body={t("tags.emptyBody")} /></div>
    {:else}
      <Card title={t("chart.distribution")} subtitle={t(`metric.${store.metric}`)}>
        <RankedList rows={tagged} dim="tag" limit={8} filterKey="tag" loading={data.loading} />
      </Card>

      <TableCard
        title={t("tags.tableTitle")}
        subtitle={t("tags.tableHint")}
        {rows}
        searchText={(r) => `${entityLabel("tag", r.key, r.label)} ${r.key}`}
        sorts={SORTS}
        bind:sortKey
        bind:asc
        exportName="tags"
      >
        {#snippet children(view)}
          <table class="data" use:resizableColumns={"tags-1"}>
            <thead>
              <tr>
                <SortTh label={t("col.name")} sort={dir("label")} onclick={() => sortBy("label")} />
                <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortBy("cost")} />
                <SortTh num label={t("col.tokens")} sort={dir("tokens")} onclick={() => sortBy("tokens")} />
                <th class="num">{t("col.share")}</th>
                <SortTh num label={t("col.sessions")} sort={dir("sessions")} onclick={() => sortBy("sessions")} />
                <SortTh num label={t("col.lines")} sort={dir("changed")} onclick={() => sortBy("changed")} />
                <SortTh num label={t("tags.col.per100")} sort={dir("costPer100")} onclick={() => sortBy("costPer100")} />
                <SortTh num label={t("col.lastSeen")} sort={dir("lastTs")} onclick={() => sortBy("lastTs")} />
              </tr>
            </thead>
            <tbody>
              {#each sorted(view.rows).slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as r (r.key)}
                {@const share = store.metric === "cost" ? r.share : r.tokenShare}
                {@const none = r.key === "(none)"}
                <tr class:cursor-pointer={!none} onclick={() => !none && store.setFilter("tag", r.key)} title={r.key}>
                  <td class="max-w-72">
                    <div class="flex items-center gap-2">
                      {#if none}
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-muted"></span>
                        <span class="truncate text-ink-2 italic">{entityLabel("tag", r.key, r.label)}</span>
                      {:else}
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("tag", r.key)}></span>
                        <!-- The name is a button for the keyboard. It has no handler: its click reaches the row's. -->
                        <button type="button" class="truncate text-left">{r.label}</button>
                      {/if}
                      {#if r.estimated}<span class="rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("common.estimatedHint")}>{t("common.estimated")}</span>{/if}
                    </div>
                  </td>
                  <td class="num font-medium">{usd(r.cost)}</td>
                  <td class="num text-ink-2">{compact(r.tokens)}</td>
                  <td class="num text-ink-2"><ValueBar label={percent(share, share < 0.1 ? 1 : 0)} fraction={share / maxShare} color={colorFor("tag", r.key)} /></td>
                  <td class="num text-ink-2">{compact(r.sessions)}</td>
                  <td class="num text-ink-2">{r.changed ? compact(r.changed) : "–"}</td>
                  <td class="num text-ink-2">{r.costPer100 != null ? usd(r.costPer100) : "–"}</td>
                  <td class="num text-muted">{relative(r.lastTs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
      <p class="flex items-start gap-2 text-xs text-muted"><Info size={14} class="mt-px shrink-0" />{t("tags.overlapHint")}</p>
    {/if}

    {#if kindRows.some((r) => r.key !== "(none)")}
      <Card title={t("kinds.title")} subtitle={t("kinds.subtitle")} pad={false}>
        <table class="data" use:resizableColumns={"tags-2"}>
          <thead>
            <tr>
              <th>{t("filter.kind")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num">{t("col.share")}</th>
              <th class="num">{t("col.sessions")}</th>
              <th class="num">{t("col.lines")}</th>
              <th class="num">{t("tags.col.per100")}</th>
            </tr>
          </thead>
          <tbody>
            {#each kindRows as r (r.key)}
              {@const share = store.metric === "cost" ? r.share : r.tokenShare}
              {@const none = r.key === "(none)"}
              <tr class:cursor-pointer={!none} onclick={() => !none && store.setFilter("kind", r.key)} title={none ? undefined : t("kinds.tableHint")}>
                <td>
                  <div class="flex items-center gap-2">
                    {#if none}
                      <span class="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-muted"></span>
                      <span class="truncate text-ink-2 italic">{entityLabel("kind", r.key, r.label)}</span>
                    {:else}
                      <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("kind", r.key)}></span>
                      <button type="button" class="truncate text-left">{entityLabel("kind", r.key, r.label)}</button>
                    {/if}
                  </div>
                </td>
                <td class="num font-medium">{usd(r.cost)}</td>
                <td class="num text-ink-2">{compact(r.tokens)}</td>
                <td class="num text-ink-2"><ValueBar label={percent(share, share < 0.1 ? 1 : 0)} fraction={share / maxKindShare} color={none ? undefined : colorFor("kind", r.key)} /></td>
                <td class="num text-ink-2">{compact(r.sessions)}</td>
                <td class="num text-ink-2">{r.changed ? compact(r.changed) : "–"}</td>
                <td class="num text-ink-2">{r.costPer100 != null ? usd(r.costPer100) : "–"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </Card>
      <p class="flex items-start gap-2 text-xs text-muted"><Info size={14} class="mt-px shrink-0" />{t("kinds.hint")}</p>
    {/if}
  </ViewGate>
</div>
