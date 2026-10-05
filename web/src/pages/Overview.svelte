<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import TipCard from "../components/TipCard.svelte";
  import BreakdownTable from "../components/BreakdownTable.svelte";
  import { apiUrl, useFetch, type Breakdown, type Summary, type Tip, type TimeSeries } from "../lib/api.svelte.ts";
  import { calendarHeatmap, rankedBars, seriesLabel, timeSeriesChart, weekHeatmap } from "../lib/charts.ts";
  import { bucketLabel, compact, metricValue, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  type Group = "type" | "provider" | "model" | "project";
  let group = $state<Group>("type");

  const summary = useFetch<Summary>(() => apiUrl("/api/summary"));
  // Token-type split always counts tokens; other groupings follow the global metric.
  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group, metric: group === "type" ? "tokens" : store.metric }));
  const spark = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group: "none", metric: store.metric }));
  const projects = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "project", limit: 8, sort: store.metric }));
  const models = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "model", limit: 8, sort: store.metric }));
  const providers = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "provider", limit: 8, sort: store.metric }));
  const heat = useFetch<{ cells: [number, number, number, number][] }>(() => apiUrl("/api/heatmap", { metric: store.metric }));
  const calendar = useFetch<{ day: string; tokens: number; cost: number }[]>(() => apiUrl("/api/calendar"));
  const tips = useFetch<Tip[]>(() => apiUrl("/api/tips"));

  const s = $derived(summary.data);
  const empty = $derived(s != null && s.messages === 0);
  const sparkValues = $derived(spark.data?.series[0]?.data ?? []);

  const seriesOption = $derived.by(() => {
    void store.dark;
    return series.data ? timeSeriesChart(series.data, { dim: group, metric: store.metric, bucket: store.bucket, valueKind: group === "type" ? "tokens" : store.metric }) : null;
  });
  const projectsOption = $derived.by(() => (void store.dark, projects.data ? rankedBars(projects.data.rows, { dim: "project", metric: store.metric, limit: 8 }) : null));
  const modelsOption = $derived.by(() => (void store.dark, models.data ? rankedBars(models.data.rows, { dim: "model", metric: store.metric, limit: 8 }) : null));
  const providersOption = $derived.by(() => (void store.dark, providers.data ? rankedBars(providers.data.rows, { dim: "provider", metric: store.metric }) : null));
  const heatOption = $derived.by(() => (void store.dark, heat.data ? weekHeatmap(heat.data.cells, store.metric) : null));
  const calendarOption = $derived.by(() => (void store.dark, calendar.data && calendar.data.length > 14 ? calendarHeatmap(calendar.data, store.metric) : null));

  const groups: { value: Group; label: string }[] = $derived([
    { value: "type", label: t("trends.type") },
    { value: "provider", label: t("filter.provider") },
    { value: "model", label: t("filter.model") },
    { value: "project", label: t("filter.project") },
  ]);
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("nav.overview")} subtitle={t("app.tagline")} />

  {#if empty}
    <div class="card"><Empty /></div>
  {:else}
    <!-- KPI row -->
    <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <div class="col-span-2 md:col-span-1 xl:col-span-2">
        <Kpi
          hero
          label={store.metric === "cost" ? t("kpi.cost") : t("kpi.tokens")}
          value={s ? (store.metric === "cost" ? usd(s.cost) : compact(s.tokens)) : "…"}
          current={s ? (store.metric === "cost" ? s.cost : s.tokens) : undefined}
          previous={s?.previous ? (store.metric === "cost" ? s.previous.cost : s.previous.tokens) : null}
          trend={sparkValues}
          hint={s && s.estimatedCost > 0 ? t("kpi.estimatedNote", { share: percent(s.estimatedCost / Math.max(s.cost, 1e-9)) }) : undefined}
        />
      </div>
      <Kpi
        label={store.metric === "cost" ? t("kpi.tokens") : t("kpi.cost")}
        value={s ? (store.metric === "cost" ? compact(s.tokens) : usd(s.cost)) : "…"}
        current={s ? (store.metric === "cost" ? s.tokens : s.cost) : undefined}
        previous={s?.previous ? (store.metric === "cost" ? s.previous.tokens : s.previous.cost) : null}
      />
      <Kpi label={t("kpi.sessions")} value={s ? compact(s.sessions) : "…"} current={s?.sessions} previous={s?.previous?.sessions} />
      <Kpi label={t("kpi.prompts")} value={s ? compact(s.prompts) : "…"} current={s?.prompts} previous={s?.previous?.prompts} />
      <Kpi label={t("kpi.cacheHit")} value={s ? percent(s.cacheHitRate, 1) : "…"} hint={s ? `${t("kpi.costPerPrompt")}: ${usd(s.costPerPrompt)}` : undefined} />
    </div>

    <!-- Usage over time -->
    <Card title={t("chart.usageOverTime")} subtitle={group === "type" ? t("metric.tokens") : t(`metric.${store.metric}`)}>
      {#snippet actions()}
        <div class="seg" role="group">
          {#each groups as g (g.value)}
            <button aria-pressed={group === g.value} onclick={() => (group = g.value)}>{g.label}</button>
          {/each}
        </div>
      {/snippet}
      {#snippet table()}
        {#if series.data}
          <table class="data">
            <thead><tr><th>{t("col.time")}</th>{#each series.data.series as se (se.key)}<th class="num">{seriesLabel(group, se)}</th>{/each}</tr></thead>
            <tbody>
              {#each series.data.buckets as b, i (b)}
                <tr><td>{bucketLabel(b, store.bucket)}</td>{#each series.data.series as se (se.key)}<td class="num">{metricValue(se.data[i] ?? 0, group === "type" ? "tokens" : store.metric, false)}</td>{/each}</tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {/snippet}
      {#if seriesOption}<Chart option={seriesOption} height={300} dim={series.loading} />{/if}
    </Card>

    <div class="grid gap-5 xl:grid-cols-2">
      <Card title={t("chart.topProjects")}>
        {#snippet actions()}<a href="#/projects" class="text-xs font-medium text-accent-ink hover:underline">{t("nav.projects")} →</a>{/snippet}
        {#snippet table()}{#if projects.data}<BreakdownTable rows={projects.data.rows} dim="project" filterKey="project" compactCols />{/if}{/snippet}
        {#if projectsOption}<Chart option={projectsOption} height={Math.max(120, Math.min(8, projects.data?.rows.length ?? 0) * 36)} dim={projects.loading} onclick={(p) => { const r = projects.data?.rows.slice(0, 8).reverse()[p.dataIndex]; if (r) store.setFilter("project", r.key); }} />{/if}
      </Card>
      <Card title={t("chart.topModels")}>
        {#snippet actions()}<a href="#/models" class="text-xs font-medium text-accent-ink hover:underline">{t("nav.models")} →</a>{/snippet}
        {#snippet table()}{#if models.data}<BreakdownTable rows={models.data.rows} dim="model" filterKey="model" compactCols />{/if}{/snippet}
        {#if modelsOption}<Chart option={modelsOption} height={Math.max(120, Math.min(8, models.data?.rows.length ?? 0) * 36)} dim={models.loading} onclick={(p) => { const r = models.data?.rows.slice(0, 8).reverse()[p.dataIndex]; if (r) store.setFilter("model", r.key); }} />{/if}
      </Card>
    </div>

    <div class="grid gap-5 xl:grid-cols-5">
      <Card title={t("chart.providerSplit")} class="xl:col-span-2">
        {#snippet table()}{#if providers.data}<BreakdownTable rows={providers.data.rows} dim="provider" filterKey="provider" compactCols />{/if}{/snippet}
        {#if providersOption}<Chart option={providersOption} height={Math.max(110, (providers.data?.rows.length ?? 2) * 40)} dim={providers.loading} />{/if}
      </Card>
      <Card title={t("chart.activity")} subtitle={t("chart.activityHint")} class="xl:col-span-3">
        {#if heatOption}<Chart option={heatOption} height={250} dim={heat.loading} />{/if}
      </Card>
    </div>

    {#if calendarOption}
      <Card title={t("chart.calendar")}>
        <Chart option={calendarOption} height={150} dim={calendar.loading} />
      </Card>
    {/if}

    {#if tips.data && tips.data.length}
      <div>
        <div class="mb-2 flex items-center justify-between">
          <h2 class="text-sm font-semibold">{t("nav.tips")}</h2>
          <button class="text-xs font-medium text-accent-ink hover:underline" onclick={() => navigate("tips")}>{t("tips.open")} →</button>
        </div>
        <div class="grid gap-3 lg:grid-cols-3">
          {#each tips.data.slice(0, 3) as tip (tip.id)}<TipCard {tip} />{/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
