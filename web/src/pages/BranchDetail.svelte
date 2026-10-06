<script lang="ts">
  import { ArrowLeft, GitBranch } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import ListCard from "../components/ListCard.svelte";
  import Kpi from "../components/Kpi.svelte";
  import Link from "../components/Link.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import { qs, settled, useFetch } from "../lib/api.svelte.ts";
  import { timeSeriesChart } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, dayWithYear, days, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  let { id }: { id: string } = $props();

  interface Detail {
    branch: string;
    project: string | null;
    projectLabel: string;
    longLived: boolean;
    totals: { tokens: number; cost: number; messages: number; sessions: number; prompts: number; firstTs: number | null; lastTs: number | null };
    days: { buckets: string[]; cost: number[]; tokens: number[] };
    sessions: { id: string; title: string | null; provider: string; tokens: number; cost: number; messages: number; prompts: number; subagents: number; firstTs: number; lastTs: number }[];
    models: { key: string; tokens: number; cost: number; messages: number }[];
    files: { key: string; edits: number }[];
  }

  const d = useFetch<Detail>(() => `/api/branch${qs({ id })}`);
  const tot = $derived(d.data?.totals);
  const activeDays = $derived(d.data?.days.cost.filter((v) => v > 0).length ?? 0);
  const spanDays = $derived(tot?.firstTs && tot.lastTs ? Math.max(1, Math.ceil((tot.lastTs - tot.firstTs) / 86_400_000)) : 0);
  const maxSession = $derived(Math.max(1e-9, ...(d.data?.sessions ?? []).map((s) => s.cost)));
  const option = $derived.by(() => {
    void store.dark;
    const x = d.data?.days;
    if (!x?.buckets.length) return null;
    return timeSeriesChart({ buckets: x.buckets, series: [{ key: "all", name: t("metric.cost"), data: x.cost }] }, { dim: "none", metric: "cost", bucket: "day", kind: "bar" });
  });
  const titleOf = (s: Detail["sessions"][number]) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
</script>

<div class="flex flex-col gap-5">
  <ViewGate ready={settled(d)}>
    <Link to="#/branches" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("branches.back")}</Link>

    {#if !d.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !d.data.totals.messages}
      <div class="card"><Empty compact title={t("branches.notFound")} /></div>
    {:else}
      <div>
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <GitBranch size={18} class="shrink-0 text-muted" />
          <span class="truncate font-mono">{d.data.branch === "(none)" ? t("branches.noBranch") : d.data.branch}</span>
          {#if d.data.longLived}<span class="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-normal text-muted">{t("branches.longLived")}</span>{/if}
        </h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span class="font-mono">{d.data.project ?? t("common.noProject")}</span>
          {#if tot?.firstTs && tot.lastTs}<span>{dayWithYear(tot.firstTs)} – {dayWithYear(tot.lastTs)}</span>{/if}
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("col.cost")} value={usd(tot?.cost)} hint={tot?.sessions ? t("branches.perSession", { cost: usd((tot.cost ?? 0) / tot.sessions) }) : undefined} />
        <Kpi label={t("col.tokens")} value={compact(tot?.tokens)} hint={t("prompts.calls", { n: compact(tot?.messages) })} />
        <Kpi label={t("col.sessions")} value={compact(tot?.sessions)} hint={`${compact(tot?.prompts)} ${t("col.prompts")}`} />
        <Kpi label={t("branches.days")} value={String(activeDays)} hint={t("branches.over", { span: days(spanDays) })} />
      </div>

      <Card title={t("branches.costByDay")} subtitle={t("branches.costByDayHint")}>
        {#if option}<Chart {option} height={240} />{/if}
      </Card>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card title={t("branches.sessions")} subtitle={t("branches.sessionsHint")} class="xl:col-span-2" pad={false}>
          <div class="max-h-[560px] overflow-auto">
            <table class="data">
              <thead>
                <tr>
                  <th>{t("col.title")}</th>
                  <th class="num">{t("col.prompts")}</th>
                  <th class="num">{t("col.tokens")}</th>
                  <th class="num">{t("col.cost")}</th>
                  <th class="num">{t("col.lastSeen")}</th>
                </tr>
              </thead>
              <tbody>
                {#each d.data.sessions as s (s.id)}
                  <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                    <td class="max-w-md">
                      <div class="flex items-center gap-2">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                        <span class="truncate">{titleOf(s)}</span>
                        {#if s.subagents}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{t("live.subagents", { n: s.subagents })}</span>{/if}
                      </div>
                    </td>
                    <td class="num text-ink-2">{s.prompts}</td>
                    <td class="num text-ink-2">{compact(s.tokens)}</td>
                    <td class="num"><ValueBar label={usd(s.cost)} fraction={s.cost / maxSession} /></td>
                    <td class="num text-ink-2">{relative(s.lastTs)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
        <div class="flex flex-col gap-5">
          <ListCard title={t("chart.byModel")} subtitle={t("detail.models.branch")} items={d.data.models} value="cost" />
          <ListCard title={t("branches.files")} subtitle={t("branches.filesHint")} items={d.data.files.map((f) => ({ key: f.key, calls: f.edits }))} paths />
        </div>
      </div>
    {/if}
  </ViewGate>
</div>
