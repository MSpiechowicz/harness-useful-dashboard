<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * One setting: its name and what it does on the left, the control on the right. Controls share one column width
   * and its right edge, so they line up from row to row and card to card. `wide` gives a longer control (paths) a
   * wider column. `lead` goes before the name. Rows in a list are divided by a rule. The name and the control sit in the middle of the row's height, however many lines either one runs over.
   * `stacked` puts the control under the name at the full width of the row, for a list of folders, and `trail` (a
   * source's on/off switch) at the right of the name, where every other row has its control.
   */
  let {
    label,
    hint,
    wide = false,
    stacked = false,
    lead,
    trail,
    children,
  }: { label: string; hint?: string; wide?: boolean; stacked?: boolean; lead?: Snippet; trail?: Snippet; children?: Snippet } = $props();
</script>

{#if stacked}
  <div class="flex flex-col gap-3 border-t border-line py-4 first:border-t-0">
    <div class="flex items-center justify-between gap-6">
      <div class="min-w-0">
        <div class="text-sm font-medium text-ink">{label}</div>
        {#if hint}<div class="mt-0.5 max-w-[700px] text-[13px] leading-relaxed text-ink-2">{hint}</div>{/if}
      </div>
      {#if trail}<div class="flex shrink-0">{@render trail()}</div>{/if}
    </div>
    {#if children}<div class="flex min-w-0 flex-col gap-2">{@render children()}</div>{/if}
  </div>
{:else}
  <div class="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:gap-10">
    <div class="flex min-w-0 items-center gap-3">
      {#if lead}<div class="flex shrink-0">{@render lead()}</div>{/if}
      <div class="min-w-0">
        <div class="text-sm font-medium text-ink">{label}</div>
        {#if hint}<div class="mt-0.5 max-w-[700px] text-[13px] leading-relaxed text-ink-2">{hint}</div>{/if}
      </div>
    </div>
    <div class="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-3 {wide ? 'sm:w-[min(36rem,55%)]' : 'sm:w-72'}">{@render children?.()}</div>
  </div>
{/if}
