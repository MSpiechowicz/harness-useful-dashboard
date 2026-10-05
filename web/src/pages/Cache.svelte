<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch } from "../lib/api.svelte.ts";
  import { percentLine, timeSeriesChart } from "../lib/charts.ts";
  import { compact, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  interface CacheData {
    totals: { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; hitRate: number; savings: number; writeCost: number; readCost: number };
    buckets: string[];
    series: { bucket: string; input: number; cacheRead: number; cacheWrite: number; hitRate: number | null }[];
    models: { key: string; hitRate: number; savings: number; writeCost: number; readCost: number; cost: number; cacheRead: number; cacheWrite: number; input: number }[];
  }

  const d = useFetch<CacheData>(() => apiUrl("/api/cache", { bucket: store.bucket }));

  const hitOption = $derived.by(() => (void store.dark, d.data ? percentLine(d.data.buckets, d.data.series.map((s) => s.hitRate), store.bucket, t("cache.hitRate")) : null));
  const compositionOption = $derived.by(() => {
    void store.dark;
    if (!d.data) return null;
    const keys = ["input", "cacheWrite", "cacheRead"] as const;
    return timeSeriesChart(
      { buckets: d.data.buckets, series: keys.map((k) => ({ key: k, name: k, data: d.data!.series.map((s) => s[k]) })) },
      { dim: "type", metric: "tokens", bucket: store.bucket, valueKind: "tokens" },
    );
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("cache.title")} subtitle={t("cache.subtitle")} />

  {#if d.data && d.data.totals.input + d.data.totals.cacheRead === 0}
    <div class="card"><Empty /></div>
  {:else if d.data}
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi hero label={t("cache.hitRate")} value={percent(d.data.totals.hitRate, 1)} />
      <Kpi label={t("cache.savings")} value={usd(d.data.totals.savings)} hint={t("cache.savingsHint")} />
      <Kpi label={t("cache.writeCost")} value={usd(d.data.totals.writeCost)} hint={`${compact(d.data.totals.cacheWrite + d.data.totals.cacheWrite1h)} ${t("metric.tokens")}`} />
      <Kpi label={t("cache.readCost")} value={usd(d.data.totals.readCost)} hint={`${compact(d.data.totals.cacheRead)} ${t("metric.tokens")}`} />
    </div>

    <div class="grid gap-5 xl:grid-cols-2">
      <Card title={t("cache.hitRateOverTime")}>{#if hitOption}<Chart option={hitOption} height={280} dim={d.loading} />{/if}</Card>
      <Card title={t("cache.composition")} subtitle={t("metric.tokens")}>{#if compositionOption}<Chart option={compositionOption} height={280} dim={d.loading} />{/if}</Card>
    </div>

    <Card title={t("cache.perModel")} pad={false}>
      <div class="mt-2 overflow-x-auto">
        <table class="data">
          <thead><tr><th>{t("col.model")}</th><th class="num">{t("col.hitRate")}</th><th class="num">{t("tok.input")}</th><th class="num">{t("tok.cacheRead")}</th><th class="num">{t("tok.cacheWrite")}</th><th class="num">{t("col.savings")}</th><th class="num">{t("col.writeCost")}</th><th class="num">{t("col.cost")}</th></tr></thead>
          <tbody>
            {#each d.data.models as m (m.key)}
              <tr>
                <td>{m.key}</td>
                <td class="num">
                  <div class="flex items-center justify-end gap-2">
                    <div class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2"><div class="h-full rounded-full" style:width="{m.hitRate * 100}%" style:background="var(--series-3)"></div></div>
                    {percent(m.hitRate, 1)}
                  </div>
                </td>
                <td class="num text-ink-2">{compact(m.input)}</td>
                <td class="num text-ink-2">{compact(m.cacheRead)}</td>
                <td class="num text-ink-2">{compact(m.cacheWrite)}</td>
                <td class="num text-good">{usd(m.savings)}</td>
                <td class="num text-ink-2">{usd(m.writeCost)}</td>
                <td class="num font-medium">{usd(m.cost)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}
</div>
