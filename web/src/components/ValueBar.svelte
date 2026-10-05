<script lang="ts">
  /**
   * The bar cell every table uses: the value right-aligned in a fixed slot, then a fixed-width track, so bars
   * start at the same place and share one length scale in every table. A value above zero always shows at least
   * as a dot.
   */
  let {
    label,
    fraction,
    color = "var(--data)",
  }: {
    label: string;
    /** 0…1, the bar's length: usually the value over the column's largest. */
    fraction: number;
    color?: string;
  } = $props();

  const width = $derived(Math.max(0, Math.min(1, fraction)));
</script>

<span class="inline-flex items-center justify-end gap-2.5">
  <span class="w-14 truncate text-right tabular">{label}</span>
  <span class="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-3">
    <span class="block h-full rounded-full" style:width={width > 0 ? `max(${width * 100}%, 3px)` : "0"} style:background={color}></span>
  </span>
</span>
