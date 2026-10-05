<script lang="ts">
  import BreakdownTable from "../components/BreakdownTable.svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch, type Breakdown, type TimeSeries } from "../lib/api.svelte.ts";
  import { rankedBars, timeSeriesChart } from "../lib/charts.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";

  let { dim }: { dim: "project" | "model" | "provider" | "user" | "skill" | "agent" } = $props();

  const titles: Record<string, MessageKey> = {
    project: "nav.projects", model: "nav.models", provider: "nav.providers", user: "nav.users", skill: "skills.skills", agent: "skills.agents",
  };

  const data = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim, limit: 200, sort: store.metric }));
  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group: dim, metric: store.metric }));

  // Skills: drop turns without an active skill so the chart is about skills only.
  const rows = $derived((data.data?.rows ?? []).filter((r) => dim !== "skill" || r.key !== "(none)"));
  const barsOption = $derived.by(() => (void store.dark, rows.length ? rankedBars(rows, { dim, metric: store.metric, limit: 12 }) : null));
  const seriesOption = $derived.by(() => {
    void store.dark;
    if (!series.data) return null;
    const d = dim === "skill" ? { ...series.data, series: series.data.series.filter((s) => s.key !== "(none)") } : series.data;
    return timeSeriesChart(d, { dim, metric: store.metric, bucket: store.bucket });
  });
  const barsHeight = $derived(Math.max(140, Math.min(12, rows.length) * 34));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t(titles[dim]!)} subtitle={t(`breakdown.subtitle.${dim}` as MessageKey)} />

  {#if data.data && rows.length === 0}
    <div class="card"><Empty /></div>
  {:else}
    <div class="grid gap-5 xl:grid-cols-5">
      <Card title={t("chart.distribution")} subtitle={t(`metric.${store.metric}`)} class="xl:col-span-2">
        {#if barsOption}
          <Chart option={barsOption} height={barsHeight} dim={data.loading} onclick={(p) => { const r = rows.slice(0, 12).reverse()[p.dataIndex]; if (r) store.setFilter(dim as FilterKey, r.key); }} />
        {/if}
      </Card>
      <Card title={t("chart.trend")} subtitle={t(`metric.${store.metric}`)} class="xl:col-span-3">
        {#if seriesOption}<Chart option={seriesOption} height={Math.max(barsHeight, 300)} dim={series.loading} />{/if}
      </Card>
    </div>

    <Card pad={false}>
      <div class="max-h-[640px] overflow-auto">
        <BreakdownTable {rows} {dim} filterKey={dim as FilterKey} />
      </div>
    </Card>
    {#if dim === "skill"}<p class="text-xs text-muted">{t("breakdown.skillsHint")}</p>{/if}
  {/if}
</div>
