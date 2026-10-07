<script lang="ts">
  import ValueBar from "../components/ValueBar.svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import DonutList from "../components/DonutList.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import MixByWeek from "../components/MixByWeek.svelte";
  import TableCard from "../components/TableCard.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch, type TimeSeries } from "../lib/api.svelte.ts";
  import { percentLine } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
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
  // Prompt tokens by type, day by day, for the weekly mix under the composition donut (output isn't a prompt token).
  const types = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: "day", group: "type", metric: "tokens" }));
  const promptTypes = $derived(types.data ? { ...types.data, series: types.data.series.filter((s) => s.key !== "output") } : null);

  // The per-model table: the standard table card, sorted here, paged by the card.
  type ModelRow = CacheData["models"][number];
  type ModelSort = "cost" | "hitRate" | "savings" | "cacheRead" | "input" | "cacheWrite" | "writeCost" | "key";
  let modelSort = $state<ModelSort>("cost");
  let modelAsc = $state(false);
  const MODEL_SORTS = $derived<{ value: ModelSort; label: string; asc?: boolean }[]>([
    { value: "cost", label: t("col.cost") },
    { value: "hitRate", label: t("col.hitRate") },
    { value: "savings", label: t("col.savings") },
    { value: "cacheRead", label: t("tok.cacheRead") },
    { value: "input", label: t("tok.input") },
    { value: "key", label: t("col.model"), asc: true },
  ]);
  const models = $derived.by(() => {
    const dir = modelAsc ? 1 : -1;
    return [...(d.data?.models ?? [])].sort((a: ModelRow, b: ModelRow) => {
      const x = a[modelSort];
      const y = b[modelSort];
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  function sortModels(k: ModelSort) {
    if (modelSort === k) modelAsc = !modelAsc;
    else {
      modelSort = k;
      modelAsc = k === "key";
    }
  }
  const dir = (k: ModelSort) => (modelSort === k ? (modelAsc ? "ascending" : "descending") : undefined);

  const hitOption = $derived.by(() => (void store.dark, d.data ? percentLine(d.data.buckets, d.data.series.map((s) => s.hitRate), store.bucket, t("cache.hitRate")) : null));
  // Where prompt tokens came from over the whole range: fresh input, cache writes, or cache reads.
  const mix = $derived.by(() => {
    if (!d.data) return [];
    const tot = d.data.totals;
    const parts = [
      { key: "cacheRead", value: tot.cacheRead },
      { key: "cacheWrite", value: tot.cacheWrite + tot.cacheWrite1h },
      { key: "input", value: tot.input },
    ];
    return parts.map((p) => ({ ...p, label: t(`tok.${p.key}` as "tok.input") }));
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("cache.title")} subtitle={t("cache.subtitle")} />
  <ViewGate ready={settled(d, types)}>

    {#if d.data && d.data.totals.input + d.data.totals.cacheRead === 0}
      <div class="card"><Empty /></div>
    {:else if d.data}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("cache.hitRate")} value={percent(d.data.totals.hitRate, 1)} hint={t("cache.hitRateKpiHint")} />
        <Kpi label={t("cache.savings")} value={usd(d.data.totals.savings)} hint={t("cache.savingsHint")} />
        <Kpi label={t("cache.writeCost")} value={usd(d.data.totals.writeCost)} hint={`${compact(d.data.totals.cacheWrite + d.data.totals.cacheWrite1h)} ${t("metric.tokens")}`} />
        <Kpi label={t("cache.readCost")} value={usd(d.data.totals.readCost)} hint={`${compact(d.data.totals.cacheRead)} ${t("metric.tokens")}`} />
      </div>

      <div class="grid gap-5 xl:grid-cols-2">
        <Card title={t("cache.hitRateOverTime")} subtitle={t("cache.hitRateHint")}>
          {#if hitOption}<Chart option={hitOption} height={280} fill dim={d.loading} />{/if}
        </Card>
        <Card title={t("cache.composition")} subtitle={t("metric.tokens")}>
          <div class="flex flex-col gap-6">
            <DonutList items={mix} dim="type" format={compact} loading={d.loading} />
            {#if promptTypes}<MixByWeek ts={promptTypes} dim="type" metric="tokens" />{/if}
          </div>
        </Card>
      </div>

      <TableCard
        title={t("cache.perModel")}
        subtitle={t("cache.perModelHint")}
        rows={models}
        searchText={(m) => m.key}
        sorts={MODEL_SORTS}
        bind:sortKey={modelSort}
        bind:asc={modelAsc}
      >
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-44" />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-28" />
            </colgroup>
            <thead>
              <tr>
                <SortTh label={t("col.model")} sort={dir("key")} onclick={() => sortModels("key")} />
                <SortTh num label={t("col.hitRate")} sort={dir("hitRate")} onclick={() => sortModels("hitRate")} />
                <SortTh num label={t("tok.input")} sort={dir("input")} onclick={() => sortModels("input")} />
                <SortTh num label={t("tok.cacheRead")} sort={dir("cacheRead")} onclick={() => sortModels("cacheRead")} />
                <SortTh num label={t("tok.cacheWrite")} sort={dir("cacheWrite")} onclick={() => sortModels("cacheWrite")} />
                <SortTh num label={t("col.savings")} sort={dir("savings")} onclick={() => sortModels("savings")} />
                <SortTh num label={t("col.writeCost")} sort={dir("writeCost")} onclick={() => sortModels("writeCost")} />
                <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortModels("cost")} />
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as m (m.key)}
                <tr>
                  <td class="text-ink">{m.key}</td>
                  <td class="num"><ValueBar label={percent(m.hitRate, 1)} fraction={m.hitRate} color={colorFor("type", "cacheRead")} /></td>
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
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
