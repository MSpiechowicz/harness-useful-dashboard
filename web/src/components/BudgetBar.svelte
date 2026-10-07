<script lang="ts">
  import { useFetch } from "../lib/api.svelte.ts";
  import { usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import Card from "./Card.svelte";
  import Link from "./Link.svelte";

  interface BudgetItem {
    scope: "daily" | "monthly" | "project";
    project: string | null;
    cap: number;
    spent: number;
    fraction: number;
    projected: number | null;
  }

  /** How the spending caps stand: today, this month and per project. Hidden while none are set. */
  const budgets = useFetch<{ items: BudgetItem[] }>(() => "/api/budgets");
  const items = $derived(budgets.data?.items ?? []);

  // Calm until close, then louder: the same steps as the plan limits.
  const color = (f: number) => (f >= 1 ? "var(--status-critical)" : f >= 0.8 ? "var(--status-warning)" : "var(--status-good)");
  const name = (it: BudgetItem) =>
    it.scope === "project" ? (it.project ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "" : t(it.scope === "daily" ? "budget.daily" : "budget.monthly");
</script>

{#if items.length}
  <Card title={t("budget.title")} subtitle={t("budget.hint")}>
    {#snippet actions()}<Link to="#/settings" class="text-xs font-medium text-accent-ink hover:underline">{t("budget.edit")}</Link>{/snippet}
    <div class="grid gap-x-8 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each items as it (it.scope + (it.project ?? ""))}
        <div class="min-w-0">
          <div class="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
            <span class="truncate font-medium text-ink-2" title={it.project ?? undefined}>{name(it)}</span>
            <span class="shrink-0 tabular text-muted">{t("budget.of", { spent: usd(it.spent), cap: usd(it.cap) })}</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(it.fraction * 100)} aria-label={name(it)}>
            <div class="h-full rounded-full transition-[width] duration-500" style:width="{Math.min(100, it.fraction * 100)}%" style:background={color(it.fraction)}></div>
          </div>
          <div class="mt-1 flex justify-between gap-3 text-[11px] text-muted tabular">
            <span>{Math.round(it.fraction * 100)}%</span>
            {#if it.projected != null}<span>{t("budget.projected", { value: usd(it.projected) })}</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  </Card>
{/if}
