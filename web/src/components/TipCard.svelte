<script lang="ts">
  import Link from "./Link.svelte";
  import { ArrowRight, Check, CircleAlert, Eye, EyeOff, Info, TriangleAlert, Undo2 } from "@lucide/svelte";
  import type { Tip } from "../lib/api.svelte.ts";
  import { compact, integer, usd } from "../lib/format.ts";
  import { i18n, t, tMaybe } from "../lib/i18n.svelte.ts";
  import { tipStore } from "../lib/tips.svelte.ts";

  /** `flat` draws the tip as a row of a list inside a card (the Tips page), not as a card of its own. */
  let { tip, flat = false }: { tip: Tip; flat?: boolean } = $props();

  // Localize numeric params before interpolation.
  const params = $derived.by(() => {
    const p: Record<string, string | number | null> = { ...tip.params };
    for (const k of ["cost", "before", "after"]) if (typeof p[k] === "number") p[k] = usd(p[k] as number);
    for (const k of ["avg", "count", "max", "messages", "pace", "used"]) if (typeof p[k] === "number") p[k] = k === "avg" ? compact(p[k] as number) : integer(p[k] as number);
    // Ratios and shares with the language's decimal mark: 3.2 in English, 3,2 in German, French and Polish.
    for (const k of ["ratio", "share", "rate"]) if (typeof p[k] === "number") p[k] = new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 1 }).format(p[k] as number);
    return p;
  });
  const title = $derived(tMaybe(`tip.${tip.id}.title`, params) ?? tip.id);
  const body = $derived(tMaybe(`tip.${tip.id}.body`, params) ?? "");
  const sevColor = $derived(
    tip.severity === "critical" ? "var(--status-critical)" : tip.severity === "warn" ? "var(--status-warning)" : "var(--accent)",
  );
  const status = $derived(tipStore.status(tip));
  const readLabel = $derived(status === "read" ? t("tips.markUnread") : t("tips.markRead"));
  const hideLabel = $derived(status === "hidden" ? t("tips.unhide") : t("tips.hide"));
</script>

{#snippet actions()}
  {#if status !== "hidden"}
    <button class="btn !h-7 !px-2 text-xs" onclick={() => tipStore.setRead([tip], status !== "read")}>
      {#if status === "read"}<Undo2 size={13} />{:else}<Check size={13} />{/if}{readLabel}
    </button>
  {/if}
  <button class="btn !h-7 !px-2 text-xs" onclick={() => tipStore.setHidden(tip, status !== "hidden")}>
    {#if status === "hidden"}<Eye size={13} />{:else}<EyeOff size={13} />{/if}{hideLabel}
  </button>
{/snippet}

<article class="flex gap-3 p-4 {flat ? 'border-b border-line last:border-b-0' : 'card'}">
  <div class="mt-0.5 shrink-0" style:color={sevColor} class:opacity-60={status !== "active"}>
    {#if tip.severity === "critical"}<CircleAlert size={18} />{:else if tip.severity === "warn"}<TriangleAlert size={18} />{:else}<Info size={18} />{/if}
  </div>
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="flex items-start gap-3">
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 class="text-sm font-semibold {status === 'active' ? 'text-ink' : 'text-ink-2'}">{title}</h3>
        <span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">{t(`tips.sev.${tip.severity}` as "tips.sev.info")}</span>
        <span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">{t(`tips.cat.${tip.category}` as "tips.cat.cache")}</span>
      </div>
      <!-- In the list the actions sit beside the title, in a narrow card (the Overview) they close the footer. -->
      {#if flat}<div class="flex shrink-0 items-center gap-1.5">{@render actions()}</div>{/if}
    </div>
    <p class="mt-1 max-w-[700px] text-sm leading-relaxed text-ink-2">{body}</p>
    <div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
      {#if tip.link}
        <Link to={tip.link} class="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{t("tips.open")}<ArrowRight size={12} /></Link>
      {/if}
      {#if flat && tip.impact >= 1}<span class="text-xs text-muted tabular">{t("tips.impact", { cost: usd(tip.impact) })}</span>{/if}
      {#if !flat}<div class="ml-auto flex items-center gap-1.5">{@render actions()}</div>{/if}
    </div>
  </div>
</article>
