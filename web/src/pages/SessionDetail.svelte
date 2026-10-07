<script lang="ts">
  import Link from "../components/Link.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { ArrowLeft, Bot, Clock, FolderOpen, GitBranch, Hash, Sparkles, User } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import ListCard from "../components/ListCard.svelte";
  import Pager from "../components/Pager.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import Kpi from "../components/Kpi.svelte";
  import { qs, settled, useFetch, type Totals } from "../lib/api.svelte.ts";
  import type { CallRow } from "../lib/charts.ts";
  import CallCharts from "../components/CallCharts.svelte";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, count, dateTime, duration, percent, time, usd } from "../lib/format.ts";
  import { PROVIDER_NAMES } from "../lib/palette.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";

  let { id }: { id: string } = $props();

  interface Detail {
    session: { id: string; title: string | null; project: string | null; provider: string; git_branch: string | null; client: string | null; client_version: string | null; agent: string | null; parent_session_id: string | null; parent?: { id: string; title: string | null; provider: string | null; startedAt: number | null; cost: number }; brief?: string | null; started_at: number; ended_at: number; user: string; host: string } | null;
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
  const s = $derived(d.data?.session);
  // Per prompt when there are several, else per model call: one prompt's cost per prompt is just the total again.
  const costHint = $derived.by(() => {
    const cost = tot?.cost ?? 0;
    const prompts = d.data?.prompts.length ?? 0;
    if (prompts > 1) return t("detail.costPerPrompt", { cost: usd(cost / prompts) });
    return tot?.messages ? t("detail.costPerCall", { cost: usd(cost / tot.messages) }) : undefined;
  });
  let briefOpen = $state(false);
  // Each prompt's place in the session (1, 2, …): the table's "#" and the call charts' prompt marks use the same.
  // A skill column only when a prompt of the session used one.
  const hasSkills = $derived((d.data?.prompts ?? []).some((p) => p.skill));
  const promptNo = $derived(new Map((d.data?.prompts ?? []).map((p, i) => [p.id, i + 1])));
  // Prompts ten a page, like the cards beside them: a session can have dozens.
  const PAGE = 10;
  let promptPage = $state(1);
  // Another session opens in this same view (a spawned agent's link): start it on the first page.
  $effect(() => {
    void id;
    promptPage = 1;
  });
  const projectLabel = $derived(s?.project?.split(/[\\/]/).filter(Boolean).pop() ?? "");
  const tot = $derived(d.data?.totals);
  const hit = $derived(tot && tot.input + tot.cacheRead + tot.cacheWrite ? tot.cacheRead / (tot.input + tot.cacheRead + tot.cacheWrite) : 0);
  const maxPromptCost = $derived(Math.max(1e-9, ...(d.data?.prompts ?? []).map((p) => p.cost)));
</script>

<div class="flex flex-col gap-5">
  <ViewGate ready={settled(d)}>
    <Link to="#/sessions" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("sessions.back")}</Link>

    {#if d.data && !s && !d.data.timeline.length}
      <div class="card"><Empty title={t("sessions.notFound")} compact /></div>
    {:else if d.data}
      <div>
        <h1 class="text-xl font-semibold tracking-tight" class:text-ink-2={!s?.title}>{s?.title ?? t("sessions.untitled")}</h1>
        <!-- Each fact with its own icon, so the line reads as separate items rather than one run of text. Icons sit 1px up:
             centred on the box they'd be low against the letters, and one font keeps every item on the same baseline. -->
        <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-ink-2">
          {#if s?.project}
            <span class="inline-flex items-center gap-1.5" title={s.project}><FolderOpen size={13} class="-translate-y-px text-muted" />{projectLabel}</span>
          {/if}
          {#if s?.git_branch}<span class="inline-flex items-center gap-1.5"><GitBranch size={13} class="-translate-y-px text-muted" />{s.git_branch}</span>{/if}
          {#if s}
            <span class="inline-flex items-center gap-1.5">
              <span class="h-2 w-2 rounded-full" style:background={colorFor("provider", s.provider)}></span>
              {PROVIDER_NAMES[s.provider as keyof typeof PROVIDER_NAMES] ?? s.provider}{s.client_version ? ` ${s.client_version}` : ""}
              {#if s.client}<span class="text-muted">{s.client}</span>{/if}
            </span>
          {/if}
          {#if s?.agent}<span class="inline-flex items-center gap-1.5"><Bot size={13} class="-translate-y-px text-muted" />{s.agent}</span>{/if}
          {#if s?.started_at}
            <span class="inline-flex items-center gap-1.5">
              <Clock size={13} class="-translate-y-px text-muted" />{dateTime(s.started_at)}{s.ended_at ? ` – ${time(s.ended_at)}` : ""}
              {#if s.ended_at && s.ended_at > s.started_at}<span class="text-muted">· {duration(s.ended_at - s.started_at)}</span>{/if}
            </span>
          {/if}
          {#if s?.user}<span class="inline-flex items-center gap-1.5"><User size={13} class="-translate-y-px text-muted" />{s.user}<span class="text-muted">@{s.host}</span></span>{/if}
          <span class="inline-flex items-center gap-1.5 text-muted" title={id}><Hash size={13} class="-translate-y-px" />{id.split(":").pop()?.slice(0, 8)}</span>
          {#if s?.parent_session_id}<Link class="text-accent-ink hover:underline" to="#/sessions/{encodeURIComponent(s.parent_session_id)}">↖ {t("sessions.parent")}</Link>{/if}
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("col.cost")} value={usd(tot?.cost)} hint={costHint} />
        <Kpi label={t("col.tokens")} value={compact(tot?.tokens)} hint={`${t("tok.output")}: ${compact(tot?.output)}`} />
        <Kpi label={t("kpi.messages")} value={compact(tot?.messages)} hint={s?.parent ? t("detail.subagentOf", { name: s.parent.title ?? t("sessions.parent") }) : count(d.data.prompts.length, "common.prompt", "common.prompts")} />
        <Kpi label={t("kpi.cacheHit")} value={percent(hit, 1)} hint={t("kpi.cacheHitHint", { n: compact(tot?.cacheRead) })} />
      </div>

      {#if d.data.timeline.length}<CallCharts rows={d.data.timeline} prompts={d.data.prompts.length > 1 ? promptNo : undefined} />{/if}

      <div class="grid gap-5 xl:grid-cols-3">
        {#if s?.parent && !d.data.prompts.length}
          <!-- A subagent has no prompts of its own: what it was asked to do came from the session that started it. -->
          {@const parent = s.parent}
          {@const share = parent.cost ? (tot?.cost ?? 0) / parent.cost : 0}
          <Card title={t("detail.startedBy")} subtitle={t("detail.startedByHint")} class="self-start xl:col-span-2">
            <div class="flex flex-col gap-4">
              <Link to="#/sessions/{encodeURIComponent(parent.id)}" class="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 rounded-lg border border-line px-4 py-3 hover:bg-surface-2">
                <span class="flex min-w-0 items-center gap-2">
                  {#if parent.provider}<span class="h-2 w-2 shrink-0 rounded-full" style:background={colorFor("provider", parent.provider)}></span>{/if}
                  <span class="truncate text-sm font-medium text-ink group-hover:text-accent-ink">{parent.title ?? t("sessions.untitled")}</span>
                </span>
                <span class="row-span-2 flex flex-col items-end gap-1.5">
                  <span class="text-xs text-ink-2 tabular">{t("detail.share", { cost: usd(tot?.cost), total: usd(parent.cost), share: percent(share) })}</span>
                  <span class="h-1.5 w-32 overflow-hidden rounded-full bg-surface-3"><span class="block h-full rounded-full bg-data" style:width="{Math.max(2, share * 100)}%"></span></span>
                </span>
                <span class="text-xs text-muted">{t("sessions.parent")}{parent.startedAt ? ` · ${dateTime(parent.startedAt)}` : ""}</span>
              </Link>
              {#if s.brief}
                <div class="flex flex-col gap-2">
                  <div class="text-[11px] font-medium tracking-wide text-muted uppercase">{t("detail.brief")}</div>
                  <!-- The clamp sits inside the padding, so a cut line never shows half way. -->
                  <div class="rounded-lg bg-surface-2 px-4 py-3"><p class="text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2" class:line-clamp-6={!briefOpen}>{s.brief}</p></div>
                  {#if s.brief.split("\n").length > 6 || s.brief.length > 600}
                    <button type="button" class="w-fit text-xs font-medium text-accent-ink hover:underline" onclick={() => (briefOpen = !briefOpen)}>{briefOpen ? t("detail.briefLess") : t("detail.briefMore")}</button>
                  {/if}
                </div>
              {/if}
            </div>
          </Card>
        {:else}
          <Card title={t("sessions.promptsInSession")} subtitle={t("detail.prompts")} class="self-start xl:col-span-2" pad={false}>
            <div class="overflow-x-auto">
              <table class="data">
                <thead><tr><th class="w-10">#</th><th class="w-16">{t("col.time")}</th><th>{t("col.prompt")}</th>{#if hasSkills}<th>{t("col.skill")}</th>{/if}<th class="num">{t("col.messages")}</th><th class="num">{t("col.tools")}</th><th class="num">{t("col.tokens")}</th><th class="num">{t("col.cost")}</th></tr></thead>
                <tbody>
                  {#each d.data.prompts.slice((promptPage - 1) * PAGE, promptPage * PAGE) as p (p.id)}
                    <tr class="cursor-pointer" onclick={() => navigate("prompts", p.id)}>
                      <!-- The prompt's place in the session, as the call charts number it. -->
                      <td class="w-10 text-muted tabular">{promptNo.get(p.id)}</td>
                      <td class="w-16 text-ink-2 tabular">{time(p.ts)}</td>
                      <td class="max-w-md">
                        <Link to="#/prompts/{encodeURIComponent(p.id)}" class="line-clamp-2">{p.text ?? t("prompts.noText")}</Link>
                      </td>
                      {#if hasSkills}
                        <td class="text-ink-2">
                          {#if p.skill}<span class="inline-flex items-center gap-1 text-accent-ink"><Sparkles size={12} class="shrink-0" />{p.skill}</span>{:else}<span class="text-muted">–</span>{/if}
                        </td>
                      {/if}
                      <td class="num text-ink-2">{p.messages}</td>
                      <td class="num text-ink-2">{p.toolCalls}</td>
                      <td class="num text-ink-2">{compact(p.tokens)}</td>
                      <td class="num"><ValueBar label={usd(p.cost)} fraction={p.cost / maxPromptCost} /></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if d.data.prompts.length > PAGE}
              <Pager page={promptPage} total={d.data.prompts.length} size={PAGE} onpage={(p) => (promptPage = p)} />
            {/if}
          </Card>
        {/if}
        <div class="flex flex-col gap-5">
          <ListCard title={t("chart.byModel")} subtitle={t("detail.models.session")} items={d.data.models} value="cost" />
          {#if d.data.agents.length > 1}<ListCard title={t("skills.agents")} subtitle={t("detail.agents")} items={d.data.agents} value="cost" />{/if}
          {#if d.data.children.length}
            <ListCard
              title={t("sessions.children")}
              subtitle={t("detail.children", { n: d.data.children.length })}
              items={d.data.children.map((c) => ({ key: c.id, label: c.agent ?? c.title ?? c.id, cost: c.cost }))}
              value="cost"
              link={(key) => `#/sessions/${encodeURIComponent(key)}`}
            />
          {/if}
          {#if d.data.tools.length}<ListCard title={t("tools.topTools")} subtitle={t("detail.tools.session")} items={d.data.tools} />{/if}
          {#if d.data.files.length}<ListCard title={t("tools.files")} subtitle={t("detail.files.session")} items={d.data.files} paths />{/if}
        </div>
      </div>
    {:else}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {/if}
  </ViewGate>
</div>
