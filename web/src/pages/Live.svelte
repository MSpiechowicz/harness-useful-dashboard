<script lang="ts">
  import { Ban, ChevronDown, ChevronUp, CircleStop, CircleX, Gauge, MessageSquareText, ServerCrash } from "@lucide/svelte";
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
  import { everyWhileVisible } from "../lib/visibility.ts";
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
    /** Model requests that failed in the window (rate limits, overloads, …). */
    apiErrors: number;
    /** The main agent's own share of the totals, its subagents left out. */
    ownTokens: number;
    ownCost: number;
    /** Its subagent runs with activity in the window, newest first (the first few), and how many there were. */
    runs: LiveRun[];
    runCount: number;
  }
  /** One subagent run: a child session (omp, pi, Codex, OpenCode), or one subagent in a Claude Code session's own log. */
  interface LiveRun {
    key: string;
    /** The run's own session, when it has one to open. */
    sessionId: string | null;
    agent: string | null;
    brief: string | null;
    tokens: number;
    cost: number;
    messages: number;
    firstTs: number;
    lastTs: number;
    status: "working" | "idle" | "error";
    lastTool: string | null;
    lastFile: string | null;
    errors: number;
  }
  type FailureReason = "timeout" | "edit_mismatch" | "stale_read" | "not_found" | "permission" | "exit_code" | "bad_input" | "other" | "rejected";
  type ApiClass = "rate_limit" | "overloaded" | "server_error" | "timeout" | "network" | "auth" | "billing" | "context_length" | "other";
  interface FeedItem {
    ts: number;
    kind: "prompt" | "tool_error" | "tool_rejected" | "interrupt" | "api_error";
    text: string | null;
    tool: string | null;
    /** Why a failed or declined call failed, its error text and what it was given. A failed request's class and message. */
    reason: FailureReason | ApiClass | null;
    detail: string | null;
    input: string | null;
    /** A failed request's HTTP status and the model it went to. */
    status: number | null;
    model: string | null;
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
  // A hidden tab skips it and refreshes once shown again.
  let tick = $state(0);
  let now = $state(Date.now());
  $effect(() =>
    everyWhileVisible(60_000, () => {
      tick++;
      now = Date.now();
    }),
  );
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
  /** Feed rows showing their command and error text. */
  let open = $state<Record<string, boolean>>({});
  const FEED_SORTS = $derived<{ value: FeedSort; label: string }[]>([
    { value: "recent", label: t("sort.recent") },
    { value: "kind", label: t("live.feed.byKind") },
  ]);
  const KIND_ORDER = { tool_error: 0, api_error: 1, tool_rejected: 2, interrupt: 3, prompt: 4 } as const;
  const feedRows = $derived(
    [...(data.data?.feed ?? [])].sort((a, b) => (feedSort === "kind" ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : 0) || b.ts - a.ts),
  );
  const FEED_ICON = { prompt: MessageSquareText, tool_error: CircleX, tool_rejected: Ban, interrupt: CircleStop, api_error: ServerCrash } as const;
  const feedText = (e: FeedItem) =>
    e.kind === "prompt"
      ? (e.text ?? t("prompts.noText"))
      : e.kind === "interrupt"
        ? t("live.feed.interrupt")
        : e.kind === "api_error"
          ? t("live.feed.apiError", { model: e.model ? entityLabel("model", e.model, e.model) : t("live.feed.aModel") })
          : t(e.kind === "tool_error" ? "live.feed.error" : "live.feed.declined", { tool: e.tool ?? t("live.feed.aTool") });
  /** The cause's label: a tool failure's (friction.reason.*) or a failed request's (friction.api.*). */
  const reasonLabel = (e: FeedItem) =>
    !e.reason ? null : e.kind === "api_error" ? t(`friction.api.${e.reason as ApiClass}`) : t(`friction.reason.${e.reason as FailureReason}`);
  const statusLine = (e: FeedItem) => (e.status ? t("friction.api.status", { code: e.status }) : null);
  // A failure's second line: why it failed and the start of its error, all of it on hover. What the call was given
  // (a command, a file) follows its name.
  const feedWhy = (e: FeedItem) => (e.reason ? [reasonLabel(e), e.detail?.replace(/\s+/g, " ")].filter(Boolean).join(" · ") : null);
  const feedTitle = (e: FeedItem) => [feedText(e), reasonLabel(e), statusLine(e), e.input, e.detail].filter(Boolean).join("\n\n");
  const quiet = $derived(!!total && total.sum === 0);
  const windowLabel = $derived(minutes < 60 ? t("live.lastMinutes", { n: minutes }) : minutes === 60 ? t("live.lastHour") : t("live.lastHours", { n: minutes / 60 }));
  const time = (ts: number) => new Intl.DateTimeFormat(i18n.locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ts);

  type Sort = "recent" | "tokens" | "cost";
  let sort = $state<Sort>("recent");
  const SORTS = $derived((["recent", "tokens", "cost"] as const).map((value) => ({ value: value as Sort, label: t(`sort.${value}`) })));
  const titleOf = (s: LiveSession) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
  // A session's subagents open beneath it: by default while any of them is working, else as last toggled on this page.
  let runsOpen = $state<Record<string, boolean>>({});
  const showRuns = (s: LiveSession) => s.runs.length > 0 && (runsOpen[s.id] ?? s.runs.some((r) => r.status === "working"));
  // A finished subagent is done, not waiting for a prompt like an idle session.
  const runStatus = (r: LiveRun) => t(r.status === "idle" ? "live.status.done" : `live.status.${r.status}`);
  const runTarget = (s: LiveSession, r: LiveRun) => r.sessionId ?? s.id;
  // The export has a line per session and per subagent listed under it, which names its session.
  const exportSessions = (rows: LiveSession[]) =>
    rows.flatMap(({ runs, ...s }) => [
      { ...s, parent: null, agent: null, brief: null },
      ...runs.map((r) => ({
        id: r.sessionId ?? r.key, title: r.agent, parent: s.id, agent: r.agent, brief: r.brief, provider: s.provider, project: s.project,
        status: r.status, lastTool: r.lastTool, lastFile: r.lastFile, tokens: r.tokens, cost: r.cost, messages: r.messages,
        errors: r.errors, firstTs: r.firstTs, lastTs: r.lastTs,
      })),
    ]);
  // Every tool's color, so a session's swatch reads as the tool it ran in, not the plan it was billed to.
  // Tools with sessions in this window stand out and carry their count.
  const toolCounts = $derived(
    (data.data?.sessions ?? []).reduce((m, s) => m.set(s.provider, (m.get(s.provider) ?? 0) + 1), new Map<string, number>()),
  );
</script>

<!-- Failed calls as one small count after the title, so the title keeps its room. What failed is in the tooltip. -->
{#snippet failed(errors: number, apiErrors: number)}
  {@const label = [errors ? t("live.errors", { n: errors }) : null, apiErrors ? t("live.apiErrors", { n: apiErrors }) : null].filter(Boolean).join(" · ")}
  <span class="inline-flex shrink-0 items-center gap-0.5 text-xs text-bad tabular" title={label} aria-label={label}>
    <CircleX size={12} />{errors + apiErrors}
  </span>
{/snippet}

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
      searchText={(s) => `${s.title ?? ""} ${s.projectLabel} ${s.gitBranch ?? ""} ${s.model ?? ""} ${s.provider} ${s.runs.map((r) => `${r.agent ?? ""} ${r.brief ?? ""}`).join(" ")}`}
      sorts={SORTS}
      bind:sortKey={sort}
      exportName="live-sessions"
      exportRows={exportSessions}
    >
      {#snippet children(view)}
        <!-- Branch shares the project's cell, so the table fits a card about 1000px wide without scrolling sideways. -->
        <table class="data fixed-cols !min-w-[52rem]">
          <colgroup>
            <col />
            <col class="w-36" />
            <col class="w-44" />
            <col class="w-36" />
            <col class="w-24" />
            <col class="w-28" />
            <col class="w-[5.5rem]" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.title")}</th>
              <th>{t("col.status")}</th>
              <th>{t("col.project")}</th>
              <th>{t("col.lastTool")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.lastSeen")}</th>
              <th><span class="sr-only">{t("live.runs.show")}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows.slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as s (s.id)}
              {@const opened = showRuns(s)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                <td>
                  <!-- The title keeps room to be read: the error counts after it give way first. -->
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                    <Link to="#/sessions/{encodeURIComponent(s.id)}" class="min-w-24 truncate font-medium" title={titleOf(s)}>{titleOf(s)}</Link>
                    {#if s.errors || s.apiErrors}{@render failed(s.errors, s.apiErrors)}{/if}
                  </div>
                </td>
                <td>
                  <span class="inline-flex items-center gap-2 text-ink-2">
                    <span class="h-2 w-2 shrink-0 rounded-full" class:animate-pulse={s.status === "working"} style:background={STATUS_COLOR[s.status]}></span>
                    {t(`live.status.${s.status}`)}
                  </span>
                </td>
                <td class="truncate text-ink-2" title={[s.project, s.gitBranch].filter(Boolean).join("\n")}>
                  {entityLabel("project", s.project, s.projectLabel)}{#if s.gitBranch}<span class="ml-1 text-muted">· {s.gitBranch}</span>{/if}
                </td>
                <td class="truncate text-ink-2" title={s.lastFile ?? s.lastTool ?? ""}>
                  {s.lastTool ?? "–"}{#if s.lastFile}<span class="ml-1 text-muted">· {s.lastFile.split(/[\\/]/).pop()}</span>{/if}
                </td>
                <td class="num font-medium">{usd(s.cost)}</td>
                <td class="num text-ink-2">{relative(s.lastTs)}</td>
                <td class="text-right">
                  {#if s.runs.length}
                    <!-- Down when closed, up when open, as in the activity table. The count is every subagent in the window. -->
                    <button
                      type="button"
                      class="btn -my-1 !h-7 !gap-1 !px-2 tabular"
                      aria-expanded={opened}
                      aria-label={`${t(opened ? "live.runs.hide" : "live.runs.show")} (${s.runCount})`}
                      title={t(opened ? "live.runs.hide" : "live.runs.show")}
                      onclick={(ev) => {
                        ev.stopPropagation();
                        runsOpen[s.id] = !opened;
                      }}
                    >
                      {s.runCount}{#if opened}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
                    </button>
                  {/if}
                </td>
              </tr>
              {#if opened}
                {@const more = s.runCount - s.runs.length}
                {#each s.runs as r, i (r.key)}
                  {@const last = i === s.runs.length - 1 && !more}
                  <tr class="cursor-pointer" onclick={() => navigate("sessions", runTarget(s, r))}>
                    <td class="relative">
                      <!-- A tree line from the session's swatch to each of its subagents. -->
                      <span class="absolute top-0 left-[calc(1.25rem+4px)] w-px bg-line {last ? 'h-1/2' : 'bottom-0'}"></span><span class="absolute top-1/2 left-[calc(1.25rem+4px)] h-px w-2.5 bg-line"></span>
                      <div class="flex items-center gap-2 pl-[18px]">
                        <Link to="#/sessions/{encodeURIComponent(runTarget(s, r))}" class="max-w-[60%] shrink-0 truncate text-ink">{r.agent ?? t("live.runs.subagent")}</Link>
                        {#if r.brief && r.brief !== r.agent}<span class="min-w-0 truncate text-muted" title={r.brief}>{r.brief}</span>{/if}
                        {#if r.errors}{@render failed(r.errors, 0)}{/if}
                      </div>
                    </td>
                    <td>
                      <span class="inline-flex items-center gap-2 text-ink-2">
                        <span class="h-2 w-2 shrink-0 rounded-full" class:animate-pulse={r.status === "working"} style:background={STATUS_COLOR[r.status]}></span>
                        {runStatus(r)}
                      </span>
                    </td>
                    <td></td>
                    <td class="truncate text-ink-2" title={r.lastFile ?? r.lastTool ?? ""}>
                      {r.lastTool ?? "–"}{#if r.lastFile}<span class="ml-1 text-muted">· {r.lastFile.split(/[\\/]/).pop()}</span>{/if}
                    </td>
                    <td class="num text-ink-2">{usd(r.cost)}</td>
                    <td class="num text-ink-2">{relative(r.lastTs)}</td>
                    <td></td>
                  </tr>
                {/each}
                {#if more > 0}
                  <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                    <td class="relative" colspan="7">
                      <span class="absolute top-0 left-[calc(1.25rem+4px)] w-px bg-line h-1/2"></span><span class="absolute top-1/2 left-[calc(1.25rem+4px)] h-px w-2.5 bg-line"></span>
                      <div class="pl-[18px] text-xs text-muted">{t("live.runs.more", { n: more })}</div>
                    </td>
                  </tr>
                {/if}
              {/if}
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>

    <TableCard
      title={t("live.feed")}
      subtitle={t("live.feedHint")}
      rows={feedRows}
      searchText={(e) => `${feedText(e)} ${feedWhy(e) ?? ""} ${e.input ?? ""} ${e.title ?? ""} ${e.tool ?? ""}`}
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
            <col class="w-16" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.time")}</th>
              <th>{t("live.feed.event")}</th>
              <th>{t("col.session")}</th>
              <th><span class="sr-only">{t("friction.showError")}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows.slice(view.offset, view.limit == null ? undefined : view.offset + view.limit) as e, i (`${e.ts}:${e.kind}:${e.sessionId}:${i}`)}
              {@const Icon = FEED_ICON[e.kind]}
              {@const key = `${e.ts}:${e.kind}:${e.sessionId}:${i}`}
              {@const expandable = !!(e.input || e.detail || e.status)}
              {@const expanded = expandable && !!open[key]}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", e.sessionId)}>
                <td class="text-ink-2 tabular">{time(e.ts)}</td>
                <td>
                  <!-- One line a row: what happened, and why as a pill. The command and the error text open below with the
                       button in the last column. -->
                  <span class="flex min-w-0 items-center gap-2.5">
                    <Icon size={14} class="shrink-0 {e.kind === 'prompt' ? 'text-muted' : e.kind === 'tool_error' || e.kind === 'api_error' ? 'text-bad' : 'text-warn'}" />
                    <Link to="#/sessions/{encodeURIComponent(e.sessionId)}" class={e.kind === "prompt" ? "truncate text-ink" : "shrink-0 text-ink-2"} title={feedTitle(e)}>{feedText(e)}</Link>
                    {#if e.reason}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] {e.kind === 'tool_error' || e.kind === 'api_error' ? 'text-bad' : 'text-muted'}">{reasonLabel(e)}</span>{/if}
                  </span>
                </td>
                <td>
                  <span class="flex min-w-0 items-center gap-2 text-ink-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", e.provider)}></span>
                    <span class="truncate" title={e.title ?? e.sessionId}>{e.title ?? e.sessionId}</span>
                  </span>
                </td>
                <td class="text-right">
                  {#if expandable}
                    <!-- Down, not right: a right chevron is the pager's "next page". -->
                    <button
                      type="button"
                      class="btn !h-7 !px-2"
                      aria-expanded={expanded}
                      aria-label={t(expanded ? "friction.hideError" : "friction.showError")}
                      title={t(expanded ? "friction.hideError" : "friction.showError")}
                      onclick={(ev) => {
                        ev.stopPropagation();
                        open[key] = !expanded;
                      }}
                    >
                      {#if expanded}<ChevronUp size={14} />{:else}<ChevronDown size={14} />{/if}
                    </button>
                  {/if}
                </td>
              </tr>
              {#if expanded}
                <tr class="bg-surface-2">
                  <td></td>
                  <td colspan="3" class="!whitespace-normal">
                    {#if e.input}<pre class="mb-2 font-mono text-xs break-all whitespace-pre-wrap text-muted">{e.input}</pre>{/if}
                    {#if statusLine(e)}<pre class="mb-2 font-mono text-xs text-muted">{statusLine(e)}</pre>{/if}
                    {#if e.detail}<pre class="max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{e.detail}</pre>{/if}
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>
  </ViewGate>
</div>
