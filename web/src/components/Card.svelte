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
  }
  let { title, subtitle, actions, children, table, class: cls = "", pad = true }: Props = $props();
  let showTable = $state(false);
</script>

<section class="card flex min-w-0 flex-col {cls}">
  {#if title || actions || table}
    <header class="flex flex-wrap items-start justify-between gap-2 px-5 pt-4">
      <div class="min-w-0">
        {#if title}<h2 class="text-sm font-semibold text-ink">{title}</h2>{/if}
        {#if subtitle}<p class="mt-0.5 text-xs text-muted">{subtitle}</p>{/if}
      </div>
      <div class="flex items-center gap-2">
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
  <div class="min-w-0 flex-1 {pad ? 'px-5 pt-3 pb-4' : ''}">
    {#if table && showTable}
      <div class="max-h-[420px] overflow-auto">{@render table()}</div>
    {:else}
      {@render children()}
    {/if}
  </div>
</section>
