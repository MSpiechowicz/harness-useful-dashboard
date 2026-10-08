<script lang="ts" module>
  import type { BillingRow } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { PROVIDER_NAMES } from "../lib/palette.ts";

  export type BillingSortKey = "label" | "cost" | "tokens" | "calls" | "premiumRequests";

  /** Names for the plans and accounts harnesses report; anything else shows as reported. */
  const PLANS: Record<string, string> = {
    "github-copilot": "GitHub Copilot",
    "openai-codex": "ChatGPT plan (Codex)",
    openai: "OpenAI API",
    anthropic: "Anthropic API",
    openrouter: "OpenRouter",
    "google-gemini-cli": "Gemini CLI",
  };

  export function billingLabel(r: BillingRow): string {
    return r.reported ? PLANS[r.key] ?? r.key : t("billing.own", { name: PROVIDER_NAMES[r.key as keyof typeof PROVIDER_NAMES] ?? r.key });
  }
</script>

<script lang="ts">
  import SortTh from "./SortTh.svelte";
  import { compact, usd } from "../lib/format.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  interface Props {
    rows: BillingRow[];
    /** The page shown: rows from `offset`, at most `limit`, counted after sorting. */
    offset?: number;
    limit?: number;
    sortKey?: BillingSortKey;
    asc?: boolean;
  }
  let { rows, offset = 0, limit, sortKey = $bindable("cost"), asc = $bindable(false) }: Props = $props();

  const value = (r: BillingRow, k: BillingSortKey) => (k === "label" ? billingLabel(r) : r[k]);
  const sorted = $derived(
    [...rows].sort((a, b) => {
      const x = value(a, sortKey);
      const y = value(b, sortKey);
      const r = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
      return asc ? r : -r;
    }),
  );
  const visible = $derived(limit == null ? sorted : sorted.slice(offset, offset + limit));
  // Premium requests only mean something for Copilot; the column shows once any row has them.
  const premium = $derived(rows.some((r) => r.premiumRequests > 0));

  function sortBy(k: BillingSortKey) {
    if (sortKey === k) asc = !asc;
    else {
      sortKey = k;
      asc = k === "label";
    }
  }
  const dir = (k: BillingSortKey) => (sortKey === k ? (asc ? "ascending" : "descending") : undefined);
</script>

<table class="data" use:resizableColumns={"billing"}>
  <thead>
    <tr>
      <SortTh label={t("col.name")} sort={dir("label")} onclick={() => sortBy("label")} />
      <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortBy("cost")} />
      <SortTh num label={t("col.tokens")} sort={dir("tokens")} onclick={() => sortBy("tokens")} />
      <SortTh num label={t("col.calls")} sort={dir("calls")} onclick={() => sortBy("calls")} />
      {#if premium}<SortTh num label={t("col.premiumRequests")} sort={dir("premiumRequests")} onclick={() => sortBy("premiumRequests")} />{/if}
    </tr>
  </thead>
  <tbody>
    {#each visible as r (r.key)}
      <tr title={r.key}>
        <td class="max-w-72">
          <div class="flex items-center gap-2">
            <span class="truncate">{billingLabel(r)}</span>
            {#if r.estimated}<span class="rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("common.estimatedHint")}>{t("common.estimated")}</span>{/if}
          </div>
        </td>
        <td class="num font-medium">{usd(r.cost)}</td>
        <td class="num text-ink-2">{compact(r.tokens)}</td>
        <td class="num text-ink-2">{compact(r.calls)}</td>
        {#if premium}<td class="num text-ink-2">{r.premiumRequests ? compact(r.premiumRequests) : "–"}</td>{/if}
      </tr>
    {/each}
  </tbody>
</table>
