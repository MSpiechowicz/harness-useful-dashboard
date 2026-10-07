<script lang="ts">
  import { Ban, CircleStop, CircleX, Gauge, MessageSquareText } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Link from "../components/Link.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import PlanLimits, { type LimitsResult } from "../components/PlanLimits.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { settled, useFetch } from "../lib/api.svelte.ts";
  import Dropdown from "../components/Dropdown.svelte";
  import { rateChart, type RateKind } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { PROVIDER_NAMES, PROVIDERS } from "../lib/palette.ts";
  import { compact, entityLabel, relative, usd } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";
  import { live } from "../lib/live.svelte.ts";
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
    gitBranch: string | null;
    status: "working" | "idle" | "error";
    lastTool: string | null;
    lastFile: string | null;
    activeSubagents: number;
    errors: number;
  }
  type FailureReason = "timeout" | "edit_mismatch" | "stale_read" | "not_found" | "permission" | "exit_code" | "bad_input" | "other" | "rejected";
  interface FeedItem {
    ts: number;
    kind: "prompt" | "tool_error" | "tool_rejected" | "interrupt";
    text: string | null;
    tool: string | null;
    /** Why a failed or declined call failed, its error text and what it was given. */
    reason: FailureReason | null;
    detail: string | null;
    input: string | null;
    sessionId: string;
    title: string | null;
    provider: string;
  }
  interface LiveData {
    from: number;
    minutes: number;
    series: { key: string; data: number[] }[];
    costSeries: { key: string; data: number[] }[];
    sessions: LiveSession[];
    feed: FeedItem[];
    today: { cost: number; tokens: number; typicalCost: number | null; typicalTokens: number | null; days: number };
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

  // The page refreshes itself once a minute, usage and limits together. The server rescans the logs first.
  let tick = $state(0);
  let now = $state(Date.now());
  $effect(() => {
    const h = setInterval(() => {
      tick++;
      now = Date.now();
    }, 60_000);
    return () => clearInterval(h);
  });
  const data = useFetch<LiveData>(() => `/api/live?minutes=${minutes}&t=${tick}`);
  // While the page is open, its own poll is the one refresh: each one counts as an update.
  $effect(() => {
    live.watching = true;
    return () => (live.watching = false);
  });
  $effect(() => {
    if (data.data) live.updatedAt = Date.now();
  });
  // "Refresh" asks the providers again instead of answering from the minute-long cache.
  // Only the click asks with force=1: the regular checks after it go by the server's schedule again.
  let forced = $state(0);
  let refreshing = $state(false);
  const limits = useFetch<LimitsResult>(() => `/api/limits?minutes=${minutes}&t=${tick}&f=${forced}`);
  async function refreshLimits() {
    refreshing = true;
    try {
      await fetch(`/api/limits?minutes=${minutes}&force=1`);
    } finally {
      refreshing = false;
      forced++;
    }
  }

  // Tokens or cost a minute, kept between visits: the rate chart and its two figures follow it.
  let metric = $state<"tokens" | "cost">("tokens");
  try {
    if (localStorage.getItem("hd.liveMetric") === "cost") metric = "cost";
  } catch {
    /* no storage: the default */
  }
  function pickMetric(m: "tokens" | "cost") {
    metric = m;
    try {
      localStorage.setItem("hd.liveMetric", m);
    } catch {
      /* not kept */
    }
  }
  const shown = $derived(data.data ? (metric === "cost" ? data.data.costSeries : data.data.series) : []);
  const value = (v: number) => (metric === "cost" ? usd(v) : compact(v));

  const total = $derived.by(() => {
    const d = data.data;
    if (!d) return null;
    const perMinute = shown[0]?.data.map((_, i) => shown.reduce((a, s) => a + (s.data[i] ?? 0), 0)) ?? [];
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
  const option = $derived.by(() => (void store.dark, data.data ? rateChart(shown, data.data.from, kind, metric) : null));
  const statusCount = $derived(
    (data.data?.sessions ?? []).reduce((m, s) => m.set(s.status, (m.get(s.status) ?? 0) + 1), new Map<string, number>()),
  );
  const STATUS_COLOR = { working: "var(--status-good)", error: "var(--status-critical)", idle: "var(--muted)" } as const;
  const today = $derived(data.data?.today);
  // The activity table: newest first, or grouped by what happened (failures first).
  type FeedSort = "recent" | "kind";
  let feedSort = $state<FeedSort>("recent");
  const FEED_SORTS = $derived<{ value: FeedSort; label: string }[]>([
    { value: "recent", label: t("sort.recent") },
    { value: "kind", label: t("live.feed.byKind") },
  ]);
  const KIND_ORDER = { tool_error: 0, tool_rejected: 1, interrupt: 2, prompt: 3 } as const;
  const feedRows = $derived(
    [...(data.data?.feed ?? [])].sort((a, b) => (feedSort === "kind" ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : 0) || b.ts - a.ts),
  );
  const FEED_ICON = { prompt: MessageSquareText, tool_error: CircleX, tool_rejected: Ban, interrupt: CircleStop } as const;
  const feedText = (e: FeedItem) =>
    e.kind === "prompt"
      ? (e.text ?? t("prompts.noText"))
      : e.kind === "interrupt"
        ? t("live.feed.interrupt")
        : t(e.kind === "tool_error" ? "live.feed.error" : "live.feed.declined", { tool: e.tool ?? t("live.feed.aTool") });
  // A failure's second line: why it failed and the start of its error, all of it on hover. What the call was given
  // (a command, a file) follows its name.
  const feedWhy = (e: FeedItem) =>
    e.reason ? [t(`friction.reason.${e.reason}`), e.detail?.replace(/\s+/g, " ")].filter(Boolean).join(" · ") : null;
  const feedTitle = (e: FeedItem) => [feedText(e), e.reason ? t(`friction.reason.${e.reason}`) : null, e.input, e.detail].filter(Boolean).join("\n\n");
  const quiet = $derived(!!total && total.sum === 0);
  const windowLabel = $derived(minutes < 60 ? t("live.lastMinutes", { n: minutes }) : minutes === 60 ? t("live.lastHour") : t("live.lastHours", { n: minutes / 60 }));
  const time = (ts: number) => new Intl.DateTimeFormat(i18n.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

  type Sort = "recent" | "tokens" | "cost";
  let sort = $state<Sort>("recent");
  const SORTS = $derived((["recent", "tokens", "cost"] as const).map((value) => ({ value: value as Sort, label: t(`sort.${value}`) })));
  const titleOf = (s: LiveSession) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
  // Every tool's color, so a session's swatch reads as the tool it ran in, not the plan it was billed to.
  // Tools with sessions in this window stand out and carry their count.
  const toolCounts = $derived(
    (data.data?.sessions ?? []).reduce((m, s) => m.set(s.provider, (m.get(s.provider) ?? 0) + 1), new Map<string, number>()),
  );
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("live.title")} subtitle={t("live.subtitle")}>
    <div class="seg" role="radiogroup" aria-label={t("live.window")}>
      {#each WINDOWS as m (m)}
        <button role="radio" aria-checked={minutes === m} onclick={() => pick(m)}>{m < 60 ? `${m}m` : `${m / 60}h`}</button>
      {/each}
    </div>
  </PageHeader>

  <ViewGate ready={settled(data, limits)}>
    {#if total}
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Kpi label={t("live.kpi.rate")} value={`${value(total.rate)}/min`} hint={t("live.kpi.rateHint")} />
        <Kpi label={t("live.kpi.peak")} value={`${value(total.peak)}/min`} hint={total.peakAt ? t("live.kpi.peakAt", { time: time(total.peakAt) }) : windowLabel} />
        <Kpi
          label={t("live.kpi.today")}
          value={today ? (metric === "cost" ? usd(today.cost) : compact(today.tokens)) : "–"}
          hint={today && (metric === "cost" ? today.typicalCost : today.typicalTokens) != null
            ? t("live.kpi.todayHint", { value: metric === "cost" ? usd(today.typicalCost) : compact(today.typicalTokens) })
            : t("live.kpi.todayNone")}
        />
        <Kpi label={t("live.kpi.sessions")} value={String(data.data?.sessions.length ?? 0)} hint={t("live.kpi.sessionsHint")} />
        <!-- The sessions the table marks idle: their agent stopped, waiting for the next prompt. -->
        <Kpi label={t("live.kpi.waiting")} value={String(statusCount.get("idle") ?? 0)} hint={t("live.kpi.waitingHint")} />
      </div>
    {/if}

    <div class="grid gap-5 xl:grid-cols-5">
      <Card title={t("live.rate")} subtitle={t(kind === "total" ? "live.totalHint" : "live.rateHint", { window: windowLabel })} class="xl:col-span-3">
        {#snippet actions()}
          <div class="seg" role="radiogroup" aria-label={t("live.metric")}>
            <button role="radio" aria-checked={metric === "tokens"} onclick={() => pickMetric("tokens")}>{t("metric.tokens")}</button>
            <button role="radio" aria-checked={metric === "cost"} onclick={() => pickMetric("cost")}>{t("metric.cost")}</button>
          </div>
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

    <Card title={t("live.harnessLegend")} subtitle={t("live.harnessLegendHint")}>
      <!-- Pull the chips left by their padding + border so the first dot lines up with the title. -->
      <ul class="-ml-[11px] flex flex-wrap items-center gap-2">
        {#each PROVIDERS as p (p)}
          {@const n = toolCounts.get(p) ?? 0}
          <li
            class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs {n ? 'border-line bg-surface-2 text-ink' : 'border-transparent text-muted'}"
            title={n ? t("live.toolSessions", { n }) : undefined}
          >
            <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", p)}></span>
            {PROVIDER_NAMES[p]}
            {#if n}<span class="tabular text-ink-2">{n}</span>{/if}
          </li>
        {/each}
      </ul>
    </Card>

    <TableCard
      title={t("live.sessions")}
      subtitle={t("live.sessionsHint")}
      rows={[...(data.data?.sessions ?? [])].sort((a, b) => (sort === "recent" ? b.lastTs - a.lastTs : b[sort] - a[sort]))}
      searchText={(s) => `${s.title ?? ""} ${s.projectLabel} ${s.gitBranch ?? ""} ${s.model ?? ""} ${s.provider}`}
      sorts={SORTS}
      bind:sortKey={sort}
      exportName="live-sessions"
    >
      {#snippet children(view)}
        <table class="data fixed-cols">
          <colgroup>
            <col />
            <col class="w-40" />
            <col class="w-40" />
            <col class="w-36" />
            <col class="w-44" />
            <col class="w-24" />
            <col class="w-28" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.title")}</th>
              <th>{t("col.status")}</th>
              <th>{t("col.project")}</th>
              <th>{t("col.branch")}</th>
              <th>{t("col.lastTool")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.lastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows.slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as s (s.id)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                <td>
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                    <Link to="#/sessions/{encodeURIComponent(s.id)}" class="truncate font-medium">{titleOf(s)}</Link>
                    {#if s.activeSubagents}
                      <span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-ink-2">{t("live.subagentsWorking", { n: s.activeSubagents })}</span>
                    {:else if s.subagents}
                      <span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{t("live.subagents", { n: s.subagents })}</span>
                    {/if}
                    {#if s.errors}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-bad">{t("live.errors", { n: s.errors })}</span>{/if}
                  </div>
                </td>
                <td>
                  <span class="inline-flex items-center gap-2 text-ink-2">
                    <span class="h-2 w-2 shrink-0 rounded-full" class:animate-pulse={s.status === "working"} style:background={STATUS_COLOR[s.status]}></span>
                    {t(`live.status.${s.status}`)}
                  </span>
                </td>
                <td class="truncate text-ink-2" title={s.project}>{entityLabel("project", s.project, s.projectLabel)}</td>
                <td class="truncate text-ink-2" title={s.gitBranch ?? ""}>{s.gitBranch ?? "–"}</td>
                <td class="truncate text-ink-2" title={s.lastFile ?? s.lastTool ?? ""}>
                  {s.lastTool ?? "–"}{#if s.lastFile}<span class="text-muted"> · {s.lastFile.split(/[\\/]/).pop()}</span>{/if}
                </td>
                <td class="num font-medium">{usd(s.cost)}</td>
                <td class="num text-ink-2">{relative(s.lastTs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>

    <TableCard
      title={t("live.feed")}
      subtitle={t("live.feedHint")}
      rows={feedRows}
      searchText={(e) => `${feedText(e)} ${feedWhy(e) ?? ""} ${e.title ?? ""} ${e.tool ?? ""}`}
      sorts={FEED_SORTS}
      bind:sortKey={feedSort}
      exportName="live-feed"
    >
      {#snippet children(view)}
        <table class="data fixed-cols">
          <colgroup>
            <col class="w-20" />
            <col />
            <col class="w-72" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.time")}</th>
              <th>{t("live.feed.event")}</th>
              <th>{t("col.session")}</th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows.slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as e, i (`${e.ts}:${e.kind}:${e.sessionId}:${i}`)}
              {@const Icon = FEED_ICON[e.kind]}
              {@const why = feedWhy(e)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", e.sessionId)}>
                <td class="text-ink-2 tabular">{time(e.ts)}</td>
                <td>
                  <span class="flex min-w-0 items-center gap-2.5">
                    <Icon size={14} class="shrink-0 {e.kind === 'prompt' ? 'text-muted' : e.kind === 'tool_error' ? 'text-bad' : 'text-warn'}" />
                    <Link to="#/sessions/{encodeURIComponent(e.sessionId)}" class="truncate {e.kind === 'prompt' ? 'text-ink' : 'text-ink-2'}" title={feedTitle(e)}>{feedText(e)}</Link>
                    {#if e.input}<span class="min-w-0 truncate font-mono text-xs text-muted" title={e.input}>{e.input}</span>{/if}
                  </span>
                  {#if why}<span class="mt-0.5 block truncate pl-6 text-xs text-muted" title={feedTitle(e)}>{why}</span>{/if}
                </td>
                <td>
                  <span class="flex min-w-0 items-center gap-2 text-ink-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", e.provider)}></span>
                    <span class="truncate" title={e.title ?? e.sessionId}>{e.title ?? e.sessionId}</span>
                  </span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>
  </ViewGate>
</div>
