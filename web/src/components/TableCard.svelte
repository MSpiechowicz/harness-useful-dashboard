<script lang="ts" generics="T, K extends string">
  import type { Snippet } from "svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import Card from "./Card.svelte";
  import Dropdown from "./Dropdown.svelte";
  import Empty from "./Empty.svelte";
  import ExportMenu from "./ExportMenu.svelte";
  import Pager from "./Pager.svelte";
  import SearchInput from "./SearchInput.svelte";

  /**
   * The standard table card: title and description, a search box and a sort control in the header, ten rows a page
   * with page navigation below.
   *
   * By default it searches and pages `rows` itself, and the table inside sorts and shows the slice it is given.
   * When the server searches, sorts and pages instead (sessions, prompts, files), pass its `total` and bind `query`
   * and `page`: `rows` is then the current page as it is.
   */
  interface Props {
    title: string;
    subtitle?: string;
    rows: T[];
    /** The text a row is found by (when this card searches). */
    searchText?: (row: T) => string;
    /** Sort choices; `asc` for the ones that read from the top (names). */
    sorts: { value: K; label: string; asc?: boolean }[];
    sortKey: K;
    asc?: boolean;
    /** Server-side tables: the matching row count; `rows` is the current page. */
    total?: number;
    query?: string;
    page?: number;
    loading?: boolean;
    pageSize?: number;
    class?: string;
    /** Adds the export menu: the file's name part (English, stable), e.g. `sessions`. */
    exportName?: string;
    /** Server-side tables: every row matching the filters and search, for the export (the card has one page). */
    exportAll?: () => Promise<T[]>;
    /** The exported rows made from the card's rows, when a table shows more than one line a row (Live's subagents). */
    exportRows?: (rows: T[]) => unknown[];
    /** The table for the current page: rows to sort, and which slice of them to show. */
    children: Snippet<[{ rows: T[]; offset: number; limit: number | undefined }]>;
  }
  let {
    title,
    subtitle,
    rows,
    searchText,
    sorts,
    sortKey = $bindable(),
    asc = $bindable(false),
    total,
    query = $bindable(""),
    page = $bindable(1),
    loading = false,
    pageSize = 10,
    class: cls = "",
    exportName,
    exportAll,
    exportRows,
    children,
  }: Props = $props();

  const server = $derived(total != null);
  const found = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return server || !q || !searchText ? rows : rows.filter((r) => searchText(r).toLowerCase().includes(q));
  });
  // A new search or sort starts again on page 1. Not the first time: a list brought back keeps the page it was left on.
  let primed = false;
  $effect(() => {
    void query;
    void sortKey;
    void asc;
    if (primed) page = 1;
    primed = true;
  });
</script>

<Card {title} {subtitle} pad={false} class={cls}>
  {#snippet actions()}
    <SearchInput bind:value={query} />
    <Dropdown label={t("common.sortBy")} bind:value={sortKey} options={sorts.map((s) => ({ value: s.value, label: s.label }))} onchange={(v) => (asc = !!sorts.find((s) => s.value === v)?.asc)} />
    {#if exportName}<ExportMenu name={exportName} rows={() => (server && exportAll ? exportAll() : exportRows ? exportRows(found) : found)} />{/if}
  {/snippet}
  {#if found.length}
    <div class="overflow-x-auto transition-opacity" class:loading-dim={loading}>
      {@render children(server ? { rows: found, offset: 0, limit: undefined } : { rows: found, offset: (page - 1) * pageSize, limit: pageSize })}
    </div>
    <Pager {page} total={total ?? found.length} size={pageSize} {loading} onpage={(p) => (page = p)} />
  {:else}
    <Empty compact title={query.trim() ? t("filter.noMatches") : undefined} />
  {/if}
</Card>
