<script lang="ts">
  import { colorFor } from "../lib/colors.svelte.ts";
  import { PROVIDER_NAMES, PROVIDERS } from "../lib/palette.ts";

  /**
   * Every harness's color, as a row of chips: a legend for the squares a list puts before its rows. Harnesses with a
   * count are highlighted and show it, the rest are muted. `title` is the tooltip of a highlighted chip.
   */
  let { counts, title, class: cls = "" }: { counts: Map<string, number>; title?: (n: number) => string; class?: string } = $props();
</script>

<!-- Even columns rather than a wrapped row: a harness that no longer fits never sits alone on a line of its own. -->
<ul class="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] items-center gap-x-2 gap-y-1.5 {cls}">
  {#each PROVIDERS as p (p)}
    {@const n = counts.get(p) ?? 0}
    <li
      class="flex items-center gap-1.5 justify-self-start rounded-full border px-2.5 py-1 text-xs whitespace-nowrap {n ? 'border-line bg-surface-2 text-ink' : 'border-transparent text-muted'}"
      title={n && title ? title(n) : undefined}
    >
      <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", p)}></span>
      {PROVIDER_NAMES[p]}
      {#if n}<span class="tabular text-ink-2">{n}</span>{/if}
    </li>
  {/each}
</ul>
