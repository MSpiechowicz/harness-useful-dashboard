<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import Link from "../components/Link.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch } from "../lib/api.svelte.ts";
  import { frictionChart } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, decimal, entityLabel, percent, relative } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  interface Counts {
    ok: number;
    errors: number;
    rejected: number;
    interrupts: number;
    calls: number;
    errorRate: number | null;
    rejectRate: number | null;
  }
  interface FrictionData {
    totals: Counts & { prompts: number; interruptsPer100: number | null };
    buckets: string[];
    series: { bucket: string; errors: number; rejected: number; interrupts: number; errorRate: number | null }[];
    tools: (Counts & { key: string })[];
    models: (Counts & { key: string })[];
    sessions: (Counts & { id: string; title: string | null; project: string | null; projectLabel: string; provider: string; lastTs: number })[];
  }

  const d = useFetch<FrictionData>(() => apiUrl("/api/friction", { bucket: store.bucket }));
  const tot = $derived(d.data?.totals);
  const option = $derived.by(() => (void store.dark, d.data ? frictionChart(d.data.series, store.bucket) : null));
  const rate = (v: number | null) => (v == null ? "–" : percent(v, v < 0.1 ? 1 : 0));
  // Codex names its tool results apart from its tool calls: their outcomes can't be put to a tool.
  const toolName = (key: string) => (key === "(none)" ? t("friction.unlinked") : key.replace(/^mcp__(.+?)__/, "$1:"));

  // Models with enough tool calls for a rate to mean something, worst first.
  const MIN_CALLS = 20;
  const models = $derived((d.data?.models ?? []).filter((m) => m.ok + m.errors >= MIN_CALLS).sort((a, b) => (b.errorRate ?? 0) - (a.errorRate ?? 0)));
  const maxModelRate = $derived(Math.max(1e-9, ...models.map((m) => m.errorRate ?? 0)));

  type ToolSort = "errors" | "errorRate" | "rejected" | "calls" | "key";
  let toolSort = $state<ToolSort>("errors");
  let toolAsc = $state(false);
  const TOOL_SORTS = $derived<{ value: ToolSort; label: string; asc?: boolean }[]>([
    { value: "errors", label: t("friction.errors") },
    { value: "errorRate", label: t("friction.errorRate") },
    { value: "rejected", label: t("friction.rejected") },
    { value: "calls", label: t("col.calls") },
    { value: "key", label: t("col.tool"), asc: true },
  ]);
  const tools = $derived.by(() => {
    const dir = toolAsc ? 1 : -1;
    return [...(d.data?.tools ?? [])].sort((a, b) => {
      const x = a[toolSort] ?? -1;
      const y = b[toolSort] ?? -1;
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  const maxToolRate = $derived(Math.max(1e-9, ...tools.map((r) => r.errorRate ?? 0)));
  function sortTools(k: ToolSort) {
    if (toolSort === k) toolAsc = !toolAsc;
    else {
      toolSort = k;
      toolAsc = k === "key";
    }
  }
  const toolDir = (k: ToolSort) => (toolSort === k ? (toolAsc ? "ascending" : "descending") : undefined);

  type SessionSort = "total" | "errors" | "rejected" | "interrupts" | "recent";
  let sessionSort = $state<SessionSort>("total");
  const SESSION_SORTS = $derived<{ value: SessionSort; label: string }[]>([
    { value: "total", label: t("friction.total") },
    { value: "errors", label: t("friction.errors") },
    { value: "rejected", label: t("friction.rejected") },
    { value: "interrupts", label: t("friction.interrupts") },
    { value: "recent", label: t("sort.recent") },
  ]);
  const sessions = $derived.by(() => {
    const value = (s: FrictionData["sessions"][number]) =>
      sessionSort === "recent" ? s.lastTs : sessionSort === "total" ? s.errors + s.rejected + s.interrupts : s[sessionSort];
    return [...(d.data?.sessions ?? [])].sort((a, b) => value(b) - value(a));
  });
  const titleOf = (s: { id: string; title: string | null }) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("friction.title")} subtitle={t("friction.subtitle")} />
  <ViewGate ready={settled(d)}>
    {#if !d.data || !tot}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !tot.calls && !tot.interrupts}
      <div class="card"><Empty /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("friction.errorRate")} value={rate(tot.errorRate)} hint={t("friction.errorRateHint")} />
        <Kpi label={t("friction.errors")} value={compact(tot.errors)} hint={t("friction.ofCalls", { n: compact(tot.ok + tot.errors) })} />
        <Kpi label={t("friction.rejected")} value={compact(tot.rejected)} hint={t("friction.rejectedHint", { rate: rate(tot.rejectRate) })} />
        <Kpi
          label={t("friction.interrupts")}
          value={compact(tot.interrupts)}
          hint={tot.interruptsPer100 != null ? t("friction.per100", { n: decimal(tot.interruptsPer100) }) : undefined}
        />
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card title={t("friction.overTime")} subtitle={t("friction.overTimeHint")} class="xl:col-span-2">
          {#if option}<Chart {option} height={280} fill dim={d.loading} />{/if}
        </Card>
        <Card title={t("friction.byModel")} subtitle={t("friction.byModelHint", { n: MIN_CALLS })}>
          <ul class="flex flex-col gap-3" class:loading-dim={d.loading}>
            {#each models.slice(0, 8) as m (m.key)}
              <li class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5" title="{m.key} · {compact(m.errors)} / {compact(m.ok + m.errors)}">
                <span class="truncate text-[13px] text-ink-2">{entityLabel("model", m.key, m.key)}</span>
                <span class="tabular text-right text-[13px] font-medium text-ink">{rate(m.errorRate)}</span>
                <span class="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <span class="block h-full rounded-full" style:width="{Math.max(0.5, ((m.errorRate ?? 0) / maxModelRate) * 100)}%" style:background={colorFor("model", m.key)}></span>
                </span>
              </li>
            {/each}
          </ul>
        </Card>
      </div>

      <TableCard title={t("friction.byTool")} subtitle={t("friction.byToolHint")} rows={tools} searchText={(r) => r.key} sorts={TOOL_SORTS} bind:sortKey={toolSort} bind:asc={toolAsc}>
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-44" />
              <col class="w-32" />
            </colgroup>
            <thead>
              <tr>
                <SortTh label={t("col.tool")} sort={toolDir("key")} onclick={() => sortTools("key")} />
                <SortTh num label={t("col.calls")} sort={toolDir("calls")} onclick={() => sortTools("calls")} />
                <SortTh num label={t("friction.errors")} sort={toolDir("errors")} onclick={() => sortTools("errors")} />
                <SortTh num label={t("friction.errorRate")} sort={toolDir("errorRate")} onclick={() => sortTools("errorRate")} />
                <SortTh num label={t("friction.rejected")} sort={toolDir("rejected")} onclick={() => sortTools("rejected")} />
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as r (r.key)}
                <tr title={r.key === "(none)" ? t("friction.unlinkedHint") : r.key}>
                  <td class="truncate text-ink" class:italic={r.key === "(none)"}>{toolName(r.key)}</td>
                  <td class="num text-ink-2">{compact(r.calls)}</td>
                  <td class="num font-medium">{compact(r.errors)}</td>
                  <td class="num"><ValueBar label={rate(r.errorRate)} fraction={(r.errorRate ?? 0) / maxToolRate} color="var(--status-critical)" /></td>
                  <td class="num text-ink-2">{compact(r.rejected)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>

      <TableCard title={t("friction.sessions")} subtitle={t("friction.sessionsHint")} rows={sessions} searchText={(s) => `${s.title ?? ""} ${s.projectLabel}`} sorts={SESSION_SORTS} bind:sortKey={sessionSort}>
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-44" />
              <col class="w-24" />
              <col class="w-28" />
              <col class="w-28" />
              <col class="w-28" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("col.title")}</th>
                <th>{t("col.project")}</th>
                <th class="num">{t("friction.errors")}</th>
                <th class="num">{t("friction.rejected")}</th>
                <th class="num">{t("friction.interrupts")}</th>
                <th class="num">{t("col.lastSeen")}</th>
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as s (s.id)}
                <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                  <td>
                    <div class="flex items-center gap-2">
                      <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                      <Link to="#/sessions/{encodeURIComponent(s.id)}" class="truncate">{titleOf(s)}</Link>
                    </div>
                  </td>
                  <td class="truncate text-ink-2" title={s.project ?? ""}>{entityLabel("project", s.project, s.projectLabel)}</td>
                  <td class="num font-medium">{compact(s.errors)}</td>
                  <td class="num text-ink-2">{compact(s.rejected)}</td>
                  <td class="num text-ink-2">{compact(s.interrupts)}</td>
                  <td class="num text-ink-2">{relative(s.lastTs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
