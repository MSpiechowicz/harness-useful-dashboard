<script lang="ts">
  import type { Snippet } from "svelte";
  import { Table2, ChartColumn } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";

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
  }
  let { title, subtitle, actions, children, table, class: cls = "", pad = true, divided = false, footer }: Props = $props();
  let showTable = $state(false);
  const hasHeader = $derived(!!(title || actions || table));
</script>

<section class="card flex min-w-0 flex-col {cls}">
  {#if hasHeader}
    <header class="flex flex-wrap items-start justify-between gap-2 px-5 pt-4 {divided ? 'border-b border-line pb-4' : ''}">
      <div class="min-w-0">
        {#if title}<h2 class="font-semibold text-ink {divided ? 'text-[15px]' : 'text-sm'}">{title}</h2>{/if}
        {#if subtitle}<p class="mt-0.5 text-xs text-muted">{subtitle}</p>{/if}
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        {#if actions}{@render actions()}{/if}
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
  <div class="min-w-0 flex-1 {divided ? 'px-5' : pad ? 'px-5 pt-3 pb-4' : hasHeader ? 'card-flush overflow-hidden rounded-b-[13px] pt-3' : 'card-flush overflow-hidden rounded-[13px]'}">
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
