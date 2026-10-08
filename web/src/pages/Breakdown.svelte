<script lang="ts">
  import { untrack } from "svelte";
  import BillingTable, { type BillingSortKey, billingLabel } from "../components/BillingTable.svelte";
  import BreakdownTable, { type BreakdownSortKey } from "../components/BreakdownTable.svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import DonutList from "../components/DonutList.svelte";
  import MixByWeek from "../components/MixByWeek.svelte";
  import Empty from "../components/Empty.svelte";
  import LinesCard from "../components/LinesCard.svelte";
  import TableCard from "../components/TableCard.svelte";
  import Toggle from "../components/Toggle.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import RankedList from "../components/RankedList.svelte";
  import SmallMultiples from "../components/SmallMultiples.svelte";
  import UsageChart from "../components/UsageChart.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import { apiUrl, settled, useFetch, type BillingRow, type Breakdown, type TimeSeries, type WhatIf } from "../lib/api.svelte.ts";
  import { breakdownItems, treemapChart, trendAverage } from "../lib/charts.ts";
  import { isColored } from "../lib/colors.svelte.ts";
  import { entityLabel, metricValue, percent } from "../lib/format.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { whatIfChange } from "../lib/whatif.ts";
  import { sharedMax, tilesOf } from "../lib/smallMultiples.ts";
  import { SPLIT_BY, type PairRow } from "../lib/network.ts";
  import { splitNetwork } from "../lib/splitNetwork.ts";
  import { store, type FilterKey } from "../lib/state.svelte.ts";

  let { dim }: { dim: "project" | "model" | "provider" | "user" | "skill" | "agent" } = $props();

  const titles: Record<string, MessageKey> = {
    project: "nav.projects", model: "nav.models", provider: "nav.providers", user: "nav.users", skill: "skills.skills", agent: "skills.agents",
  };

  const data = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim, limit: 500, sort: store.metric }));
  // Models: what the range would have cost on another model, as two columns of the models table. The same answer lists
  // the models to compare with, so it is asked for before one is chosen. Nothing shows until one is.
  let candidate = $state("");
  const whatIf = useFetch<WhatIf>(() => (dim === "model" ? apiUrl("/api/whatif", { candidate }) : null));
  // A chosen model that the filters no longer offer is let go, so the server picks the candidate again.
  $effect(() => {
    if (candidate && whatIf.error?.startsWith("unknown candidate")) candidate = "";
  });
  const series = useFetch<TimeSeries>(() => apiUrl("/api/timeseries", { bucket: store.bucket, group: dim, metric: store.metric }));
  // Skills: drop turns without an active skill so the chart is about skills only.
  // "(none)" is left out where it isn't wanted: skills always (the page is about skills), projects when switched off.
  const hideNone = $derived(dim === "skill" || (dim === "project" && !store.showNoProject));
  // Who used what: the page's values split by a second dimension, as a network of points and fibres.
  const splitBy = $derived(SPLIT_BY[dim]);
  const pairs = useFetch<PairRow[]>(() => (splitBy ? apiUrl("/api/breakdown/pairs", { dim, by: splitBy, metric: store.metric, ...(hideNone ? { none: 0 } : {}) }) : null));
  // Projects: the busiest few as small multiples. One more than shown is asked for, as "(none)" may take a slot.
  const TILES = 12;
  const tileSeries = useFetch<TimeSeries>(() => (dim === "project" ? apiUrl("/api/timeseries", { bucket: store.bucket, group: dim, metric: store.metric, top: TILES + 1 }) : null));
  // Providers: what the usage was billed through (a plan like Copilot, or the harness's own account).
  const billing = useFetch<BillingRow[]>(() => (dim === "provider" ? apiUrl("/api/billing", {}) : null));

  const rows = $derived((data.data?.rows ?? []).filter((r) => !hideNone || r.key !== "(none)"));

  // The network settles by a force layout: a refresh with the same pairs keeps the rows it has, so it doesn't start over.
  let splitWidth = $state(1000);
  let pairRows = $state.raw<PairRow[]>([]);
  $effect(() => {
    const next = pairs.data ?? [];
    if (JSON.stringify(next) !== JSON.stringify(untrack(() => pairRows))) pairRows = next;
  });
  const splitOption = $derived.by(() => (void store.dark, splitBy && pairRows.length ? splitNetwork(pairRows, dim, splitBy, fmt, splitWidth, splitWidth < 700 ? 360 : 460) : null));


  const whatIfShown = $derived(dim === "model" && !!candidate && !!whatIf.data?.rows.length);
  // No comparison first, then the models in use (marked), then every other priced model. The chosen one is always listed.
  const candidateOptions = $derived.by(() => {
    const inUse = whatIf.data?.candidates.inUse ?? [];
    const rest = (whatIf.data?.candidates.priced ?? []).filter((m) => !inUse.includes(m));
    const all = [...inUse, ...rest];
    const list = candidate && !all.includes(candidate) ? [candidate, ...all] : all;

    return [{ value: "", label: t("whatif.none") }, ...list.map((m) => ({ value: m, label: inUse.includes(m) ? `${m} · ${t("whatif.inUse")}` : m, short: m }))];
  });
  // The tables: the standard table card's sort choices (names read A to Z, numbers from the top).
  const SORTS: { value: BreakdownSortKey; label: string; asc?: boolean }[] = $derived([
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "sessions", label: t("col.sessions") },
    { value: "prompts", label: t("col.prompts") },
    { value: "cacheHitRate", label: t("col.cacheHit") },
    { value: "lastTs", label: t("col.lastSeen") },
    ...(whatIfShown ? [{ value: "whatIf" as const, label: t("whatif.costIfSwitched") }, { value: "whatIfChange" as const, label: t("whatif.change") }] : []),
    { value: "label", label: t("col.name"), asc: true },
  ]);
  let sortKey = $state<BreakdownSortKey>(store.metric === "cost" ? "cost" : "tokens");
  let asc = $state(false);
  // The what-if columns can go (another dimension, or no usage): a sort by one of them goes with them.
  $effect(() => {
    if (!whatIfShown && (sortKey === "whatIf" || sortKey === "whatIfChange")) sortKey = store.metric === "cost" ? "cost" : "tokens";
  });
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
  // The cost of a model's usage on the candidate, and how it differs, by the model's name (none when it isn't there).
  const whatIfOf = (model: string) => {
    const r = whatIf.data?.rows.find((x) => x.model === model);
    return { whatIfCost: r?.whatIf ?? null, whatIfChange: r ? whatIfChange(r.actual, r.whatIf) : null };
  };
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
  const tiles = $derived(tileSeries.data ? tilesOf(tileSeries.data, dim, TILES, hideNone) : []);
  const tileMax = $derived(sharedMax(tiles));
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

      {#if tileSeries.data && tiles.length >= 2}
        <Card title={t("chart.projectTiles")} subtitle={t("chart.projectTilesHint", { max: fmt(tileMax) })}>
          <SmallMultiples
            {tiles}
            ts={tileSeries.data}
            {dim}
            bucket={store.bucket}
            metric={store.metric}
            max={tileMax}
            onselect={(key) => store.setFilter(dim as FilterKey, key)}
            loading={tileSeries.loading}
          />
        </Card>
      {/if}

      {#if splitOption}
        <Card title={t(`chart.split.${dim}` as MessageKey)} subtitle={t("chart.splitHint", { metric: t(`metric.${store.metric}`) })}>
          <!-- Which is which: filled points for this page's values, rings for what they're split by. -->
          <ul class="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2">
            <li class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full bg-ink-2"></span>{t(`nav.${dim}s` as MessageKey)}</li>
            <li class="flex items-center gap-1.5"><span class="h-2 w-2 shrink-0 rounded-full border-[1.5px] border-ink-2"></span>{t(`nav.${splitBy}s` as MessageKey)}</li>
          </ul>
          <div bind:clientWidth={splitWidth}><Chart option={splitOption} height={splitWidth < 700 ? 360 : 460} dim={pairs.loading} /></div>
        </Card>
      {/if}

      {#snippet actions()}
        {#if dim === "model"}
          <!-- A fixed slot, so "Compare with" and a model name show whole instead of sharing the row's free space. On a
               narrow screen it takes a line of its own under the table's usual controls. -->
          <div class="order-last basis-full sm:order-none sm:basis-auto sm:w-52 sm:shrink-0">
            <Dropdown prefix labelWhenEmpty bareValue label={t("whatif.candidate")} value={candidate} options={candidateOptions} onchange={(m) => (candidate = m)} />
          </div>
        {/if}
      {/snippet}
      {#snippet above()}
        {#if whatIfShown && whatIf.data && (whatIf.data.reported || whatIf.data.estimated)}
          <div class="flex flex-col gap-1 px-5 pb-3 text-xs text-muted">
            {#if whatIf.data.reported}<p>{t("whatif.hint")}</p>{/if}
            {#if whatIf.data.estimated}<p>{t("common.estimatedHint")}</p>{/if}
          </div>
        {/if}
      {/snippet}
      <TableCard
        title={t(`breakdown.table.${dim}` as MessageKey)}
        subtitle={t("breakdown.tableHint")}
        {rows}
        searchText={(r) => `${entityLabel(dim, r.key, r.label)} ${r.key}`}
        sorts={SORTS}
        bind:sortKey
        bind:asc
        exportName={`${dim}s`}
        {actions}
        {above}
        exportRows={whatIfShown ? (list) => list.map((r) => ({ ...r, ...whatIfOf(r.key) })) : undefined}
      >
        {#snippet children(view)}
          <BreakdownTable rows={view.rows} {dim} filterKey={dim as FilterKey} offset={view.offset} limit={view.limit} whatIf={whatIfShown ? whatIf.data : null} bind:sortKey bind:asc />
        {/snippet}
      </TableCard>
      {#if dim === "skill"}<p class="text-xs text-muted">{t("breakdown.skillsHint")}</p>{/if}
      <!-- Lines changed per model (which one changes code for the least), provider and project. -->
      {#if dim === "model" || dim === "provider" || dim === "project"}<LinesCard {dim} />{/if}
      {#if dim === "provider" && billing.data?.length}
        <TableCard
          title={t("billing.title")}
          subtitle={t("billing.subtitle")}
          rows={billing.data}
          searchText={(r) => `${billingLabel(r)} ${r.key}`}
          sorts={BILLING_SORTS}
          bind:sortKey={billingSort}
          bind:asc={billingAsc}
          exportName="billing"
        >
          {#snippet children(view)}
            <BillingTable rows={view.rows} offset={view.offset} limit={view.limit} bind:sortKey={billingSort} bind:asc={billingAsc} />
          {/snippet}
        </TableCard>
      {/if}
    {/if}
  </ViewGate>
</div>
