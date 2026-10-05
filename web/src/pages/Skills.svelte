<script lang="ts">
  import BreakdownTable from "../components/BreakdownTable.svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import Empty from "../components/Empty.svelte";
  import { apiUrl, useFetch, type Breakdown } from "../lib/api.svelte.ts";
  import { rankedBars } from "../lib/charts.ts";
  import { percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  const skills = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "skill", limit: 100, sort: store.metric }));
  const agents = useFetch<Breakdown>(() => apiUrl("/api/breakdown", { dim: "agent", limit: 100, sort: store.metric }));

  const skillRows = $derived((skills.data?.rows ?? []).filter((r) => r.key !== "(none)"));
  const agentRows = $derived(agents.data?.rows ?? []);
  const subCost = $derived(agentRows.filter((r) => r.key !== "main").reduce((a, r) => a + r.cost, 0));
  const totalCost = $derived(agents.data?.total.cost ?? 0);
  const skillCost = $derived(skillRows.reduce((a, r) => a + r.cost, 0));

  const skillsOption = $derived.by(() => (void store.dark, skillRows.length ? rankedBars(skillRows, { dim: "skill", metric: store.metric, limit: 12 }) : null));
  const agentsOption = $derived.by(() => (void store.dark, agentRows.length ? rankedBars(agentRows, { dim: "agent", metric: store.metric, limit: 12 }) : null));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("skills.title")} subtitle={t("breakdown.subtitle.skill")} />

  <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
    <Kpi label={t("skills.subagentShare")} value={totalCost ? percent(subCost / totalCost, 1) : "–"} hint={usd(subCost)} />
    <Kpi label={t("skills.skills")} value={String(skillRows.length)} hint={usd(skillCost)} />
    <Kpi label={t("skills.agents")} value={String(agentRows.length)} />
    <Kpi label={t("kpi.cost")} value={usd(totalCost)} />
  </div>

  <div class="grid gap-5 xl:grid-cols-2">
    <Card title={t("skills.skills")} subtitle={t("breakdown.skillsHint")}>
      {#snippet table()}<BreakdownTable rows={skillRows} dim="skill" filterKey="skill" compactCols />{/snippet}
      {#if skillsOption}
        <Chart option={skillsOption} height={Math.max(140, Math.min(12, skillRows.length) * 34)} dim={skills.loading} onclick={(p) => { const r = skillRows.slice(0, 12).reverse()[p.dataIndex]; if (r) store.setFilter("skill", r.key); }} />
      {:else if skills.data}
        <Empty compact title={t("empty.noData")} />
      {/if}
    </Card>
    <Card title={t("skills.agents")} subtitle={t("breakdown.subtitle.agent")}>
      {#snippet table()}<BreakdownTable rows={agentRows} dim="agent" filterKey="agent" compactCols />{/snippet}
      {#if agentsOption}
        <Chart option={agentsOption} height={Math.max(140, Math.min(12, agentRows.length) * 34)} dim={agents.loading} onclick={(p) => { const r = agentRows.slice(0, 12).reverse()[p.dataIndex]; if (r) store.setFilter("agent", r.key); }} />
      {:else if agents.data}
        <Empty compact title={t("empty.noData")} />
      {/if}
    </Card>
  </div>

  {#if skillRows.length}
    <Card pad={false} title={t("skills.skills")}>
      <div class="mt-3 max-h-[520px] overflow-auto"><BreakdownTable rows={skillRows} dim="skill" filterKey="skill" /></div>
    </Card>
  {/if}
</div>
