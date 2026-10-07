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
  import BudgetBar from "../components/BudgetBar.svelte";
  import { type ActivityDay, activityStats, daySpan, spanMonths } from "../lib/activity.ts";
  import { apiUrl, settled, useFetch, type Breakdown, type Lines, type Summary, type Tip, type TimeSeries } from "../lib/api.svelte.ts";
  import { breakdownItems, heatMax, seriesLabel, weekHeatmap } from "../lib/charts.ts";
  import { sankeyChart, type FlowRow } from "../lib/sankey.ts";
  import { bucketLabel, compact, integer, metricValue, percent, trimmed, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { seriesRows } from "../lib/export.ts";
  import { store } from "../lib/state.svelte.ts";
  import { tipStore } from "../lib/tips.svelte.ts";

  type Group = "type" | "provider" | "model" | "project";
  let group = $state<Group>("type");

  const summary = useFetch<Summary>(() => apiUrl("/api/summary"));
  const lines = useFetch<Lines>(() => apiUrl("/api/lines"));
  // Token-type split always counts tokens; other groupings follow the global metric.
  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group, metric: group === "type" ? "tokens" : store.metric }));
  const spark = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group: "none", metric: store.metric }));
  const projects = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "project", limit: 8, sort: store.metric }));
  const models = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "model", limit: 8, sort: store.metric }));
  const providers = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "provider", limit: 8, sort: store.metric }));
  const flow = useFetch<FlowRow[]>(() => apiUrl("/api/flow"));
  const heat = useFetch<{ cells: [number, number, number, number][] }>(() => apiUrl("/api/heatmap", { metric: store.metric }));
  const calendar = useFetch<ActivityDay[]>(() => apiUrl("/api/calendar"));
  const span = $derived(daySpan(calendar.data ?? [], store.filters));
  const activity = $derived(calendar.data ? activityStats(calendar.data, span, (d) => (store.metric === "cost" ? d.cost : d.tokens)) : null);
  // The calendar shows two months at a time, the latest first. Paging steps back through the range by two months.
  const CAL_PAGE = 2;
  const calMonths = $derived(spanMonths(span));
  let calBack = $state(0);
  $effect(() => {
    void [span.start, span.end];
    calBack = 0;
  });
  const calShown = $derived(calMonths.slice(Math.max(0, calMonths.length - calBack - CAL_PAGE), calMonths.length - calBack));
  const tips = useFetch<Tip[]>(() => apiUrl("/api/tips"));
  // Read and hidden tips stay on the Tips page only (and none show until it's known which those are).
  const activeTips = $derived(tipStore.loaded ? (tips.data ?? []).filter((tip) => tipStore.status(tip) === "active") : []);

  const s = $derived(summary.data);
  const days = $derived(Math.max(s?.activeDays ?? 1, 1));
  const empty = $derived(s != null && s.messages === 0);
  const sparkValues = $derived(spark.data?.series[0]?.data ?? []);
  const sparkLabels = $derived((spark.data?.buckets ?? []).map((b) => bucketLabel(b, store.bucket)));

  const heatOption = $derived.by(() => (void store.dark, heat.data ? weekHeatmap(heat.data.cells, store.metric) : null));

  const flowOption = $derived.by(() => (void store.dark, flow.data?.length ? sankeyChart(flow.data, store.metric, (v) => metricValue(v, store.metric)) : null));
  // Clicking a named node filters the dashboard by it, "Other" has nothing to filter by.
  function flowClick(p: { data?: unknown }) {
    const d = p.data as { dim?: "provider" | "model" | "project"; key?: string; source?: string } | undefined;
    if (d?.dim && d.key && d.key !== "__other__" && !d.source) store.setFilter(d.dim, d.key);
  }

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
  <ViewGate ready={settled(summary, lines, series, spark, projects, models, providers, flow, heat, calendar, tips)}>

    {#if empty}
      <div class="card"><Empty /></div>
    {:else}
      <!-- KPI row -->
      <!-- Six tiles: two rows of three, one row on very wide screens with the first tile twice as wide. On phones the
           first and last span both columns, so every row is full at each width and no hint is cut short. -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-7">
        <div class="col-span-2 md:col-span-1 2xl:col-span-2">
          <Kpi
            label={store.metric === "cost" ? t("kpi.cost") : t("kpi.tokens")}
            value="…"
            amount={s ? (store.metric === "cost" ? s.cost : s.tokens) : null}
            format={store.metric === "cost" ? usd : compact}
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
          value="…"
          amount={s ? (store.metric === "cost" ? s.tokens : s.cost) : null}
          format={store.metric === "cost" ? compact : usd}
          current={s ? (store.metric === "cost" ? s.tokens : s.cost) : undefined}
          previous={s?.previous ? (store.metric === "cost" ? s.previous.tokens : s.previous.cost) : null}
          hint={s ? t("kpi.perActiveDay", { v: store.metric === "cost" ? compact(s.tokens / days) : usd(s.cost / days) }) : undefined}
        />
        <!-- With no earlier period to compare (All time), each tile shows an average instead of a change. -->
        <Kpi label={t("kpi.sessions")} value="…" amount={s?.sessions} format={compact} current={s?.sessions} previous={s?.previous?.sessions} hint={s ? t("kpi.perActiveDay", { v: trimmed(s.sessions / days) }) : undefined} />
        <Kpi label={t("kpi.prompts")} value="…" amount={s?.prompts} format={compact} current={s?.prompts} previous={s?.previous?.prompts} hint={s ? t("kpi.perSession", { v: trimmed(s.prompts / Math.max(s.sessions, 1)) }) : undefined} />
        <Kpi label={t("kpi.cacheHit")} value="…" amount={s?.cacheHitRate} format={(v) => percent(v, 1)} hint={s ? `${t("kpi.costPerPrompt")}: ${usd(s.costPerPrompt)}` : undefined} />
        <!-- What the spend bought: lines changed, with the cost per 100 of them rather than a change on the period before. -->
        <div class="col-span-2 md:col-span-1">
          <Kpi
            label={t("lines.kpi")}
            value="…"
            amount={lines.data?.total.changed}
            format={compact}
            hint={lines.data ? (lines.data.total.costPer100 != null ? t("lines.per100", { v: usd(lines.data.total.costPer100) }) : t("lines.none")) : undefined}
          />
        </div>
      </div>

      <BudgetBar />

      <!-- Usage over time -->
      <Card title={t("chart.usageOverTime")} subtitle={group === "type" ? t("metric.tokens") : t(`metric.${store.metric}`)} exportName="usage-over-time" exportRows={() => (series.data ? seriesRows(series.data) : [])}>
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

      {#if flowOption}
        <Card title={t("chart.flow")} subtitle={t("chart.flowHint", { metric: t(`metric.${store.metric}`) })}>
          <Chart option={flowOption} height={380} dim={flow.loading} onclick={flowClick} />
        </Card>
      {/if}

      <div class="grid gap-5 xl:grid-cols-2">
        <Card title={t("chart.topProjects")} exportName="projects" exportRows={() => projects.data?.rows ?? []}>
          {#snippet actions()}{@render more("#/projects", t("nav.projects"))}{/snippet}
          {#snippet table()}{#if projects.data}<BreakdownTable rows={projects.data.rows} dim="project" filterKey="project" compactCols />{/if}{/snippet}
          {#if projects.data}<RankedList rows={projects.data.rows.filter((r) => store.showNoProject || r.key !== "(none)")} dim="project" filterKey="project" loading={projects.loading} />{/if}
        </Card>
        <Card title={t("chart.topModels")} exportName="models" exportRows={() => models.data?.rows ?? []}>
          {#snippet actions()}{@render more("#/models", t("nav.models"))}{/snippet}
          {#snippet table()}{#if models.data}<BreakdownTable rows={models.data.rows} dim="model" filterKey="model" compactCols />{/if}{/snippet}
          {#if models.data}<RankedList rows={models.data.rows} dim="model" filterKey="model" loading={models.loading} />{/if}
        </Card>
      </div>

      <!-- Side by side only once the split has room for its legend beside the donut: a narrower split stacks into a tall card,
           and the hour heatmap beside it would stretch into tall, thin cells. The row's own width decides, so a collapsed
           sidebar counts. -->
      <div class="@container">
        <div class="grid gap-5 @6xl:grid-cols-5">
          <Card title={t("chart.providerSplit")} subtitle={t("chart.providerSplitHint", { metric: t(`metric.${store.metric}`) })} class="@6xl:col-span-2" exportName="providers" exportRows={() => providers.data?.rows ?? []}>
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
          <Card title={t("chart.activity")} subtitle={t("chart.activityHint")} class="@6xl:col-span-3">
            {#snippet actions()}{#if heat.data}<HeatLegend max={metricValue(heatMax(heat.data.cells), store.metric)} />{/if}{/snippet}
            {#if heatOption}<Chart option={heatOption} height={240} fill dim={heat.loading} />{/if}
          </Card>
        </div>
      </div>

      {#if !calendar.data || calendar.data.length}
        <!-- Same columns as the row above: the rhythm under the provider split, the calendar under the hour heatmap. -->
        <div class="@container">
          <div class="grid gap-5 @6xl:grid-cols-5">
            <Card title={t("calendar.rhythm")} subtitle={t("calendar.rhythmHint")} class="@6xl:col-span-2">
              {#if activity}<ActivityStats stats={activity} loading={calendar.loading} />{/if}
            </Card>
            <Card title={t("chart.calendar")} subtitle={t("calendar.hint")} class="@6xl:col-span-3">
              {#snippet actions()}{#if activity}<HeatLegend max={metricValue(activity.busiest ? (store.metric === "cost" ? activity.busiest.cost : activity.busiest.tokens) : 0, store.metric)} />{/if}{/snippet}
              {#if calendar.data && activity}<DailyCalendar
                  days={calendar.data}
                  {span}
                  visible={calShown}
                  peak={activity.busiest?.day}
                  loading={calendar.loading}
                  onearlier={calMonths.length > CAL_PAGE ? (calBack + CAL_PAGE < calMonths.length ? () => (calBack = Math.min(calBack + CAL_PAGE, calMonths.length - CAL_PAGE)) : null) : undefined}
                  onlater={calMonths.length > CAL_PAGE ? (calBack > 0 ? () => (calBack = Math.max(0, calBack - CAL_PAGE)) : null) : undefined}
                />{/if}
            </Card>
          </div>
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
