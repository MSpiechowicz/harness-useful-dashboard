<script lang="ts">
  import { ChartArea, ChartColumn } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import UsageChart from "../components/UsageChart.svelte";
  import { apiUrl, settled, useFetch, type LinesSeries, type Summary, type TimeSeries } from "../lib/api.svelte.ts";
  import { cumulativeChart, seriesLabel, timeSeriesChart, trendAverage } from "../lib/charts.ts";
  import { bucketLabel, compact, dayWithYear, days, integer, metricValue, usd } from "../lib/format.ts";
  import { seriesRows } from "../lib/export.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  type Group = "none" | "type" | "provider" | "model" | "project" | "user" | "agent" | "skill";
  type Bucket = "hour" | "day" | "week" | "month";
  let group = $state<Group>("provider");
  let bucket = $state<Bucket | "auto">("auto");
  let kind = $state<"bar" | "area">("bar");
  const buckets = ["auto", "hour", "day", "week", "month"] as const;

  const effBucket = $derived(bucket === "auto" ? store.bucket : bucket);
  const valueKind = $derived(group === "type" ? "tokens" : store.metric);

  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: effBucket, group, metric: valueKind }));
  const daily = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: "day", group: "none", metric: store.metric }));
  const summary = useFetch<Summary>(() => apiUrl("/api/summary"));

  const totalsPerBucket = $derived(series.data ? series.data.buckets.map((_, i) => series.data!.series.reduce((a, s) => a + (s.data[i] ?? 0), 0)) : []);

  // A moving average of the total as a trend line, over days, weeks or months alike.
  const average = $derived(series.data ? trendAverage(effBucket, series.data.buckets.length) : undefined);
  // The running total is split by the chosen grouping; "Total" splits it by provider, so it always shows who it came from.
  const cumGroup = $derived(group === "none" ? "provider" : group);
  const cumulative = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: "day", group: cumGroup, metric: valueKind }));
  const cumTotal = $derived(cumulative.data ? cumulative.data.series.reduce((a, s) => a + s.data.reduce((x, y) => x + (y ?? 0), 0), 0) : null);
  const cumOption = $derived.by(() => (void store.dark, cumulative.data ? cumulativeChart(cumulative.data, { dim: cumGroup, metric: valueKind, bucket: "day" }) : null));

  const stats = $derived.by(() => {
    const d = daily.data?.series[0]?.data ?? [];
    const buckets = daily.data?.buckets ?? [];
    if (!d.length) return null;
    let peak = 0;
    d.forEach((v, i) => v > d[peak]! && (peak = i));
    const active = d.filter((v) => v > 0);
    const avg = active.length ? active.reduce((a, b) => a + b, 0) / active.length : 0;
    const last14 = d.slice(-14);
    const projection = (last14.reduce((a, b) => a + b, 0) / Math.max(1, last14.length)) * 30;
    return { peakDay: buckets[peak]!, peakValue: d[peak]!, avg, projection };
  });

  // Lines the agents changed per bucket: one neutral series, as the cost on a branch's page.
  const lines = useFetch<LinesSeries>(() => apiUrl("/api/lines/series", { bucket: effBucket }));
  const linesTotal = $derived(lines.data ? lines.data.added.reduce((a, b) => a + b, 0) + lines.data.removed.reduce((a, b) => a + b, 0) : 0);
  const linesOption = $derived.by(() => {
    void store.dark;
    const x = lines.data;
    if (!x?.buckets.length || !linesTotal) return null;
    const data = x.buckets.map((_, i) => (x.added[i] ?? 0) + (x.removed[i] ?? 0));
    return timeSeriesChart({ buckets: x.buckets, series: [{ key: "all", name: t("lines.kpi"), data }] }, { dim: "none", metric: "tokens", bucket: effBucket, kind });
  });

  const groups: Group[] = ["none", "type", "provider", "model", "project", "user", "agent", "skill"];
  function groupLabel(g: Group): string {
    if (g === "none") return t("trends.none");
    if (g === "type") return t("trends.type");
    return t(`filter.${g}` as "filter.provider");
  }
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("trends.title")} subtitle={t("trends.subtitle")} />
  <ViewGate ready={settled(series, daily, summary, cumulative, lines)}>

    {#if summary.data && summary.data.messages === 0}
      <div class="card"><Empty /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <!-- With no earlier period to compare (All time), the tile is the total so far, and since when. -->
        <Kpi
          label={summary.data && !summary.data.previous ? t("trends.total") : t("trends.change")}
          hint={summary.data?.firstTs ? t("trends.since", { date: dayWithYear(summary.data.firstTs) }) : undefined}
          value="…"
          amount={summary.data ? (store.metric === "cost" ? summary.data.cost : summary.data.tokens) : null}
          format={(v) => metricValue(v, store.metric)}
          current={summary.data ? (store.metric === "cost" ? summary.data.cost : summary.data.tokens) : undefined}
          previous={summary.data?.previous ? (store.metric === "cost" ? summary.data.previous.cost : summary.data.previous.tokens) : null}
        />
        <Kpi label={t("trends.peakDay")} value="…" amount={stats?.peakValue} format={(v) => metricValue(v, store.metric)} hint={stats ? bucketLabel(stats.peakDay, "day") : undefined} />
        <Kpi label={t("trends.avgPerDay")} value="…" amount={stats?.avg} format={(v) => metricValue(v, store.metric)} hint={summary.data ? days(summary.data.activeDays) : undefined} />
        <Kpi label={t("trends.projection")} value="…" amount={stats?.projection} format={(v) => metricValue(v, store.metric)} hint={t("trends.projectionHint")} />
      </div>

      <Card title={t("chart.usageOverTime")} subtitle={t(`metric.${valueKind}`)} exportName="usage-over-time" exportRows={() => (series.data ? seriesRows(series.data, true) : [])}>
        {#snippet actions()}
          <Dropdown prefix label={t("trends.groupBy")} bind:value={group} options={groups.map((g) => ({ value: g, label: groupLabel(g) }))} />
          <Dropdown prefix label={t("trends.interval")} bind:value={bucket} options={buckets.map((b) => ({ value: b, label: b === "auto" ? `${t("bucket.auto")} (${t(`bucket.${store.bucket}`)})` : t(`bucket.${b}`) }))} />
          <div class="seg" role="group" aria-label={t("chart.style")}>
            <button aria-pressed={kind === "bar"} aria-label={t("chart.bars")} title={t("chart.bars")} onclick={() => (kind = "bar")}><ChartColumn size={13} /></button>
            <button aria-pressed={kind === "area"} aria-label={t("chart.area")} title={t("chart.area")} onclick={() => (kind = "area")}><ChartArea size={13} /></button>
          </div>
        {/snippet}
        {#snippet table()}
          {#if series.data}
            <table class="data" use:resizableColumns={"trends-1"}>
              <thead><tr><th>{t("col.time")}</th>{#each series.data.series as se (se.key)}<th class="num">{seriesLabel(group, se)}</th>{/each}<th class="num">{t("common.total")}</th></tr></thead>
              <tbody>
                {#each series.data.buckets as b, i (b)}
                  <tr>
                    <td>{bucketLabel(b, effBucket)}</td>
                    {#each series.data.series as se (se.key)}<td class="num">{metricValue(se.data[i] ?? 0, valueKind, false)}</td>{/each}
                    <td class="num font-medium">{metricValue(totalsPerBucket[i] ?? 0, valueKind, false)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {/snippet}
        {#if series.data}
          <UsageChart ts={series.data} dim={group} bucket={effBucket} metric={store.metric} {valueKind} {kind} {average} height={380} loading={series.loading} />
        {/if}
      </Card>

      <Card title={t("chart.cumulative")} subtitle={t(`metric.${valueKind}`)}>
        {#snippet actions()}
          {#if cumTotal != null}<span class="text-2xl font-semibold tracking-tight text-ink tabular">{metricValue(cumTotal, valueKind)}</span>{/if}
        {/snippet}
        {#if cumOption}<Chart option={cumOption} height={300} dim={cumulative.loading} />{/if}
      </Card>

      {#if linesOption && lines.data}
        {@const x = lines.data}
        <Card title={t("lines.title")} subtitle={t("lines.trendHint")} exportName="lines-over-time" exportRows={() => x.buckets.map((b, i) => ({ bucket: b, added: x.added[i], removed: x.removed[i], cost: x.cost[i] }))}>
          {#snippet actions()}
            <span class="text-2xl font-semibold tracking-tight text-ink tabular">{compact(linesTotal)}</span>
          {/snippet}
          {#snippet table()}
            <table class="data" use:resizableColumns={"trends-2"}>
              <thead><tr><th>{t("col.time")}</th><th class="num">{t("col.added")}</th><th class="num">{t("col.removed")}</th><th class="num">{t("col.cost")}</th><th class="num">{t("col.per100")}</th></tr></thead>
              <tbody>
                {#each x.buckets as b, i (b)}
                  {@const changed = (x.added[i] ?? 0) + (x.removed[i] ?? 0)}
                  <tr>
                    <td>{bucketLabel(b, effBucket)}</td>
                    <td class="num">{integer(x.added[i])}</td>
                    <td class="num">{integer(x.removed[i])}</td>
                    <td class="num">{usd(x.cost[i])}</td>
                    <td class="num">{changed ? usd(((x.cost[i] ?? 0) / changed) * 100) : "–"}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
          <Chart option={linesOption} height={260} dim={lines.loading} />
        </Card>
      {/if}
    {/if}
  </ViewGate>
</div>
