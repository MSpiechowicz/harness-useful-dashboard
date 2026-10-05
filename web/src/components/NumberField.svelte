<script lang="ts">
  /** A number input with its unit inside, filling its column like the other form controls. */
  let { value = $bindable(0), unit, label, min = 0 }: { value?: number; unit: string; label: string; min?: number } = $props();
</script>

<label class="input flex w-full items-center gap-2">
  <input class="h-full min-w-0 flex-1 bg-transparent tabular outline-none" type="number" {min} bind:value aria-label={label} />
  <span class="shrink-0 text-xs text-muted">{unit}</span>
</label>
