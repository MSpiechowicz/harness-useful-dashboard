<script lang="ts">
  import BillingTable, { type BillingSortKey, billingLabel } from "../components/BillingTable.svelte";
  import BreakdownTable, { type BreakdownSortKey } from "../components/BreakdownTable.svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import DonutList from "../components/DonutList.svelte";
  import MixByWeek from "../components/MixByWeek.svelte";
  import Empty from "../components/Empty.svelte";
  import TableCard from "../components/TableCard.svelte";
  import Toggle from "../components/Toggle.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import RankedList from "../components/RankedList.svelte";
  import UsageChart from "../components/UsageChart.svelte";
  import { apiUrl, settled, useFetch, type BillingRow, type Breakdown, type TimeSeries } from "../lib/api.svelte.ts";
  import { breakdownItems, treemapChart, trendAverage } from "../lib/charts.ts";
  import { isColored } from "../lib/colors.svelte.ts";
  import { entityLabel, metricValue, percent } from "../lib/format.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";

  let { dim }: { dim: "project" | "model" | "provider" | "user" | "skill" | "agent" } = $props();

  const titles: Record<string, MessageKey> = {
    project: "nav.projects", model: "nav.models", provider: "nav.providers", user: "nav.users", skill: "skills.skills", agent: "skills.agents",
  };

  const data = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim, limit: 500, sort: store.metric }));
  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group: dim, metric: store.metric }));
  // Providers: what the usage was billed through (a plan like Copilot, or the harness's own account).
  const billing = useFetch<BillingRow[]>(() => (dim === "provider" ? apiUrl("/api/billing", {}) : null));

  // Skills: drop turns without an active skill so the chart is about skills only.
  // "(none)" is left out where it isn't wanted: skills always (the page is about skills), projects when switched off.
  const hideNone = $derived(dim === "skill" || (dim === "project" && !store.showNoProject));
  const rows = $derived((data.data?.rows ?? []).filter((r) => !hideNone || r.key !== "(none)"));

  // The tables: the standard table card's sort choices (names read A to Z, numbers from the top).
  const SORTS: { value: BreakdownSortKey; label: string; asc?: boolean }[] = $derived([
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "sessions", label: t("col.sessions") },
    { value: "prompts", label: t("col.prompts") },
    { value: "cacheHitRate", label: t("col.cacheHit") },
    { value: "lastTs", label: t("col.lastSeen") },
    { value: "label", label: t("col.name"), asc: true },
  ]);
  let sortKey = $state<BreakdownSortKey>(store.metric === "cost" ? "cost" : "tokens");
  let asc = $state(false);
  const BILLING_SORTS: { value: BillingSortKey; label: string; asc?: boolean }[] = $derived([
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "calls", label: t("col.calls") },
    // Like its column, only once some call was billed as Copilot premium requests.
    ...(billing.data?.some((r) => r.premiumRequests > 0) ? [{ value: "premiumRequests" as const, label: t("col.premiumRequests") }] : []),
    { value: "label", label: t("col.name"), asc: true },
  ]);
  let billingSort = $state<BillingSortKey>("cost");
  let billingAsc = $state(false);
  // Skills: the time series without "(none)", so the lanes are about skills only.
  const trend = $derived(series.data && hideNone ? { ...series.data, series: series.data.series.filter((s) => s.key !== "(none)") } : series.data);
  // Each dimension gets the shape that suits it: projects are many and uneven (treemap), providers and
  // agents are a few parts of a whole (donut), everything else is a ranking.
  const shape = $derived(dim === "project" ? "treemap" : dim === "provider" || dim === "agent" ? "donut" : "ranked");
  const items = $derived(breakdownItems(rows, dim, store.metric));
  const fmt = (v: number) => metricValue(v, store.metric);
  // The treemap draws the top values only - those with a color of their own and a share big enough to read - so the
  // tail doesn't turn into slivers; shares stay of the full total, and the table below lists every value.
  const grand = $derived(items.reduce((a, i) => a + i.value, 0));
  const treemapItems = $derived(items.filter((it) => isColored(dim, it.key) && it.value >= grand * 0.02));
  const treemapOption = $derived.by(() => (void store.dark, shape === "treemap" && treemapItems.length ? treemapChart(treemapItems, dim, fmt, grand || 1) : null));
  // Rankings list the top entries too, as many as fit beside the usage chart.
  const RANKED = 8;
  const distributionShown = $derived(shape === "treemap" ? treemapItems.length : shape === "ranked" ? Math.min(RANKED, rows.length) : rows.length);
  const distributionSubtitle = $derived(
    distributionShown < rows.length
      ? t("breakdown.topShown", { metric: t(`metric.${store.metric}`), n: distributionShown, total: rows.length, what: t(`breakdown.what.${dim}` as MessageKey) })
      : t(`metric.${store.metric}`),
  );
  // A moving average of the total as a trend line, as on Trends.
  const average = $derived(trend ? trendAverage(store.bucket, trend.buckets.length) : undefined);

  // Agents: everything outside the main thread is subagent work.
  const subagentShare = $derived.by(() => {
    if (dim !== "agent" || !data.data) return null;
    const share = (r: (typeof rows)[number]) => (store.metric === "cost" ? r.share : r.tokenShare);
    return rows.filter((r) => r.key !== "main").reduce((a, r) => a + share(r), 0);
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t(titles[dim]!)} subtitle={t(`breakdown.subtitle.${dim}` as MessageKey)}>
    {#if dim === "project"}
      <Toggle checked={store.showNoProject} label={t("breakdown.showNoProject")} hint={t("common.noProjectHint")} onchange={(v) => store.setShowNoProject(v)} />
    {/if}
    {#if subagentShare != null}
      <div class="text-right">
        <div class="text-xl font-semibold tracking-tight text-ink">{percent(subagentShare, 1)}</div>
        <div class="text-xs text-muted">{t("skills.subagentShare")}</div>
      </div>
    {/if}
  </PageHeader>
  <ViewGate ready={settled(data, series, ...(dim === "provider" ? [billing] : []))}>

    {#if data.data && rows.length === 0}
      <div class="card"><Empty /></div>
    {:else}
      <div class="grid gap-5 xl:grid-cols-5">
        <Card title={t("chart.distribution")} subtitle={distributionSubtitle} class={shape === "treemap" ? "xl:col-span-5" : "xl:col-span-2"}>
          {#if shape === "treemap"}
            {#if treemapOption}
              <Chart
                option={treemapOption}
                height={300}
                dim={data.loading}
                onclick={(p) => { const key = (p.data as { key?: string } | undefined)?.key; if (key && key !== "__other__") store.setFilter(dim as FilterKey, key); }}
              />
            {/if}
          {:else if shape === "donut"}
            <div class="flex flex-col gap-6">
              <DonutList {items} {dim} format={fmt} onselect={(key) => store.setFilter(dim as FilterKey, key)} loading={data.loading} />
              {#if trend}<MixByWeek ts={trend} {dim} metric={store.metric} />{/if}
            </div>
          {:else}
            <RankedList {rows} {dim} limit={RANKED} filterKey={dim as FilterKey} loading={data.loading} />
          {/if}
        </Card>
        <Card title={t("chart.usageOverTime")} subtitle={t(`metric.${store.metric}`)} class={shape === "treemap" ? "xl:col-span-5" : "xl:col-span-3"}>
          <!-- Beside a distribution it fills the row, however tall the distribution grows. -->
          {#if trend}<UsageChart ts={trend} {dim} bucket={store.bucket} metric={store.metric} {average} height={300} fill={shape !== "treemap"} loading={series.loading} />{/if}
        </Card>
      </div>

      <TableCard
        title={t(`breakdown.table.${dim}` as MessageKey)}
        subtitle={t("breakdown.tableHint")}
        {rows}
        searchText={(r) => `${entityLabel(dim, r.key, r.label)} ${r.key}`}
        sorts={SORTS}
        bind:sortKey
        bind:asc
      >
        {#snippet children(view)}
          <BreakdownTable rows={view.rows} {dim} filterKey={dim as FilterKey} offset={view.offset} limit={view.limit} bind:sortKey bind:asc />
        {/snippet}
      </TableCard>
      {#if dim === "skill"}<p class="text-xs text-muted">{t("breakdown.skillsHint")}</p>{/if}
      {#if dim === "provider" && billing.data?.length}
        <TableCard
          title={t("billing.title")}
          subtitle={t("billing.subtitle")}
          rows={billing.data}
          searchText={(r) => `${billingLabel(r)} ${r.key}`}
          sorts={BILLING_SORTS}
          bind:sortKey={billingSort}
          bind:asc={billingAsc}
        >
          {#snippet children(view)}
            <BillingTable rows={view.rows} offset={view.offset} limit={view.limit} bind:sortKey={billingSort} bind:asc={billingAsc} />
          {/snippet}
        </TableCard>
      {/if}
    {/if}
  </ViewGate>
</div>
