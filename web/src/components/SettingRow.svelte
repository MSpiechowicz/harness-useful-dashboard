<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One setting: its name and what it does on the left, the control on the right. Controls share one column width
   * and its right edge, so they line up from row to row and card to card. `wide` gives a longer control (paths) a
   * wider column. `lead` goes before the name (a source's on/off switch). Rows in a list are divided by a rule. The name and the control sit in the middle of the row's height, however many lines either one runs over.
   */
  let { label, hint, wide = false, lead, children }: { label: string; hint?: string; wide?: boolean; lead?: Snippet; children: Snippet } = $props();
</script>

<div class="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
  <div class="flex min-w-0 items-center gap-3">
    {#if lead}<div class="flex shrink-0">{@render lead()}</div>{/if}
    <div class="min-w-0">
      <div class="text-sm font-medium text-ink">{label}</div>
      {#if hint}<div class="mt-0.5 max-w-[700px] text-[13px] leading-relaxed text-ink-2">{hint}</div>{/if}
    </div>
  </div>
  <div class="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-3 {wide ? 'sm:w-[min(36rem,55%)]' : 'sm:w-72'}">{@render children()}</div>
</div>
