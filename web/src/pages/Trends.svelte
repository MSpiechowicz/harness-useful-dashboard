<script lang="ts">
  import { ChartArea, ChartColumn } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch, type Summary, type TimeSeries } from "../lib/api.svelte.ts";
  import { cumulativeLine, seriesLabel, timeSeriesChart } from "../lib/charts.ts";
  import { cssVar } from "../lib/colors.svelte.ts";
  import { bucketLabel, metricValue } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  type Group = "none" | "type" | "provider" | "model" | "project" | "user" | "agent" | "skill";
  type Bucket = "hour" | "day" | "week" | "month";
  let group = $state<Group>("provider");
  let bucket = $state<Bucket | "auto">("auto");
  let kind = $state<"bar" | "area">("bar");

  const effBucket = $derived(bucket === "auto" ? store.bucket : bucket);
  const valueKind = $derived(group === "type" ? "tokens" : store.metric);

  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: effBucket, group, metric: valueKind }));
  const daily = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: "day", group: "none", metric: store.metric }));
  const summary = useFetch<Summary>(() => apiUrl("/api/summary"));

  const totalsPerBucket = $derived(series.data ? series.data.buckets.map((_, i) => series.data!.series.reduce((a, s) => a + (s.data[i] ?? 0), 0)) : []);

  const mainOption = $derived.by(() => {
    void store.dark;
    const d = series.data;
    if (!d) return null;
    const opt = timeSeriesChart(d, { dim: group, metric: store.metric, bucket: effBucket, kind, valueKind }) as Record<string, any>;
    // 7-bucket moving average of the total, drawn as a thin ink line on the same axis.
    if (effBucket === "day" && d.buckets.length >= 14) {
      const avg = totalsPerBucket.map((_, i) => {
        const win = totalsPerBucket.slice(Math.max(0, i - 6), i + 1);
        return win.reduce((a, b) => a + b, 0) / win.length;
      });
      opt.series.push({ name: t("chart.movingAvg"), type: "line", data: avg, showSymbol: false, smooth: 0.3, lineStyle: { width: 2, color: cssVar("--ink-2") }, color: cssVar("--ink-2"), z: 10, tooltip: { show: false } });
      if (opt.legend) opt.legend.data = [...opt.legend.data, t("chart.movingAvg")];
    }
    return opt;
  });
  const cumOption = $derived.by(() => (void store.dark, daily.data ? cumulativeLine(daily.data, store.metric, "day") : null));

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

  const groups: Group[] = ["none", "type", "provider", "model", "project", "user", "agent", "skill"];
  function groupLabel(g: Group): string {
    if (g === "none") return t("trends.none");
    if (g === "type") return t("trends.type");
    return t(`filter.${g}` as "filter.provider");
  }
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("trends.title")} />

  {#if summary.data && summary.data.messages === 0}
    <div class="card"><Empty /></div>
  {:else}
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi
        label={t("trends.change")}
        value={summary.data ? metricValue(store.metric === "cost" ? summary.data.cost : summary.data.tokens, store.metric) : "…"}
        current={summary.data ? (store.metric === "cost" ? summary.data.cost : summary.data.tokens) : undefined}
        previous={summary.data?.previous ? (store.metric === "cost" ? summary.data.previous.cost : summary.data.previous.tokens) : null}
      />
      <Kpi label={t("trends.peakDay")} value={stats ? metricValue(stats.peakValue, store.metric) : "…"} hint={stats ? bucketLabel(stats.peakDay, "day") : undefined} />
      <Kpi label={t("trends.avgPerDay")} value={stats ? metricValue(stats.avg, store.metric) : "…"} hint={summary.data ? t("common.days", { n: summary.data.activeDays }) : undefined} />
      <Kpi label={t("trends.projection")} value={stats ? metricValue(stats.projection, store.metric) : "…"} />
    </div>

    <Card title={t("chart.usageOverTime")} subtitle={t(`metric.${valueKind}`)}>
      {#snippet actions()}
        <select class="input" bind:value={group} aria-label={t("trends.groupBy")}>
          {#each groups as g (g)}<option value={g}>{t("trends.groupBy")}: {groupLabel(g)}</option>{/each}
        </select>
        <div class="seg" role="group">
          {#each ["auto", "hour", "day", "week", "month"] as b (b)}
            <button aria-pressed={bucket === b} onclick={() => (bucket = b as Bucket | "auto")}>{t(`bucket.${b}` as "bucket.day")}</button>
          {/each}
        </div>
        <div class="seg" role="group">
          <button aria-pressed={kind === "bar"} aria-label="Bars" onclick={() => (kind = "bar")}><ChartColumn size={13} /></button>
          <button aria-pressed={kind === "area"} aria-label="Area" onclick={() => (kind = "area")}><ChartArea size={13} /></button>
        </div>
      {/snippet}
      {#snippet table()}
        {#if series.data}
          <table class="data">
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
      {#if mainOption}<Chart option={mainOption} height={380} dim={series.loading} />{/if}
    </Card>

    <Card title={t("chart.cumulative")} subtitle={t(`metric.${store.metric}`)}>
      {#if cumOption}<Chart option={cumOption} height={240} dim={daily.loading} />{/if}
    </Card>
  {/if}
</div>
