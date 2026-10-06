<script lang="ts">
  import { compact, shortPaths, usd } from "../lib/format.ts";
  import Link from "./Link.svelte";

  interface Item {
    key: string | null;
    /** Shown instead of the key (the key stays the row's identity and tooltip). */
    label?: string;
    calls?: number;
    cost?: number;
    tokens?: number;
  }
  /**
   * A short ranked list for a detail page's side cards: the name, its value, and the value's bar on the right, laid
   * out like the bar cells of the tables. With `paths`, keys are file paths: each row shows the shortest end of its
   * path that tells it apart from the others, and the full path on hover.
   */
  let {
    items,
    value = "calls",
    paths = false,
    link,
    max: maxOf,
  }: {
    items: Item[];
    value?: "calls" | "cost";
    paths?: boolean;
    /** Where a row leads, e.g. a subagent's session: the name becomes a link. */
    link?: (key: string) => string;
    /** The bars' full length, when the list is one page of a longer one: the largest value of all pages. */
    max?: number;
  } = $props();

  const of = (i: Item) => (value === "cost" ? (i.cost ?? 0) : (i.calls ?? 0));
  const max = $derived(maxOf ?? Math.max(1e-9, ...items.map(of)));
  const labels = $derived(paths ? shortPaths(items.map((i) => i.key ?? "")) : null);
</script>

<ul class="-mx-2 flex flex-col">
  {#each items as it, i (it.key)}
    {@const v = of(it)}
    <li class="grid grid-cols-[minmax(0,1fr)_auto_5rem] items-center gap-x-3 rounded-lg px-2 py-1.5" title={it.key ?? ""}>
      {#if paths}
        <!-- A long path gives up its start, never the file name: right-to-left truncation around a left-to-right path. -->
        <span class="truncate text-left font-mono text-xs text-ink-2" dir="rtl"><bdi dir="ltr">{labels?.[i] ?? it.key ?? "–"}</bdi></span>
      {:else if link && it.key}
        <Link to={link(it.key)} class="truncate text-[13px] text-accent-ink hover:underline">{it.label ?? it.key}</Link>
      {:else}
        <span class="truncate text-[13px] text-ink-2">{it.label ?? it.key ?? "–"}</span>
      {/if}
      <span class="tabular text-right text-[13px] font-medium text-ink">{value === "cost" ? usd(v) : compact(v)}</span>
      <span class="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <span class="block h-full rounded-full bg-data" style:width={v > 0 ? `max(${(v / max) * 100}%, 3px)` : "0"}></span>
      </span>
    </li>
  {/each}
</ul>
