<script lang="ts">
  import ViewGate from "../components/ViewGate.svelte";
  import { ArrowLeft, GitBranch, Sparkles } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import KeyCountList from "../components/KeyCountList.svelte";
  import Kpi from "../components/Kpi.svelte";
  import { qs, settled, useFetch, type Totals } from "../lib/api.svelte.ts";
  import { callTimeline, type CallRow } from "../lib/charts.ts";
  import { compact, dateTime, percent, time, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  let { id }: { id: string } = $props();

  interface Detail {
    session: { id: string; title: string | null; project: string | null; provider: string; git_branch: string | null; client: string | null; client_version: string | null; agent: string | null; parent_session_id: string | null; started_at: number; ended_at: number; user: string; host: string } | null;
    totals: Totals | null;
    prompts: { id: string; ts: number; text: string | null; skill: string | null; tokens: number; cost: number; messages: number; toolCalls: number }[];
    timeline: (CallRow & { promptId: string | null })[];
    models: (Totals & { key: string })[];
    agents: (Totals & { key: string })[];
    tools: { key: string; calls: number }[];
    files: { key: string; calls: number }[];
    children: { id: string; agent: string | null; title: string | null; tokens: number; cost: number }[];
  }

  const d = useFetch<Detail>(() => `/api/session${qs({ id })}`);
  let tlMetric = $state<"tokens" | "cost">("tokens");
  const s = $derived(d.data?.session);
  const tot = $derived(d.data?.totals);
  const hit = $derived(tot && tot.input + tot.cacheRead + tot.cacheWrite ? tot.cacheRead / (tot.input + tot.cacheRead + tot.cacheWrite) : 0);
  const maxPromptCost = $derived(Math.max(1e-9, ...(d.data?.prompts ?? []).map((p) => p.cost)));
  const timelineOption = $derived.by(() => {
    void store.dark;
    return d.data && d.data.timeline.length ? callTimeline(d.data.timeline, tlMetric, time) : null;
  });
</script>

<div class="flex flex-col gap-5">
  <ViewGate ready={settled(d)}>
    <a href="#/sessions" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("sessions.back")}</a>

    {#if d.data && !s && !d.data.timeline.length}
      <div class="card"><Empty title={t("sessions.notFound")} compact /></div>
    {:else if d.data}
      <div>
        <h1 class="text-xl font-semibold tracking-tight">{s?.title ?? id}</h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span class="font-mono">{s?.project}</span>
          {#if s?.git_branch}<span class="inline-flex items-center gap-1"><GitBranch size={11} />{s.git_branch}</span>{/if}
          <span>{s?.provider}{s?.client ? ` · ${s.client}` : ""}{s?.client_version ? ` ${s.client_version}` : ""}</span>
          <span>{dateTime(s?.started_at)} – {s?.ended_at ? time(s.ended_at) : ""}</span>
          <span>{s?.user}@{s?.host}</span>
          {#if s?.parent_session_id}<a class="text-accent-ink hover:underline" href="#/sessions/{encodeURIComponent(s.parent_session_id)}">↖ {t("sessions.parent")}</a>{/if}
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("col.cost")} value={usd(tot?.cost)} />
        <Kpi label={t("col.tokens")} value={compact(tot?.tokens)} hint={`${t("tok.output")}: ${compact(tot?.output)}`} />
        <Kpi label={t("kpi.messages")} value={compact(tot?.messages)} hint={`${d.data.prompts.length} ${t("col.prompts")}`} />
        <Kpi label={t("kpi.cacheHit")} value={percent(hit, 1)} />
      </div>

      <Card title={t("chart.timeline")} subtitle={t("prompts.calls", { n: d.data.timeline.length })}>
        {#snippet actions()}
          <div class="seg" role="group">
            <button aria-pressed={tlMetric === "tokens"} onclick={() => (tlMetric = "tokens")}>{t("metric.tokens")}</button>
            <button aria-pressed={tlMetric === "cost"} onclick={() => (tlMetric = "cost")}>{t("metric.cost")}</button>
          </div>
        {/snippet}
        {#if timelineOption}<Chart option={timelineOption} height={280} />{/if}
      </Card>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card title={t("sessions.promptsInSession")} class="xl:col-span-2" pad={false}>
          <div class="max-h-[560px] overflow-auto">
            <table class="data">
              <thead><tr><th>{t("col.prompt")}</th><th class="num">{t("col.messages")}</th><th class="num">{t("col.tools")}</th><th class="num">{t("col.tokens")}</th><th class="num">{t("col.cost")}</th></tr></thead>
              <tbody>
                {#each d.data.prompts as p (p.id)}
                  <tr class="cursor-pointer" onclick={() => navigate("prompts", p.id)}>
                    <td class="max-w-md">
                      <div class="text-[11px] text-muted">{time(p.ts)}</div>
                      <div class="line-clamp-2">{p.text ?? t("prompts.noText")}</div>
                      {#if p.skill}<div class="inline-flex items-center gap-1 text-[11px] text-accent-ink"><Sparkles size={10} />{p.skill}</div>{/if}
                    </td>
                    <td class="num text-ink-2">{p.messages}</td>
                    <td class="num text-ink-2">{p.toolCalls}</td>
                    <td class="num text-ink-2">{compact(p.tokens)}</td>
                    <td class="num">
                      <div class="flex items-center justify-end gap-2">
                        <div class="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3"><div class="h-full rounded-full bg-data" style:width="{(p.cost / maxPromptCost) * 100}%"></div></div>
                        <span class="font-medium">{usd(p.cost)}</span>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Card>
        <div class="flex flex-col gap-5">
          <Card title={t("chart.byModel")}><KeyCountList items={d.data.models} value="cost" /></Card>
          {#if d.data.agents.length > 1}<Card title={t("skills.agents")}><KeyCountList items={d.data.agents} value="cost" /></Card>{/if}
          {#if d.data.children.length}
            <Card title={t("sessions.children")}>
              <ul class="flex flex-col gap-1 text-sm">
                {#each d.data.children as c (c.id)}
                  <li class="flex justify-between gap-2"><a class="truncate text-accent-ink hover:underline" href="#/sessions/{encodeURIComponent(c.id)}">{c.agent ?? c.title ?? c.id}</a><span class="tabular text-xs">{usd(c.cost)}</span></li>
                {/each}
              </ul>
            </Card>
          {/if}
          {#if d.data.tools.length}<Card title={t("tools.topTools")}><KeyCountList items={d.data.tools.slice(0, 12)} /></Card>{/if}
          {#if d.data.files.length}<Card title={t("tools.files")}><KeyCountList items={d.data.files.slice(0, 12).map((f) => ({ ...f, key: f.key.split(/[\\/]/).slice(-2).join("/") }))} mono /></Card>{/if}
        </div>
      </div>
    {:else}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {/if}
  </ViewGate>
</div>
