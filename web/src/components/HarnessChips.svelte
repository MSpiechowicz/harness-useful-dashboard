<script lang="ts">
  import { colorFor } from "../lib/colors.svelte.ts";
  import { PROVIDER_NAMES, PROVIDERS } from "../lib/palette.ts";

  /**
   * Every harness's color, as a row of chips: a legend for the squares a list puts before its rows. Harnesses with a
   * count are highlighted and show it, the rest are muted. `title` is the tooltip of a highlighted chip.
   */
  let { counts, title, class: cls = "" }: { counts: Map<string, number>; title?: (n: number) => string; class?: string } = $props();
</script>

<ul class="flex flex-wrap items-center gap-2 {cls}">
  {#each PROVIDERS as p (p)}
    {@const n = counts.get(p) ?? 0}
    <li
      class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs {n ? 'border-line bg-surface-2 text-ink' : 'border-transparent text-muted'}"
      title={n && title ? title(n) : undefined}
    >
      <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", p)}></span>
      {PROVIDER_NAMES[p]}
      {#if n}<span class="tabular text-ink-2">{n}</span>{/if}
    </li>
  {/each}
</ul>
