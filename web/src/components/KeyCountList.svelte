<script lang="ts">
  import { compact, usd } from "../lib/format.ts";

  interface Item {
    key: string | null;
    calls?: number;
    cost?: number;
    tokens?: number;
  }
  let { items, value = "calls", mono = false, color = "var(--data)" }: { items: Item[]; value?: "calls" | "cost"; mono?: boolean; color?: string } = $props();
  const max = $derived(Math.max(1e-9, ...items.map((i) => (value === "cost" ? i.cost ?? 0 : i.calls ?? 0))));
</script>

<ul class="flex flex-col gap-1.5">
  {#each items as it (it.key)}
    {@const v = value === "cost" ? it.cost ?? 0 : it.calls ?? 0}
    <li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm">
      <span class="truncate text-ink-2 {mono ? 'font-mono text-xs' : ''}" title={it.key ?? ""}>{it.key ?? "–"}</span>
      <span class="tabular text-right text-xs text-ink">{value === "cost" ? usd(v) : compact(v)}</span>
      <div class="col-span-2 h-1 overflow-hidden rounded-full bg-surface-2">
        <div class="h-full rounded-full" style:width="{(v / max) * 100}%" style:background={color}></div>
      </div>
    </li>
  {/each}
</ul>
