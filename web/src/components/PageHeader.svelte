<script lang="ts">
  import type { Snippet } from "svelte";
  let { title, subtitle, children }: { title: string; subtitle?: string; children?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
  <div class="min-w-0">
    <h1 class="text-xl font-semibold tracking-tight text-ink">{title}</h1>
    {#if subtitle}<p class="mt-0.5 text-sm text-muted">{subtitle}</p>{/if}
  </div>
  {#if children}<div class="flex items-center gap-2">{@render children()}</div>{/if}
</div>
