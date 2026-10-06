<script lang="ts">
  import Link from "../components/Link.svelte";
  import { ArrowRight } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import ActivityStats from "../components/ActivityStats.svelte";
  import DailyCalendar from "../components/DailyCalendar.svelte";
  import DonutList from "../components/DonutList.svelte";
  import Empty from "../components/Empty.svelte";
  import HeatLegend from "../components/HeatLegend.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import RankedList from "../components/RankedList.svelte";
  import TipCard from "../components/TipCard.svelte";
  import UsageChart from "../components/UsageChart.svelte";
  import BreakdownTable from "../components/BreakdownTable.svelte";
  import { type ActivityDay, activityStats, daySpan } from "../lib/activity.ts";
  import { apiUrl, settled, useFetch, type Breakdown, type Summary, type Tip, type TimeSeries } from "../lib/api.svelte.ts";
  import { breakdownItems, heatMax, seriesLabel, weekHeatmap } from "../lib/charts.ts";
  import { bucketLabel, compact, integer, metricValue, percent, trimmed, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import { tipStore } from "../lib/tips.svelte.ts";

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
  const calendar = useFetch<ActivityDay[]>(() => apiUrl("/api/calendar"));
  const span = $derived(daySpan(calendar.data ?? [], store.filters));
  const activity = $derived(calendar.data ? activityStats(calendar.data, span, (d) => (store.metric === "cost" ? d.cost : d.tokens)) : null);
  const tips = useFetch<Tip[]>(() => apiUrl("/api/tips"));
  // Read and hidden tips stay on the Tips page only (and none show until it's known which those are).
  const activeTips = $derived(tipStore.loaded ? (tips.data ?? []).filter((tip) => tipStore.status(tip) === "active") : []);

  const s = $derived(summary.data);
  const days = $derived(Math.max(s?.activeDays ?? 1, 1));
  const empty = $derived(s != null && s.messages === 0);
  const sparkValues = $derived(spark.data?.series[0]?.data ?? []);
  const sparkLabels = $derived((spark.data?.buckets ?? []).map((b) => bucketLabel(b, store.bucket)));

  const heatOption = $derived.by(() => (void store.dark, heat.data ? weekHeatmap(heat.data.cells, store.metric) : null));

  const groups: { value: Group; label: string }[] = $derived([
    { value: "type", label: t("trends.type") },
    { value: "provider", label: t("filter.provider") },
    { value: "model", label: t("filter.model") },
    { value: "project", label: t("filter.project") },
  ]);
</script>

{#snippet more(to: string, label: string)}
  <Link {to} class="inline-flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline">{label}<ArrowRight size={12} /></Link>
{/snippet}

<div class="flex flex-col gap-5">
  <PageHeader title={t("nav.overview")} subtitle={t("app.tagline")} />
  <ViewGate ready={settled(summary, series, spark, projects, models, providers, heat, calendar, tips)}>

    {#if empty}
      <div class="card"><Empty /></div>
    {:else}
      <!-- KPI row -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div class="col-span-2 md:col-span-1 xl:col-span-2">
          <Kpi
            label={store.metric === "cost" ? t("kpi.cost") : t("kpi.tokens")}
            value={s ? (store.metric === "cost" ? usd(s.cost) : compact(s.tokens)) : "…"}
            current={s ? (store.metric === "cost" ? s.cost : s.tokens) : undefined}
            previous={s?.previous ? (store.metric === "cost" ? s.previous.cost : s.previous.tokens) : null}
            trend={sparkValues}
            trendLabels={sparkLabels}
            trendFormat={(v) => metricValue(v, store.metric)}
            hint={s && s.estimatedCost > 0 ? t("kpi.estimatedNote", { share: percent(s.estimatedCost / Math.max(s.cost, 1e-9)) }) : s ? t("kpi.acrossDays", { n: integer(s.activeDays) }) : undefined}
          />
        </div>
        <Kpi
          label={store.metric === "cost" ? t("kpi.tokens") : t("kpi.cost")}
          value={s ? (store.metric === "cost" ? compact(s.tokens) : usd(s.cost)) : "…"}
          current={s ? (store.metric === "cost" ? s.tokens : s.cost) : undefined}
          previous={s?.previous ? (store.metric === "cost" ? s.previous.tokens : s.previous.cost) : null}
          hint={s ? t("kpi.perActiveDay", { v: store.metric === "cost" ? compact(s.tokens / days) : usd(s.cost / days) }) : undefined}
        />
        <!-- With no earlier period to compare (All time), each tile shows an average instead of a change. -->
        <Kpi label={t("kpi.sessions")} value={s ? compact(s.sessions) : "…"} current={s?.sessions} previous={s?.previous?.sessions} hint={s ? t("kpi.perActiveDay", { v: trimmed(s.sessions / days) }) : undefined} />
        <Kpi label={t("kpi.prompts")} value={s ? compact(s.prompts) : "…"} current={s?.prompts} previous={s?.previous?.prompts} hint={s ? t("kpi.perSession", { v: trimmed(s.prompts / Math.max(s.sessions, 1)) }) : undefined} />
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
        {#if series.data}
          <UsageChart ts={series.data} dim={group} bucket={store.bucket} metric={store.metric} valueKind={group === "type" ? "tokens" : store.metric} height={300} loading={series.loading} />
        {/if}
      </Card>

      <div class="grid gap-5 xl:grid-cols-2">
        <Card title={t("chart.topProjects")}>
          {#snippet actions()}{@render more("#/projects", t("nav.projects"))}{/snippet}
          {#snippet table()}{#if projects.data}<BreakdownTable rows={projects.data.rows} dim="project" filterKey="project" compactCols />{/if}{/snippet}
          {#if projects.data}<RankedList rows={projects.data.rows.filter((r) => store.showNoProject || r.key !== "(none)")} dim="project" filterKey="project" loading={projects.loading} />{/if}
        </Card>
        <Card title={t("chart.topModels")}>
          {#snippet actions()}{@render more("#/models", t("nav.models"))}{/snippet}
          {#snippet table()}{#if models.data}<BreakdownTable rows={models.data.rows} dim="model" filterKey="model" compactCols />{/if}{/snippet}
          {#if models.data}<RankedList rows={models.data.rows} dim="model" filterKey="model" loading={models.loading} />{/if}
        </Card>
      </div>

      <div class="grid gap-5 xl:grid-cols-5">
        <Card title={t("chart.providerSplit")} subtitle={t("chart.providerSplitHint", { metric: t(`metric.${store.metric}`) })} class="xl:col-span-2">
          {#snippet table()}{#if providers.data}<BreakdownTable rows={providers.data.rows} dim="provider" filterKey="provider" compactCols />{/if}{/snippet}
          {#if providers.data}
            <DonutList
              dim="provider"
              items={breakdownItems(providers.data.rows, "provider", store.metric)}
              format={(v) => metricValue(v, store.metric)}
              onselect={(key) => store.setFilter("provider", key)}
              loading={providers.loading}
              size={216}
            />
          {/if}
        </Card>
        <Card title={t("chart.activity")} subtitle={t("chart.activityHint")} class="xl:col-span-3">
          {#snippet actions()}{#if heat.data}<HeatLegend max={metricValue(heatMax(heat.data.cells), store.metric)} />{/if}{/snippet}
          {#if heatOption}<Chart option={heatOption} height={240} dim={heat.loading} />{/if}
        </Card>
      </div>

      {#if !calendar.data || calendar.data.length}
        <!-- Same columns as the row above: the rhythm under the provider split, the calendar under the hour heatmap. -->
        <div class="grid gap-5 xl:grid-cols-5">
          <Card title={t("calendar.rhythm")} subtitle={t("calendar.rhythmHint")} class="xl:col-span-2">
            {#if activity}<ActivityStats stats={activity} loading={calendar.loading} />{/if}
          </Card>
          <Card title={t("chart.calendar")} subtitle={t("calendar.hint")} class="xl:col-span-3">
            {#snippet actions()}{#if activity}<HeatLegend max={metricValue(activity.busiest ? (store.metric === "cost" ? activity.busiest.cost : activity.busiest.tokens) : 0, store.metric)} />{/if}{/snippet}
            {#if calendar.data && activity}<DailyCalendar days={calendar.data} {span} peak={activity.busiest?.day} loading={calendar.loading} />{/if}
          </Card>
        </div>
      {/if}

      {#if activeTips.length}
        <div>
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold">{t("nav.tips")}</h2>
            {@render more("#/tips", t("tips.viewAll"))}
          </div>
          <div class="grid gap-3 lg:grid-cols-3">
            {#each activeTips.slice(0, 3) as tip (tip.key)}<TipCard {tip} />{/each}
          </div>
        </div>
      {/if}
    {/if}
  </ViewGate>
</div>
