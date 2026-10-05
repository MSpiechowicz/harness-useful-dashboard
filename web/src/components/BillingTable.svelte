<script lang="ts" module>
  import type { BillingRow } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";

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
  /** Harnesses that don't report a plan are billed to their own account. */
  const HARNESSES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", omp: "omp", pi: "pi", opencode: "OpenCode" };

  export function billingLabel(r: BillingRow): string {
    return r.reported ? PLANS[r.key] ?? r.key : t("billing.own", { name: HARNESSES[r.key] ?? r.key });
  }
</script>

<script lang="ts">
  import { compact, usd } from "../lib/format.ts";

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
  const arrow = (k: BillingSortKey) => (sortKey === k ? (asc ? " ↑" : " ↓") : "");
</script>

<table class="data">
  <thead>
    <tr>
      <th><button onclick={() => sortBy("label")}>{t("col.name")}{arrow("label")}</button></th>
      <th class="num"><button onclick={() => sortBy("cost")}>{t("col.cost")}{arrow("cost")}</button></th>
      <th class="num"><button onclick={() => sortBy("tokens")}>{t("col.tokens")}{arrow("tokens")}</button></th>
      <th class="num"><button onclick={() => sortBy("calls")}>{t("col.calls")}{arrow("calls")}</button></th>
      {#if premium}<th class="num"><button onclick={() => sortBy("premiumRequests")}>{t("col.premiumRequests")}{arrow("premiumRequests")}</button></th>{/if}
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
