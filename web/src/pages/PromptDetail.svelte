<script lang="ts">
  import { ArrowLeft, Sparkles } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import KeyCountList from "../components/KeyCountList.svelte";
  import Kpi from "../components/Kpi.svelte";
  import { qs, useFetch, type Totals } from "../lib/api.svelte.ts";
  import { callTimeline, type CallRow } from "../lib/charts.ts";
  import { compact, dateTime, percent, time, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  let { id }: { id: string } = $props();

  interface Detail {
    prompt: { id: string; ts: number; text: string | null; skill: string | null; session_id: string; project: string | null; sessionTitle: string | null; provider: string } | null;
    totals: Totals | null;
    timeline: CallRow[];
    tools: { key: string; calls: number }[];
    files: { key: string; calls: number }[];
    agents: (Totals & { key: string })[];
  }

  const d = useFetch<Detail>(() => `/api/prompt${qs({ id })}`);
  let tlMetric = $state<"tokens" | "cost">("tokens");
  const p = $derived(d.data?.prompt);
  const tot = $derived(d.data?.totals);
  const hit = $derived(tot && tot.input + tot.cacheRead + tot.cacheWrite ? tot.cacheRead / (tot.input + tot.cacheRead + tot.cacheWrite) : 0);
  const subCost = $derived((d.data?.agents ?? []).filter((a) => a.key !== "main").reduce((a, r) => a + r.cost, 0));
  const toolCalls = $derived((d.data?.tools ?? []).reduce((a, r) => a + r.calls, 0));
  const timelineOption = $derived.by(() => (void store.dark, d.data && d.data.timeline.length ? callTimeline(d.data.timeline, tlMetric, time) : null));
</script>

<div class="flex flex-col gap-5">
  <a href="#/prompts" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("prompts.back")}</a>

  {#if d.data && !p}
    <div class="card"><Empty title={t("prompts.notFound")} compact /></div>
  {:else if p && d.data}
    <Card>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span>{dateTime(p.ts)}</span>
        <a class="text-accent-ink hover:underline" href="#/sessions/{encodeURIComponent(p.session_id)}">{p.sessionTitle ?? p.session_id}</a>
        <span class="font-mono">{p.project}</span>
        {#if p.skill}<span class="inline-flex items-center gap-1 text-accent-ink"><Sparkles size={11} />{p.skill}</span>{/if}
      </div>
      <p class="mt-3 max-h-72 overflow-auto text-sm leading-relaxed whitespace-pre-wrap text-ink">{p.text ?? t("prompts.noText")}</p>
    </Card>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi label={t("col.cost")} value={usd(tot?.cost)} hint={subCost > 0 ? t("prompts.subagentCost", { cost: usd(subCost) }) : undefined} />
      <Kpi label={t("col.tokens")} value={compact(tot?.tokens)} hint={`${t("tok.output")}: ${compact(tot?.output)}`} />
      <Kpi label={t("kpi.messages")} value={compact(tot?.messages)} hint={`${compact(toolCalls)} ${t("col.tools")}`} />
      <Kpi label={t("kpi.cacheHit")} value={percent(hit, 1)} />
    </div>

    <Card title={t("chart.timeline")} subtitle={t("prompts.calls", { n: d.data.timeline.length })}>
      {#snippet actions()}
        <div class="seg" role="group">
          <button aria-pressed={tlMetric === "tokens"} onclick={() => (tlMetric = "tokens")}>{t("metric.tokens")}</button>
          <button aria-pressed={tlMetric === "cost"} onclick={() => (tlMetric = "cost")}>{t("metric.cost")}</button>
        </div>
      {/snippet}
      {#if timelineOption}<Chart option={timelineOption} height={260} />{:else}<Empty compact title={t("empty.noData")} />{/if}
    </Card>

    <div class="grid gap-5 lg:grid-cols-3">
      <Card title={t("tools.topTools")}>{#if d.data.tools.length}<KeyCountList items={d.data.tools.slice(0, 15)} />{:else}<Empty compact title={t("empty.noData")} />{/if}</Card>
      <Card title={t("tools.files")}>{#if d.data.files.length}<KeyCountList items={d.data.files.slice(0, 15).map((f) => ({ ...f, key: f.key.split(/[\\/]/).slice(-2).join("/") }))} mono color="var(--series-3)" />{:else}<Empty compact title={t("empty.noData")} />{/if}</Card>
      <Card title={t("skills.agents")}><KeyCountList items={d.data.agents} value="cost" color="var(--series-7)" /></Card>
    </div>
  {/if}
</div>
