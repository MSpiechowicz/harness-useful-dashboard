<script lang="ts">
  import Link from "../components/Link.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { ArrowLeft, Sparkles } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import ListCard from "../components/ListCard.svelte";
  import Kpi from "../components/Kpi.svelte";
  import { qs, settled, useFetch, type Totals } from "../lib/api.svelte.ts";
  import type { CallRow } from "../lib/charts.ts";
  import CallCharts from "../components/CallCharts.svelte";
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
  const p = $derived(d.data?.prompt);
  const tot = $derived(d.data?.totals);
  const hit = $derived(tot && tot.input + tot.cacheRead + tot.cacheWrite ? tot.cacheRead / (tot.input + tot.cacheRead + tot.cacheWrite) : 0);
  const subCost = $derived((d.data?.agents ?? []).filter((a) => a.key !== "main").reduce((a, r) => a + r.cost, 0));
  const toolCalls = $derived((d.data?.tools ?? []).reduce((a, r) => a + r.calls, 0));
</script>

<div class="flex flex-col gap-5">
  <ViewGate ready={settled(d)}>
    <Link to="#/prompts" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("prompts.back")}</Link>

    {#if d.data && !p}
      <div class="card"><Empty title={t("prompts.notFound")} compact /></div>
    {:else if p && d.data}
      <Card>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span>{dateTime(p.ts)}</span>
          <Link class="text-accent-ink hover:underline" to="#/sessions/{encodeURIComponent(p.session_id)}">{p.sessionTitle ?? p.session_id}</Link>
          <span class="font-mono">{p.project}</span>
          {#if p.skill}<span class="inline-flex items-center gap-1 text-accent-ink"><Sparkles size={11} />{p.skill}</span>{/if}
        </div>
        <p class="mt-3 max-h-72 overflow-auto text-sm leading-relaxed whitespace-pre-wrap text-ink">{p.text ?? t("prompts.noText")}</p>
      </Card>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("col.cost")} amount={tot?.cost} format={usd} hint={subCost > 0 ? t("prompts.subagentCost", { cost: usd(subCost) }) : tot?.messages ? t("detail.costPerCall", { cost: usd((tot.cost ?? 0) / tot.messages) }) : undefined} />
        <Kpi label={t("col.tokens")} amount={tot?.tokens} format={compact} hint={`${t("tok.output")}: ${compact(tot?.output)}`} />
        <Kpi label={t("kpi.messages")} amount={tot?.messages} format={compact} hint={`${compact(toolCalls)} ${t("col.tools")}`} />
        <Kpi label={t("kpi.cacheHit")} amount={hit} format={(v) => percent(v, 1)} hint={t("kpi.cacheHitHint", { n: compact(tot?.cacheRead) })} />
      </div>

      {#if d.data.timeline.length}<CallCharts rows={d.data.timeline} />{/if}

      <div class="grid gap-5 lg:grid-cols-3">
        <ListCard title={t("tools.topTools")} subtitle={t("detail.tools.prompt")} items={d.data.tools} empty={t("detail.noTools")} exportName="prompt-tools" />
        <ListCard title={t("tools.files")} subtitle={t("detail.files.prompt")} items={d.data.files} paths empty={t("detail.noFiles")} exportName="prompt-files" />
        <ListCard title={t("skills.agents")} subtitle={t("detail.agents")} items={d.data.agents} value="cost" exportName="prompt-agents" />
      </div>
    {:else}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {/if}
  </ViewGate>
</div>
