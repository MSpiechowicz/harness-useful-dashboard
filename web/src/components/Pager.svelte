<script lang="ts">
  import { ChevronLeft, ChevronRight } from "@lucide/svelte";
  import { i18n, t } from "../lib/i18n.svelte.ts";

  interface Props {
    /** 1-based. */
    page: number;
    total: number;
    size: number;
    loading?: boolean;
    onpage: (page: number) => void;
  }
  let { page, total, size, loading = false, onpage }: Props = $props();

  const pages = $derived(Math.max(1, Math.ceil(total / size)));
  const num = $derived(new Intl.NumberFormat(i18n.locale));
  const from = $derived(total ? (page - 1) * size + 1 : 0);
  const to = $derived(Math.min(total, page * size));

  // The first and last page, and the current one with its neighbors; gaps between them show as "…".
  const items = $derived.by(() => {
    const keep = [...new Set([1, page - 1, page, page + 1, pages])].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
    const out: (number | "gap")[] = [];
    keep.forEach((p, i) => {
      const prev = keep[i - 1];
      if (prev != null && p - prev === 2) out.push(prev + 1);
      else if (prev != null && p - prev > 2) out.push("gap");
      out.push(p);
    });
    return out;
  });
</script>

<div class="table-footer">
  <span class="tabular">{t("pager.range", { from: num.format(from), to: num.format(to), total: num.format(total) })}</span>
  {#if pages > 1}
    <nav class="flex items-center gap-1 transition-opacity" class:loading-dim={loading} aria-label={t("pager.label")}>
      <button class="btn !h-7 !px-1.5" disabled={page <= 1} aria-label={t("pager.prev")} onclick={() => onpage(page - 1)}><ChevronLeft size={14} /></button>
      {#each items as it, i (it === "gap" ? `gap${i}` : it)}
        {#if it === "gap"}
          <span class="px-1 text-muted">…</span>
        {:else}
          <button
            class="btn !h-7 min-w-7 justify-center !px-2 tabular {it === page ? '!border-accent/60 !bg-accent-wash text-accent-ink' : ''}"
            aria-current={it === page ? "page" : undefined}
            onclick={() => onpage(it)}>{num.format(it)}</button
          >
        {/if}
      {/each}
      <button class="btn !h-7 !px-1.5" disabled={page >= pages} aria-label={t("pager.next")} onclick={() => onpage(page + 1)}><ChevronRight size={14} /></button>
    </nav>
  {/if}
</div>
