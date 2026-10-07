<script lang="ts">
  import { ChevronDown, ChevronRight } from "@lucide/svelte";
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
  import { compact, dateTime, decimal, entityLabel, percent, relative } from "../lib/format.ts";
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
    tools: (Counts & { key: string; topReason: Reason | null })[];
    models: (Counts & { key: string })[];
    sessions: (Counts & { id: string; title: string | null; project: string | null; projectLabel: string; provider: string; lastTs: number })[];
    reasons: { reason: Reason; count: number; share: number; tools: { tool: string; count: number }[] }[];
    recent: Failure[];
  }
  type Reason = "timeout" | "edit_mismatch" | "stale_read" | "not_found" | "permission" | "exit_code" | "bad_input" | "other" | "rejected";
  interface Failure {
    id: string;
    ts: number;
    kind: "tool_error" | "tool_rejected";
    tool: string | null;
    reason: Reason;
    detail: string | null;
    input: string | null;
    sessionId: string;
    title: string | null;
    provider: string;
    projectLabel: string;
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

  const reasonLabel = (r: Reason) => t(`friction.reason.${r}`);

  // Why calls failed: a cause's row shows its calls in the recent failures table (by searching for it).
  const reasons = $derived(d.data?.reasons ?? []);
  const maxReason = $derived(Math.max(1, ...reasons.map((r) => r.count)));
  let recentQuery = $state("");
  let recentCard = $state<HTMLElement>();
  function showReason(r: Reason) {
    recentQuery = reasonLabel(r);
    recentCard?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  type RecentSort = "recent" | "reason" | "tool";
  let recentSort = $state<RecentSort>("recent");
  const RECENT_SORTS = $derived<{ value: RecentSort; label: string; asc?: boolean }[]>([
    { value: "recent", label: t("sort.recent") },
    { value: "reason", label: t("friction.col.reason"), asc: true },
    { value: "tool", label: t("col.tool"), asc: true },
  ]);
  const recent = $derived.by(() => {
    const rows = [...(d.data?.recent ?? [])];
    if (recentSort === "reason") return rows.sort((a, b) => reasonLabel(a.reason).localeCompare(reasonLabel(b.reason)) || b.ts - a.ts);
    if (recentSort === "tool") return rows.sort((a, b) => (a.tool ?? "").localeCompare(b.tool ?? "") || b.ts - a.ts);
    return rows;
  });
  let open = $state<Record<string, boolean>>({});
  const errorTitle = (f: Failure) => [f.input, f.detail].filter(Boolean).join("\n\n");

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

      <Card
        title={t("friction.reasons")}
        subtitle={t("friction.reasonsHint")}
        exportName={reasons.length ? "friction-reasons" : undefined}
        exportRows={() => reasons.map((r) => ({ reason: r.reason, label: reasonLabel(r.reason), calls: r.count, share: r.share, tools: r.tools.map((x) => `${x.tool} ${x.count}`).join(", ") }))}
      >
        {#if reasons.length}
          <ul class="-mx-2 grid gap-x-6 md:grid-cols-2 xl:grid-cols-3" class:loading-dim={d.loading}>
            {#each reasons as r (r.reason)}
              <li>
                <button
                  type="button"
                  class="group grid w-full grid-cols-[minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-left hover:bg-surface-2"
                  title={t("friction.reasonFilter")}
                  onclick={() => showReason(r.reason)}
                >
                  <span class="truncate text-[13px] text-ink-2 group-hover:text-ink">{reasonLabel(r.reason)}</span>
                  <span class="tabular text-right text-[13px] font-medium text-ink">{compact(r.count)}</span>
                  <span class="tabular text-right text-xs text-muted">{percent(r.share, r.share < 0.1 ? 1 : 0)}</span>
                  <span class="col-span-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <span
                      class="block h-full rounded-full"
                      style:width="{Math.max(0.5, (r.count / maxReason) * 100)}%"
                      style:background={r.reason === "rejected" ? "var(--status-warning)" : "var(--status-critical)"}
                    ></span>
                  </span>
                  <span class="col-span-3 truncate text-xs text-muted">{r.tools.map((x) => `${toolName(x.tool)} ${compact(x.count)}`).join(" · ")}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <Empty compact />
        {/if}
      </Card>

      <TableCard title={t("friction.byTool")} subtitle={t("friction.byToolHint")} rows={tools} searchText={(r) => r.key} sorts={TOOL_SORTS} bind:sortKey={toolSort} bind:asc={toolAsc} exportName="friction-by-tool">
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-24" />
              <col class="w-24" />
              <col class="w-36" />
              <col class="w-24" />
              <col class="w-48" />
            </colgroup>
            <thead>
              <tr>
                <SortTh label={t("col.tool")} sort={toolDir("key")} onclick={() => sortTools("key")} />
                <SortTh num label={t("col.calls")} sort={toolDir("calls")} onclick={() => sortTools("calls")} />
                <SortTh num label={t("friction.errors")} sort={toolDir("errors")} onclick={() => sortTools("errors")} />
                <SortTh num label={t("friction.errorRate")} sort={toolDir("errorRate")} onclick={() => sortTools("errorRate")} />
                <SortTh num label={t("friction.rejected")} sort={toolDir("rejected")} onclick={() => sortTools("rejected")} />
                <th>{t("friction.mainReason")}</th>
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
                  <td class="truncate text-ink-2">{r.topReason ? reasonLabel(r.topReason) : "–"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>

      <div bind:this={recentCard} class="scroll-mt-20">
        <TableCard
          title={t("friction.recent")}
          subtitle={t("friction.recentHint", { n: compact(d.data.recent.length) })}
          rows={recent}
          searchText={(f) => `${reasonLabel(f.reason)} ${f.tool ?? ""} ${f.input ?? ""} ${f.detail ?? ""} ${f.title ?? ""}`}
          sorts={RECENT_SORTS}
          bind:sortKey={recentSort}
          bind:query={recentQuery}
          exportName="friction-failures"
        >
          {#snippet children(view)}
            <table class="data fixed-cols">
              <colgroup>
                <col class="w-32" />
                <col class="w-36" />
                <col class="w-44" />
                <col />
                <col class="w-56" />
                <col class="w-16" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t("col.time")}</th>
                  <th>{t("col.tool")}</th>
                  <th>{t("friction.col.reason")}</th>
                  <th>{t("friction.col.error")}</th>
                  <th>{t("col.session")}</th>
                  <th><span class="sr-only">{t("friction.showError")}</span></th>
                </tr>
              </thead>
              <tbody>
                {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as f (f.id)}
                  {@const expanded = !!open[f.id]}
                  <tr class="cursor-pointer" onclick={() => navigate("sessions", f.sessionId)}>
                    <td class="text-ink-2 tabular" title={dateTime(f.ts)}>{relative(f.ts)}</td>
                    <td class="truncate text-ink" title={f.tool ?? ""}>{f.tool ? toolName(f.tool) : t("live.feed.aTool")}</td>
                    <td>
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="h-2 w-2 shrink-0 rounded-full" style:background={f.reason === "rejected" ? "var(--status-warning)" : "var(--status-critical)"}></span>
                        <span class="truncate text-ink-2">{reasonLabel(f.reason)}</span>
                      </span>
                    </td>
                    <td title={errorTitle(f)}>
                      <!-- One line: the error. Its command or file and the full text open below. -->
                      {#if f.detail}
                        <div class="truncate text-ink-2">{f.detail.replace(/\s+/g, " ")}</div>
                      {:else}
                        <div class="truncate text-muted italic">{t("friction.noDetail")}</div>
                      {/if}
                    </td>
                    <td>
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", f.provider)} title={f.provider}></span>
                        <Link to="#/sessions/{encodeURIComponent(f.sessionId)}" class="truncate text-ink-2" title={f.title ?? f.sessionId}>{titleOf({ id: f.sessionId, title: f.title })}</Link>
                      </span>
                    </td>
                    <td class="text-right">
                      {#if f.detail || f.input}
                        <button
                          type="button"
                          class="btn !h-7 !px-2"
                          aria-expanded={expanded}
                          aria-label={t(expanded ? "friction.hideError" : "friction.showError")}
                          title={t(expanded ? "friction.hideError" : "friction.showError")}
                          onclick={(e) => {
                            e.stopPropagation();
                            open[f.id] = !expanded;
                          }}
                        >
                          {#if expanded}<ChevronDown size={14} />{:else}<ChevronRight size={14} />{/if}
                        </button>
                      {/if}
                    </td>
                  </tr>
                  {#if expanded}
                    <tr class="bg-surface-2">
                      <td colspan="6" class="!whitespace-normal">
                        {#if f.input}<pre class="mb-2 font-mono text-xs break-all whitespace-pre-wrap text-muted">{f.input}</pre>{/if}
                        {#if f.detail}<pre class="max-h-64 overflow-auto font-mono text-xs break-words whitespace-pre-wrap text-ink-2">{f.detail}</pre>{/if}
                      </td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          {/snippet}
        </TableCard>
      </div>

      <TableCard title={t("friction.sessions")} subtitle={t("friction.sessionsHint")} rows={sessions} searchText={(s) => `${s.title ?? ""} ${s.projectLabel}`} sorts={SESSION_SORTS} bind:sortKey={sessionSort} exportName="friction-sessions">
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
