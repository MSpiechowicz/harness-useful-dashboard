<script lang="ts">
  import { setContext, type Snippet } from "svelte";
  import { Table2, ChartColumn } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { columnSets } from "../lib/columns.svelte.ts";
  import ColumnsMenu from "./ColumnsMenu.svelte";
  import ExportMenu from "./ExportMenu.svelte";

  interface Props {
    title?: string;
    subtitle?: string;
    actions?: Snippet;
    children: Snippet;
    /** When provided, the card gets a chart/table toggle and renders this instead of children in table mode. */
    table?: Snippet;
    class?: string;
    pad?: boolean;
    /** A section of a form (settings): the header is ruled off from the rows below it, which bring their own spacing. */
    divided?: boolean;
    /** Buttons for the whole card (Save), in a ruled-off strip at the bottom. */
    footer?: Snippet;
    /** Adds the export menu: the file's name part (English, stable) and the rows the card shows. */
    exportName?: string;
    exportRows?: () => readonly unknown[];
  }
  let { title, subtitle, actions, children, table, class: cls = "", pad = true, divided = false, footer, exportName, exportRows }: Props = $props();
  let showTable = $state(false);
  // A chart in the card is named after it (see Chart's label).
  setContext("card-title", () => title);
  const hasHeader = $derived(!!(title || actions || table || exportName));
  // The tables in the card whose columns can be hidden get a menu for them, with the card's other buttons.
  let body = $state<HTMLDivElement>();
  const sets = $derived(
    [...columnSets].filter((s) => body?.contains(s.table) && s.table.closest("section.card") === body.parentElement && s.names.some((_, i) => s.hideable(i))),
  );
</script>

<section class="card flex min-w-0 flex-col {cls}">
  {#if hasHeader}
    <header class="flex flex-wrap items-start justify-between gap-2 px-5 pt-4 {divided ? 'border-b border-line pb-4' : ''}">
      <!-- A long description wraps beside the buttons, rather than pushing them onto a line of their own. -->
      <div class="min-w-0 flex-1 basis-56">
        {#if title}<h2 class="font-semibold text-ink {divided ? 'text-[15px]' : 'text-sm'}">{title}</h2>{/if}
        {#if subtitle}<p class="mt-0.5 text-xs text-muted">{subtitle}</p>{/if}
      </div>
      <!-- The buttons start where the title's letters do, not at the top of its line box (about 5px higher). -->
      <div class="flex min-w-0 flex-wrap items-center gap-2 {title ? 'mt-[5px]' : ''}">
        {#if actions}{@render actions()}{/if}
        {#if sets.length}<ColumnsMenu {sets} small={!actions} />{/if}
        {#if exportName && exportRows}<ExportMenu name={exportName} rows={exportRows} small />{/if}
        {#if table}
          <button
            class="btn !h-7 !px-2"
            title={showTable ? t("chart.showChart") : t("chart.showTable")}
            aria-label={showTable ? t("chart.showChart") : t("chart.showTable")}
            onclick={() => (showTable = !showTable)}
          >
            {#if showTable}<ChartColumn size={14} />{:else}<Table2 size={14} />{/if}
          </button>
        {/if}
      </div>
    </header>
  {/if}
  <!-- Unpadded content (edge-to-edge tables) is clipped to the card's inner radius so header and row fills stay inside the border.
       Under a header it starts the same distance below the description in every card. -->
  <div bind:this={body} class="min-w-0 flex-1 {divided ? 'px-5' : pad ? 'px-5 pt-3 pb-4' : hasHeader ? 'card-flush overflow-hidden rounded-b-[13px] pt-3' : 'card-flush overflow-hidden rounded-[13px]'}">
    {#if table && showTable}
      <div class="max-h-[420px] overflow-auto">{@render table()}</div>
    {:else}
      {@render children()}
    {/if}
  </div>
  {#if footer}
    <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{@render footer()}</footer>
  {/if}
</section>
