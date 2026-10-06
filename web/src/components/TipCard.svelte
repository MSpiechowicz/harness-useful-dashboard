<script lang="ts">
  import Link from "./Link.svelte";
  import { ArrowRight, CircleAlert, Info, TriangleAlert } from "@lucide/svelte";
  import type { Tip } from "../lib/api.svelte.ts";
  import { compact, integer, usd } from "../lib/format.ts";
  import { i18n, t, tMaybe } from "../lib/i18n.svelte.ts";

  let { tip }: { tip: Tip } = $props();

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
</script>

<article class="card flex gap-3 p-4">
  <div class="mt-0.5 shrink-0" style:color={sevColor}>
    {#if tip.severity === "critical"}<CircleAlert size={18} />{:else if tip.severity === "warn"}<TriangleAlert size={18} />{:else}<Info size={18} />{/if}
  </div>
  <div class="min-w-0 flex-1">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="text-sm font-semibold text-ink">{title}</h3>
      <span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-2">{t(`tips.sev.${tip.severity}` as "tips.sev.info")}</span>
    </div>
    <p class="mt-1 text-sm leading-relaxed text-ink-2">{body}</p>
    {#if tip.link}
      <Link to={tip.link} class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{t("tips.open")}<ArrowRight size={12} /></Link>
    {/if}
  </div>
</article>
