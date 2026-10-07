<script lang="ts">
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import TableCard from "../components/TableCard.svelte";
  import { Sparkles } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Link from "../components/Link.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, getJson, settled, useFetch } from "../lib/api.svelte.ts";
  import { paretoChart, percentile, promptHistogram, topShare, type PromptCost } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, dateTime, entityLabel, metricValue, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store, keeper } from "../lib/state.svelte.ts";

  interface PromptRow {
    id: string;
    ts: number;
    text: string | null;
    skill: string | null;
    provider: string;
    projectLabel: string;
    project: string | null;
    sessionTitle: string | null;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    subagentCost: number;
    models: string | null;
  }

  const keep = keeper();
  type Sort = "cost" | "tokens" | "recent" | "messages";
  let sort = $state<Sort>(keep.recall("sort", "cost"));
  const SORTS = $derived((["cost", "tokens", "recent", "messages"] as const).map((value) => ({ value: value as Sort, label: t(`sort.${value}`) })));
  let query = $state(keep.recall("query", ""));
  let debounced = $state(keep.recall("query", ""));
  // The table pages 10 rows at a time (the table card starts again on page 1 after a new search or sort).
  const PAGE = 10;
  let page = $state(keep.recall("page", 1));
  $effect(() => keep.remember({ sort, query, page }));
  $effect(() => {
    const q = query;
    // A search brought back with the view is already applied: it keeps its page.
    if (q === debounced) return;
    const h = setTimeout(() => {
      debounced = q;
      page = 1;
    }, 250);
    return () => clearTimeout(h);
  });

  const data = useFetch<{ total: number; rows: PromptRow[] }>(() => apiUrl("/api/prompts", { sort, q: debounced, limit: PAGE, offset: (page - 1) * PAGE }));
  const maxCost = $derived(Math.max(1e-9, ...(data.data?.rows ?? []).map((r) => r.cost)));

  // Every prompt in the range, for how the spend spreads across them.
  const costs = useFetch<PromptCost[]>(() => apiUrl("/api/prompts/costs"));
  const values = $derived((costs.data ?? []).map((r) => (store.metric === "cost" ? r.cost : r.tokens)));
  const metricWord = $derived(t(`prompts.metricWord.${store.metric}`));
  const histogram = $derived.by(() => (void store.dark, costs.data?.length ? promptHistogram(costs.data, store.metric) : null));
  const pareto = $derived.by(() => (void store.dark, values.length ? paretoChart(values, store.metric) : null));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("prompts.title")} subtitle={t("prompts.subtitle")} />
  <ViewGate ready={settled(data, costs)}>
    {#if histogram && pareto}
      <div class="grid gap-5 xl:grid-cols-5">
        <Card title={t("prompts.dist", { metric: t(`metric.${store.metric}`) })} subtitle={t("prompts.distHint")} class="xl:col-span-3">
          {#snippet actions()}
            <div class="flex gap-5 text-right">
              <div><div class="text-[11px] text-muted">{t("prompts.median")}</div><div class="text-sm font-semibold text-ink tabular">{metricValue(percentile(values, 0.5), store.metric)}</div></div>
              <div><div class="text-[11px] text-muted">{t("prompts.p90")}</div><div class="text-sm font-semibold text-ink tabular">{metricValue(percentile(values, 0.9), store.metric)}</div></div>
            </div>
          {/snippet}
          <Chart option={histogram} height={260} fill dim={costs.loading} />
        </Card>
        <Card title={t("prompts.pareto")} subtitle={t("prompts.paretoHint", { metric: metricWord })} class="xl:col-span-2">
          <!-- The headline number, then the curve it comes from in the rest of the card. -->
          <div class="flex h-full flex-col">
            <div class="mb-1 flex items-baseline gap-2">
              <span class="text-2xl font-semibold tracking-tight text-ink tabular">{percent(topShare(values, 0.1), 0)}</span>
              <span class="text-xs text-muted">{t("prompts.top10", { metric: metricWord })}</span>
            </div>
            <Chart option={pareto} height={220} fill dim={costs.loading} />
          </div>
        </Card>
      </div>
    {/if}

    <TableCard
      title={t("prompts.tableTitle")}
      subtitle={t("prompts.tableHint")}
      rows={data.data?.rows ?? []}
      total={data.data?.total ?? 0}
      sorts={SORTS}
      bind:sortKey={sort}
      bind:query
      bind:page
      loading={data.loading}
      exportName="prompts"
      exportAll={() => getJson<{ rows: PromptRow[] }>(apiUrl("/api/prompts", { sort, q: debounced, limit: 10000, export: 1 })).then((d) => d.rows)}
    >
      {#snippet children(view)}
        <table class="data fixed-cols">
          <colgroup>
            <col />
            <col class="w-40" />
            <col class="w-44" />
            <col class="w-[4.5rem]" />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-44" />
            <col class="w-44" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.prompt")}</th>
              <th>{t("col.skill")}</th>
              <th>{t("col.project")}</th>
              <th class="num">{t("col.messages")}</th>
              <th class="num">{t("col.tools")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num w-44">{t("col.cost")}</th>
              <th class="num">{t("col.time")}</th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows as r (r.id)}
              <tr class="cursor-pointer" onclick={() => navigate("prompts", r.id)}>
                <!-- One line per row: the prompt truncates (the tooltip has it whole), the skill has its own column. -->
                <td class="max-w-xl" title={r.text ?? undefined}>
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", r.provider)} title={r.provider}></span>
                    <Link to="#/prompts/{encodeURIComponent(r.id)}" class="truncate text-ink">{r.text ?? t("prompts.noText")}</Link>
                  </div>
                </td>
                <td class="max-w-40 text-xs" title={r.skill ?? undefined}>
                  {#if r.skill}<span class="flex items-center gap-1 text-accent-ink"><Sparkles size={11} class="shrink-0" /><span class="truncate">{r.skill}</span></span>{:else}<span class="text-muted">–</span>{/if}
                </td>
                <td class="max-w-40 truncate text-ink-2" title={r.project}>{entityLabel("project", r.project, r.projectLabel)}</td>
                <td class="num text-ink-2">{compact(r.messages)}</td>
                <td class="num text-ink-2">{compact(r.toolCalls)}</td>
                <td class="num text-ink-2">{compact(r.tokens)}</td>
                <td class="num font-medium"><ValueBar label={usd(r.cost)} fraction={r.cost / maxCost} /></td>
                <td class="num text-xs text-muted">{dateTime(r.ts)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>
  </ViewGate>
</div>
