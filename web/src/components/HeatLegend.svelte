<script lang="ts">
  // Swatches match the heatmap's steps: seq-0 is an empty slot, seq-1…seq-7 run from any activity to the peak.
  let { max, min = "0" }: { max: string; min?: string } = $props();
</script>

<div class="flex items-center gap-1 text-[11px] text-muted">
  <span class="tabular mr-0.5">{min}</span>
  {#each [0, 1, 2, 3, 4, 5, 6, 7] as step (step)}
    <span class="h-2.5 w-2.5 rounded-[3px]" style:background="var(--seq-{step})"></span>
  {/each}
  <span class="tabular ml-0.5">{max}</span>
</div>
