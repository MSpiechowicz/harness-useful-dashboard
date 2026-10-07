<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import DonutList from "../components/DonutList.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch } from "../lib/api.svelte.ts";
  import { agentTimeChart } from "../lib/charts.ts";
  import { rankKeys } from "../lib/colors.svelte.ts";
  import { compact, dateTime, decimal, duration, entityLabel, integer, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  interface TimeData {
    totals: {
      activeMs: number;
      parallelMs: number;
      peakSessions: number;
      peakAt: number | null;
      timed: number;
      responses: number;
      cost: number;
      costPerHour: number | null;
      activeBuckets: number;
    };
    buckets: string[];
    series: { bucket: string; one: number; two: number; more: number }[];
    models: { key: string; responses: number; modelMs: number; cost: number; medianMs: number | null; medianTtftMs: number | null }[];
    projects: { key: string; label: string; activeMs: number; cost: number; sessions: number }[];
    efforts: { key: string; ms: number }[];
  }

  const d = useFetch<TimeData>(() => apiUrl("/api/time", { bucket: store.bucket }));
  const tot = $derived(d.data?.totals);
  const option = $derived.by(() => (void store.dark, d.data ? agentTimeChart(d.data.series, store.bucket, duration) : null));
  // Effort levels in the order of their use, so each gets a hue of its own.
  $effect(() => {
    if (d.data) rankKeys("effort", d.data.efforts.map((e) => e.key));
  });
  const efforts = $derived((d.data?.efforts ?? []).map((e) => ({ key: e.key, label: e.key === "(none)" ? t("time.noEffort") : e.key, value: e.ms })));

  type ModelSort = "modelMs" | "responses" | "medianMs" | "medianTtftMs" | "cost" | "key";
  let modelSort = $state<ModelSort>("modelMs");
  let modelAsc = $state(false);
  const MODEL_SORTS = $derived<{ value: ModelSort; label: string; asc?: boolean }[]>([
    { value: "modelMs", label: t("time.answering") },
    { value: "responses", label: t("drift.responses") },
    { value: "medianMs", label: t("time.medianResponse") },
    { value: "medianTtftMs", label: t("time.medianTtft") },
    { value: "cost", label: t("col.cost") },
    { value: "key", label: t("col.model"), asc: true },
  ]);
  const models = $derived.by(() => {
    const dir = modelAsc ? 1 : -1;
    return [...(d.data?.models ?? [])].sort((a, b) => {
      const x = a[modelSort] ?? -1;
      const y = b[modelSort] ?? -1;
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  const maxModelMs = $derived(Math.max(1, ...models.map((m) => m.modelMs)));
  function sortModels(k: ModelSort) {
    if (modelSort === k) modelAsc = !modelAsc;
    else {
      modelSort = k;
      modelAsc = k === "key";
    }
  }
  const modelDir = (k: ModelSort) => (modelSort === k ? (modelAsc ? "ascending" : "descending") : undefined);

  type ProjectSort = "activeMs" | "sessions" | "cost" | "perHour";
  let projectSort = $state<ProjectSort>("activeMs");
  const PROJECT_SORTS = $derived<{ value: ProjectSort; label: string }[]>([
    { value: "activeMs", label: t("time.active") },
    { value: "sessions", label: t("col.sessions") },
    { value: "cost", label: t("col.cost") },
    { value: "perHour", label: t("time.perHour") },
  ]);
  const perHour = (p: { activeMs: number; cost: number }) => (p.activeMs ? p.cost / (p.activeMs / 3_600_000) : 0);
  const projects = $derived(
    [...(d.data?.projects ?? [])].sort((a, b) => (projectSort === "perHour" ? perHour(b) - perHour(a) : b[projectSort] - a[projectSort])),
  );
  const maxProjectMs = $derived(Math.max(1, ...projects.map((p) => p.activeMs)));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("time.title")} subtitle={t("time.subtitle")} />
  <ViewGate ready={settled(d)}>
    {#if !d.data || !tot}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !tot.timed}
      <div class="card"><Empty title={t("time.empty")} body={t("time.emptyBody")} /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("time.active")} amount={tot.activeMs} format={duration} hint={t("time.activeHint")} />
        <Kpi label={t("time.inParallel")} amount={tot.activeMs ? tot.parallelMs / tot.activeMs : 0} format={(v) => percent(v)} hint={t("time.inParallelHint", { time: duration(tot.parallelMs) })} />
        <Kpi label={t("time.mostAtOnce")} amount={tot.peakSessions} format={integer} hint={tot.peakAt ? t("time.mostAtOnceHint", { when: dateTime(tot.peakAt) }) : undefined} />
        <Kpi label={t("time.costPerHour")} amount={tot.costPerHour} format={usd} hint={t("time.costPerHourHint")} />
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card
          title={t("time.overTime")}
          subtitle={t("time.overTimeHint")}
          class="xl:col-span-2"
        >
          <div class="flex h-full flex-col gap-3">
            {#if option}<Chart {option} height={280} fill dim={d.loading} />{/if}
            <p class="text-xs text-muted">{t("time.coverage", { timed: compact(tot.timed), share: percent(tot.responses ? tot.timed / tot.responses : 0) })}</p>
          </div>
        </Card>
        <Card title={t("time.byEffort")} subtitle={t("time.byEffortHint")}>
          <DonutList items={efforts} dim="effort" format={duration} loading={d.loading} />
        </Card>
      </div>

      <TableCard title={t("time.byModel")} subtitle={t("time.byModelHint")} rows={models} searchText={(m) => m.key} sorts={MODEL_SORTS} bind:sortKey={modelSort} bind:asc={modelAsc} exportName="time-by-model">
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-28" />
              <col class="w-48" />
              <col class="w-32" />
              <col class="w-32" />
              <col class="w-28" />
            </colgroup>
            <thead>
              <tr>
                <SortTh label={t("col.model")} sort={modelDir("key")} onclick={() => sortModels("key")} />
                <SortTh num label={t("drift.responses")} sort={modelDir("responses")} onclick={() => sortModels("responses")} />
                <SortTh num label={t("time.answering")} sort={modelDir("modelMs")} onclick={() => sortModels("modelMs")} />
                <SortTh num label={t("time.medianResponse")} sort={modelDir("medianMs")} onclick={() => sortModels("medianMs")} />
                <SortTh num label={t("time.medianTtft")} sort={modelDir("medianTtftMs")} onclick={() => sortModels("medianTtftMs")} />
                <SortTh num label={t("col.cost")} sort={modelDir("cost")} onclick={() => sortModels("cost")} />
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as m (m.key)}
                <tr>
                  <td class="truncate text-ink">{entityLabel("model", m.key, m.key)}</td>
                  <td class="num text-ink-2">{compact(m.responses)}</td>
                  <td class="num"><ValueBar label={duration(m.modelMs)} fraction={m.modelMs / maxModelMs} /></td>
                  <td class="num text-ink-2">{duration(m.medianMs)}</td>
                  <td class="num text-ink-2">{duration(m.medianTtftMs)}</td>
                  <td class="num font-medium">{usd(m.cost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>

      <TableCard title={t("time.byProject")} subtitle={t("time.byProjectHint")} rows={projects} searchText={(p) => p.label} sorts={PROJECT_SORTS} bind:sortKey={projectSort} exportName="time-by-project">
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-48" />
              <col class="w-24" />
              <col class="w-28" />
              <col class="w-36" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("col.project")}</th>
                <th class="num">{t("time.active")}</th>
                <th class="num">{t("col.sessions")}</th>
                <th class="num">{t("col.cost")}</th>
                <th class="num">{t("time.perHour")}</th>
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as p (p.key)}
                <tr class="cursor-pointer" onclick={() => store.setFilter("project", p.key)}>
                  <!-- A button for the keyboard, without a handler of its own: its click reaches the row's. -->
                  <td class="text-ink" title={p.key}><button type="button" class="block w-full truncate text-left">{entityLabel("project", p.key, p.label)}</button></td>
                  <td class="num"><ValueBar label={duration(p.activeMs)} fraction={p.activeMs / maxProjectMs} /></td>
                  <td class="num text-ink-2">{compact(p.sessions)}</td>
                  <td class="num font-medium">{usd(p.cost)}</td>
                  <td class="num text-ink-2">{usd(perHour(p))}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
