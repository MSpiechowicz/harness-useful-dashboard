<script lang="ts">
  import ViewGate from "../components/ViewGate.svelte";
  import TableCard from "../components/TableCard.svelte";
  import { GitBranch } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Link from "../components/Link.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import KindPill from "../components/KindPill.svelte";
  import TagPills from "../components/TagPills.svelte";
  import { apiUrl, getJson, settled, useFetch } from "../lib/api.svelte.ts";
  import { sessionScatter, type SessionPoint } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store, keeper } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  interface SessionRow {
    id: string;
    title: string | null;
    project: string | null;
    projectLabel: string;
    provider: string;
    gitBranch: string | null;
    sessionAgent: string | null;
    models: string | null;
    tokens: number;
    cost: number;
    messages: number;
    prompts: number;
    subagentMessages: number;
    lastTs: number;
    tags: string[];
    kind: string | null;
    /** The title shown is the AI's (session labels, Settings). */
    aiTitle: boolean;
    /** Newer servers only. */
    compactions?: number;
  }

  const keep = keeper();
  type Sort = "recent" | "cost" | "tokens" | "messages";
  let sort = $state<Sort>(keep.recall("sort", "recent"));
  const SORTS = $derived((["recent", "cost", "tokens", "messages"] as const).map((value) => ({ value: value as Sort, label: t(`sort.${value}`) })));
  let query = $state(keep.recall("query", ""));
  let debounced = $state(keep.recall("query", ""));
  // The table pages 10 rows at a time (the table card starts again on page 1 after a new search or sort).
  const PAGE = 10;
  let page = $state(keep.recall("page", 1));
  $effect(() => keep.remember({ sort, query, page }));
  $effect(() => {
    const q = query;
    // A search brought back with the view is already applied: it keeps its page.
    if (q === debounced) return;
    const h = setTimeout(() => {
      debounced = q;
      page = 1;
    }, 250);
    return () => clearTimeout(h);
  });

  const data = useFetch<{ total: number; rows: SessionRow[] }>(() => apiUrl("/api/sessions", { sort, q: debounced, limit: PAGE, offset: (page - 1) * PAGE }));
  // The map plots the heaviest sessions (the API caps a page at 200), independent of the table's sort and paging.
  const heavy = useFetch<{ total: number; rows: SessionRow[] }>(() => apiUrl("/api/sessions", { sort: store.metric, q: debounced, limit: 200 }));

  const titleOf = (r: SessionRow) => r.title ?? r.id.split(":").pop()?.slice(0, 13) ?? r.id;
  const mapOption = $derived.by(() => {
    void store.dark;
    if (!heavy.data?.rows.length) return null;
    const points: SessionPoint[] = heavy.data.rows.map((r) => ({
      id: r.id,
      title: titleOf(r),
      project: entityLabel("project", r.project, r.projectLabel),
      provider: r.provider,
      cost: r.cost,
      tokens: r.tokens,
      messages: r.messages,
      prompts: r.prompts,
    }));
    return sessionScatter(points, store.metric);
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("sessions.title")} subtitle={t("sessions.subtitle")} />
  <ViewGate ready={settled(data, heavy)}>

    {#if mapOption}
      <Card title={t("sessions.map")} subtitle={t("sessions.mapHint")}>
        <Chart
          option={mapOption}
          height={320}
          dim={heavy.loading}
          onclick={(p) => { const row = (p.data as { row?: SessionPoint } | undefined)?.row; if (row) navigate("sessions", row.id); }}
        />
      </Card>
    {/if}

    <TableCard
      title={t("sessions.tableTitle")}
      subtitle={t("sessions.tableHint")}
      rows={data.data?.rows ?? []}
      total={data.data?.total ?? 0}
      sorts={SORTS}
      bind:sortKey={sort}
      bind:query
      bind:page
      loading={data.loading}
      exportName="sessions"
      exportAll={() => getJson<{ rows: SessionRow[] }>(apiUrl("/api/sessions", { sort, q: debounced, limit: 10000, export: 1 })).then((d) => d.rows)}
    >
      {#snippet children(view)}
        <table class="data fixed-cols" use:resizableColumns={"sessions-v2"}>
          <colgroup>
            <col />
            <col class="w-44" />
            <col class="w-32" />
            <col class="w-40" />
            <col class="w-20" />
            <col class="w-[4.5rem]" />
            <col class="w-28" />
            <col class="w-24" />
            <col class="w-24" />
            <col class="w-32" />
          </colgroup>
          <thead>
            <tr>
              <th>{t("col.title")}</th>
              <th>{t("col.project")}</th>
              <th>{t("col.branch")}</th>
              <th>{t("col.models")}</th>
              <th class="num">{t("col.prompts")}</th>
              <th class="num">{t("col.messages")}</th>
              <th class="num">{t("sessions.col.compactions")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.lastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {#each view.rows as r (r.id)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", r.id)}>
                <td class="max-w-md">
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", r.provider)} title={r.provider}></span>
                    <Link to="#/sessions/{encodeURIComponent(r.id)}" class="truncate font-medium">{titleOf(r)}</Link>
                    {#if r.aiTitle}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("label.aiHint")}>{t("label.ai")}</span>{/if}
                    {#if r.sessionAgent}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{r.sessionAgent}</span>{/if}
                    {#if r.kind}<KindPill kind={r.kind} />{/if}
                    <TagPills tags={r.tags} />
                  </div>
                </td>
                <td class="max-w-48 truncate text-ink-2" title={r.project}>{entityLabel("project", r.project, r.projectLabel)}</td>
                <!-- Its own column, so every row stays one line high. -->
                <td class="max-w-36 text-xs text-ink-2" title={r.gitBranch ?? undefined}>
                  {#if r.gitBranch}<span class="flex items-center gap-1"><GitBranch size={11} class="shrink-0 text-muted" /><span class="truncate">{r.gitBranch}</span></span>{:else}<span class="text-muted">–</span>{/if}
                </td>
                <td class="max-w-40 truncate text-xs text-ink-2">{r.models?.split(",").join(", ")}</td>
                <td class="num text-ink-2">{compact(r.prompts)}</td>
                <td class="num text-ink-2">{compact(r.messages)}</td>
                <td class="num text-ink-2">{r.compactions ? compact(r.compactions) : "–"}</td>
                <td class="num text-ink-2">{compact(r.tokens)}</td>
                <td class="num font-medium">{usd(r.cost)}</td>
                <td class="num text-muted">{relative(r.lastTs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/snippet}
    </TableCard>
  </ViewGate>
</div>
