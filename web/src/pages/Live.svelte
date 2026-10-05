<script lang="ts">
  import { Gauge } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import PlanLimits, { type LimitsResult } from "../components/PlanLimits.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { settled, useFetch } from "../lib/api.svelte.ts";
  import Dropdown from "../components/Dropdown.svelte";
  import { rateChart, type RateKind } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, relative, usd } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  interface LiveSession {
    id: string;
    title: string | null;
    project: string | null;
    projectLabel: string;
    provider: string;
    model: string | null;
    tokens: number;
    cost: number;
    messages: number;
    subagents: number;
    firstTs: number;
    lastTs: number;
  }
  interface LiveData {
    from: number;
    minutes: number;
    series: { key: string; data: number[] }[];
    sessions: LiveSession[];
    lastTs: number | null;
  }

  // How far back the page looks. Everything on it follows this choice, and it is kept between visits.
  const WINDOWS = [30, 60, 180, 360] as const;
  let minutes = $state<(typeof WINDOWS)[number]>(60);
  try {
    const saved = Number(localStorage.getItem("hd.liveMinutes"));
    if ((WINDOWS as readonly number[]).includes(saved)) minutes = saved as (typeof WINDOWS)[number];
  } catch {
    /* no storage: the default */
  }
  function pick(m: (typeof WINDOWS)[number]) {
    minutes = m;
    try {
      localStorage.setItem("hd.liveMinutes", String(m));
    } catch {
      /* not kept */
    }
  }

  // The page refreshes itself: usage every 15 seconds (the server rescans the logs first), limits every minute.
  let tick = $state(0);
  let now = $state(Date.now());
  $effect(() => {
    const h = setInterval(() => {
      tick++;
      now = Date.now();
    }, 15_000);
    return () => clearInterval(h);
  });
  const data = useFetch<LiveData>(() => `/api/live?minutes=${minutes}&t=${tick}`);
  // "Refresh" asks the providers again instead of answering from the minute-long cache.
  // Only the click asks with force=1: the regular checks after it go by the server's schedule again.
  let forced = $state(0);
  let refreshing = $state(false);
  const limits = useFetch<LimitsResult>(() => `/api/limits?minutes=${minutes}&t=${Math.floor(tick / 4)}&f=${forced}`);
  async function refreshLimits() {
    refreshing = true;
    try {
      await fetch(`/api/limits?minutes=${minutes}&force=1`);
    } finally {
      refreshing = false;
      forced++;
    }
  }

  const total = $derived.by(() => {
    const d = data.data;
    if (!d) return null;
    const perMinute = d.series[0]?.data.map((_, i) => d.series.reduce((a, s) => a + (s.data[i] ?? 0), 0)) ?? [];
    const sum = perMinute.reduce((a, v) => a + v, 0);
    // "Right now" is the last five minutes, so one quiet minute between two prompts doesn't read as zero.
    const recent = perMinute.slice(-5);
    const peak = perMinute.reduce((best, v, i) => (v > best.v ? { v, i } : best), { v: 0, i: -1 });
    return {
      sum,
      cost: d.sessions.reduce((a, s) => a + s.cost, 0),
      rate: recent.length ? recent.reduce((a, v) => a + v, 0) / recent.length : 0,
      peak: peak.v,
      peakAt: peak.i >= 0 ? d.from + peak.i * 60_000 : null,
    };
  });
  // How the rate is drawn, kept between visits.
  const KINDS = ["area", "bars", "lines", "dots", "steps", "total"] as const;
  let kind = $state<RateKind>("area");
  try {
    const saved = localStorage.getItem("hd.liveChart");
    if ((KINDS as readonly string[]).includes(saved ?? "")) kind = saved as RateKind;
  } catch {
    /* no storage: the default */
  }
  function pickKind(k: RateKind) {
    try {
      localStorage.setItem("hd.liveChart", k);
    } catch {
      /* not kept */
    }
  }
  const option = $derived.by(() => (void store.dark, data.data ? rateChart(data.data.series, data.data.from, kind) : null));
  const quiet = $derived(!!total && total.sum === 0);
  const windowLabel = $derived(minutes < 60 ? t("live.lastMinutes", { n: minutes }) : minutes === 60 ? t("live.lastHour") : t("live.lastHours", { n: minutes / 60 }));
  const time = (ts: number) => new Intl.DateTimeFormat(i18n.locale, { hour: "numeric", minute: "2-digit" }).format(ts);

  type Sort = "recent" | "tokens" | "cost";
  let sort = $state<Sort>("recent");
  const SORTS = $derived((["recent", "tokens", "cost"] as const).map((value) => ({ value: value as Sort, label: t(`sort.${value}`) })));
  const titleOf = (s: LiveSession) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("live.title")} subtitle={t("live.subtitle")}>
    <span class="flex items-center gap-1.5 text-xs text-muted">
      <span class="relative flex size-2"><span class="absolute inline-flex size-full animate-ping rounded-full bg-good opacity-60"></span><span class="relative inline-flex size-2 rounded-full bg-good"></span></span>
      {t("live.auto")}
    </span>
    <div class="seg" role="radiogroup" aria-label={t("live.window")}>
      {#each WINDOWS as m (m)}
        <button role="radio" aria-checked={minutes === m} onclick={() => pick(m)}>{m < 60 ? `${m}m` : `${m / 60}h`}</button>
      {/each}
    </div>
  </PageHeader>

  <ViewGate ready={settled(data, limits)}>
    {#if total}
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label={t("live.kpi.rate")} value={`${compact(total.rate)}/min`} hint={t("live.kpi.rateHint")} />
        <Kpi label={t("live.kpi.peak")} value={`${compact(total.peak)}/min`} hint={total.peakAt ? t("live.kpi.peakAt", { time: time(total.peakAt) }) : windowLabel} />
        <Kpi label={t("live.kpi.tokens")} value={compact(total.sum)} hint={windowLabel} />
        <Kpi label={t("live.kpi.sessions")} value={String(data.data?.sessions.length ?? 0)} hint={t("live.kpi.cost", { cost: usd(total.cost) })} />
      </div>
    {/if}

    <div class="grid gap-5 xl:grid-cols-5">
      <Card title={t("live.rate")} subtitle={t(kind === "total" ? "live.totalHint" : "live.rateHint", { window: windowLabel })} class="xl:col-span-3">
        {#snippet actions()}
          <Dropdown label={t("live.chart")} bind:value={kind} options={KINDS.map((k) => ({ value: k, label: t(`live.chart.${k}`) }))} onchange={pickKind} />
        {/snippet}
        {#if quiet}
          <div class="flex h-[280px] flex-col items-center justify-center gap-2 text-center">
            <Gauge size={22} class="text-muted" />
            <div class="text-sm text-ink-2">{t("live.quiet")}</div>
            <div class="text-xs text-muted">{t("live.lastActivity", { ago: relative(data.data?.lastTs) })}</div>
          </div>
        {:else if option}
          <Chart {option} height={280} fill />
        {/if}
      </Card>
      <Card title={t("live.limits")} subtitle={t("live.limitsHint")} class="xl:col-span-2">
        {#snippet actions()}
          <button class="btn !h-7 !px-2 !text-xs" onclick={refreshLimits} disabled={refreshing}>{t("live.refresh")}</button>
        {/snippet}
        {#if limits.data && (limits.data.reports.length || limits.data.problems.length)}
          <PlanLimits data={limits.data} {now} />
        {:else if limits.data?.active && !limits.data.active.length}
          <div class="flex h-full flex-col justify-center gap-2 py-6 text-center">
            <div class="text-sm text-ink-2">{t("live.noActive")}</div>
            <div class="text-xs text-muted">{t("live.noActiveHint")}</div>
          </div>
        {:else}
          <div class="flex h-full flex-col justify-center gap-2 py-6 text-center">
            <div class="text-sm text-ink-2">{t("live.noLimits")}</div>
            <div class="text-xs text-muted">{t("live.noLimitsHint")}</div>
          </div>
        {/if}
      </Card>
    </div>

    <TableCard
      title={t("live.sessions")}
      subtitle={t("live.sessionsHint")}
      rows={[...(data.data?.sessions ?? [])].sort((a, b) => (sort === "recent" ? b.lastTs - a.lastTs : b[sort] - a[sort]))}
      searchText={(s) => `${s.title ?? ""} ${s.projectLabel} ${s.model ?? ""} ${s.provider}`}
      sorts={SORTS}
      bind:sortKey={sort}
    >
      {#snippet children(view)}
        <table class="data fixed-cols">
          <colgroup>
            <col />
            <col class="w-44" />
            <col class="w-44" />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-28" />
            <col class="w-32" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.title")}</th>
              <th>{t("col.project")}</th>
              <th>{t("col.model")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.started")}</th>
              <th class="num">{t("col.lastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows.slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as s (s.id)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                <td>
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                    <span class="truncate font-medium">{titleOf(s)}</span>
                    {#if s.subagents}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{t("live.subagents", { n: s.subagents })}</span>{/if}
                  </div>
                </td>
                <td class="truncate text-ink-2" title={s.project}>{entityLabel("project", s.project, s.projectLabel)}</td>
                <td class="truncate text-xs text-ink-2">{s.model ?? "–"}</td>
                <td class="num font-medium">{compact(s.tokens)}</td>
                <td class="num text-ink-2">{usd(s.cost)}</td>
                <td class="num text-ink-2">{time(s.firstTs)}</td>
                <td class="num text-ink-2">{relative(s.lastTs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>
  </ViewGate>
</div>
