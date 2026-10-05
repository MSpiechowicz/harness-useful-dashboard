<script lang="ts">
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import Card from "../components/Card.svelte";
  import DonutList from "../components/DonutList.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import TableCard from "../components/TableCard.svelte";
  import { apiUrl, settled, useFetch } from "../lib/api.svelte.ts";
  import { colorFor, isColored, rankKeys } from "../lib/colors.svelte.ts";
  import { compact, decimal, entityLabel, percent } from "../lib/format.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  interface ToolsData {
    totals: { calls: number; tools: number; mcpTools: number; mcpCalls: number; prompts: number };
    tools: { key: string; calls: number; sessions: number; byProject: Record<string, number> }[];
    projects: { key: string; label: string }[];
    sources: { key: string; calls: number }[];
    counts: { key: string; calls: number; sessions: number }[];
  }

  const d = useFetch<ToolsData>(() => apiUrl("/api/tools"));

  /** MCP tools are mcp__<server>__<tool>: show the tool name and keep the server as a tag. */
  function toolName(key: string): { name: string; server: string | null } {
    const m = /^mcp__(.+?)__(.+)$/.exec(key);
    return m ? { name: m[2]!.replaceAll("__", ":"), server: m[1]! } : { name: key.replaceAll("__", ":"), server: null };
  }

  const total = $derived(d.data?.totals.calls ?? 0);
  // The busiest tools; the rest still count in the kinds of work.
  // As many of the busiest tools as fit beside the sources card (the API sends the top 20); the rest are in the table.
  const GAP = 12;
  let listHeight = $state(0);
  let listEl = $state<HTMLUListElement>();
  let rowHeight = $state(32);
  $effect(() => {
    void d.data;
    const first = listEl?.firstElementChild;
    if (first) rowHeight = first.getBoundingClientRect().height;
  });
  const fit = $derived(Math.max(5, Math.floor((listHeight + GAP) / (rowHeight + GAP))));
  const topTools = $derived((d.data?.tools ?? []).slice(0, fit));

  /** What a tool is for, across harnesses (Claude's Read and omp's read are the same kind of work). */
  const KINDS: [string, RegExp][] = [
    ["mcp", /^mcp__/],
    ["explore", /^(read|notebookread|glob|grep|ls|find|search|list_?dir|view|lsp)$/i],
    ["edit", /^(edit|multiedit|write|apply_patch|notebookedit|ast_edit|str_replace\w*)$/i],
    ["run", /^(bash|exec_command|write_stdin|shell|local_shell_call|eval|run\w*)$/i],
    ["agents", /^(task|agent|hub|wait|yield|spawn\w*|send_message)$/i],
    ["plan", /^(todo|todowrite|todoread|update_plan|exitplanmode|enterplanmode)$/i],
    ["web", /^(web_?search|web_?fetch|fetch|browse\w*)$/i],
  ];
  const kinds = $derived.by(() => {
    const sums = new Map<string, number>();
    for (const c of d.data?.counts ?? []) {
      const kind = KINDS.find(([, re]) => re.test(c.key))?.[0] ?? "other";
      sums.set(kind, (sums.get(kind) ?? 0) + c.calls);
    }
    // Busiest first; "other" always last.
    return [...sums].map(([key, calls]) => ({ key, calls })).sort((a, b) => Number(a.key === "other") - Number(b.key === "other") || b.calls - a.calls);
  });
  const maxKind = $derived(Math.max(1, ...kinds.map((k) => k.calls)));
  const kindOf = (key: string) => KINDS.find(([, re]) => re.test(key))?.[0] ?? "other";

  // Every tool, for the table below the charts (the list above shows only the busiest).
  type ToolSort = "calls" | "sessions" | "name" | "kind";
  let toolSort = $state<ToolSort>("calls");
  let toolAsc = $state(false);
  const TOOL_SORTS = $derived<{ value: ToolSort; label: string; asc?: boolean }[]>([
    { value: "calls", label: t("col.calls") },
    { value: "sessions", label: t("col.sessions") },
    { value: "name", label: t("col.name"), asc: true },
    { value: "kind", label: t("tools.kind"), asc: true },
  ]);
  const allTools = $derived.by(() => {
    const rows = (d.data?.counts ?? []).map((c) => {
      const n = toolName(c.key);
      return { ...c, name: n.name, server: n.server, kind: t(`tools.kind.${kindOf(c.key)}` as MessageKey) };
    });
    const dir = toolAsc ? 1 : -1;
    return rows.sort((a, b) => {
      const x = a[toolSort];
      const y = b[toolSort];
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  const maxToolCalls = $derived(Math.max(1, ...allTools.map((r) => r.calls)));
  function sortTools(k: ToolSort) {
    if (toolSort === k) toolAsc = !toolAsc;
    else {
      toolSort = k;
      toolAsc = k === "name" || k === "kind";
    }
  }
  const arrow = (k: ToolSort) => (toolSort === k ? (toolAsc ? " ↑" : " ↓") : "");
  const max = $derived(Math.max(1, ...topTools.map((x) => x.calls)));
  // Bar segments, in a fixed order so each project keeps its place (and color) on every bar. Projects
  // without a hue of their own join "Other" rather than showing up as a second, identical gray.
  const segments = $derived([
    ...(d.data?.projects ?? []).filter((p) => isColored("project", p.key)).map((p) => ({ key: p.key, label: entityLabel("project", p.key, p.label) })),
    { key: "__other__", label: t("chart.other") },
  ]);
  const part = (tool: ToolsData["tools"][number], key: string) =>
    key === "__other__"
      ? Object.entries(tool.byProject).reduce((a, [k, v]) => (segments.some((s) => s.key === k && k !== "__other__") ? a : a + v), 0)
      : (tool.byProject[key] ?? 0);
  const legend = $derived(segments.filter((s) => topTools.some((x) => part(x, s.key))));
  // Busiest MCP server first gets the first free palette slot, so servers never share a color.
  $effect(() => {
    if (d.data) rankKeys("source", d.data.sources.map((s) => s.key));
  });
  const sources = $derived(
    (d.data?.sources ?? []).map((s) =>
      s.key === "builtin" ? { key: s.key, label: t("tools.builtin"), value: s.calls } : { key: s.key, label: s.key, value: s.calls, detail: t("tools.mcpServer") },
    ),
  );
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("tools.title")} subtitle={t("tools.subtitle")} />
  <ViewGate ready={settled(d)}>

    {#if !d.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if d.data.totals.calls === 0}
      <div class="card"><Empty /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi
          label={t("tools.calls")}
          value={compact(total)}
          hint={d.data.totals.prompts ? t("tools.perPrompt", { n: decimal(total / d.data.totals.prompts) }) : undefined}
        />
        <Kpi
          label={t("tools.distinct")}
          value={compact(d.data.totals.tools)}
          hint={t("tools.bySource", { builtin: compact(d.data.totals.tools - d.data.totals.mcpTools), mcp: compact(d.data.totals.mcpTools) })}
        />
        <Kpi label={t("tools.viaMcp")} value={percent(d.data.totals.mcpCalls / total, 1)} hint={t("common.callsN", { n: compact(d.data.totals.mcpCalls) })} />
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card title={t("tools.topTools")} subtitle={t("tools.topShown", { n: topTools.length, total: d.data.totals.tools })} class="xl:col-span-2">
          <!-- The list takes the room the card beside it leaves and shows as many whole rows as fit there. -->
          <div class="flex h-full flex-col">
            <ul class="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
              {#each legend as s (s.key)}
                <li>
                  <button
                    type="button"
                    class="flex max-w-56 items-center gap-1.5 text-ink-2 hover:text-ink disabled:cursor-default disabled:hover:text-ink-2"
                    disabled={s.key === "__other__"}
                    onclick={() => store.setFilter("project", s.key)}
                  >
                    <span class="h-2 w-2 shrink-0 rounded-full" style:background={colorFor("project", s.key)}></span>
                    <span class="truncate">{s.label}</span>
                  </button>
                </li>
              {/each}
            </ul>
            <div class="relative min-h-[22rem] flex-1" bind:clientHeight={listHeight}>
              <div class="absolute inset-0">
              <ul class="flex flex-col gap-3" class:loading-dim={d.loading} bind:this={listEl}>
                {#each topTools as tool (tool.key)}
                  {@const n = toolName(tool.key)}
                  <li class="grid grid-cols-[minmax(0,1fr)_auto_2.75rem] items-baseline gap-x-3 gap-y-1.5" title={tool.key}>
                    <span class="flex min-w-0 items-baseline gap-2">
                      <span class="truncate text-[13px] text-ink">{n.name}</span>
                      {#if n.server}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{n.server}</span>{/if}
                    </span>
                    <span class="tabular text-right text-[13px] font-medium text-ink">{compact(tool.calls)}</span>
                    <span class="tabular text-right text-xs text-muted">{percent(tool.calls / total, tool.calls / total < 0.1 ? 1 : 0)}</span>
                    <span class="col-span-3 h-1.5 overflow-hidden rounded-full bg-surface-3">
                      <span class="flex h-full gap-px" style:width="{Math.max(0.5, (tool.calls / max) * 100)}%">
                        {#each segments as s (s.key)}
                          {@const v = part(tool, s.key)}
                          {#if v}
                            <span
                              class="h-full first:rounded-l-full last:rounded-r-full"
                              style:width="{(v / tool.calls) * 100}%"
                              style:background={colorFor("project", s.key)}
                              title="{s.label} · {compact(v)}"
                            ></span>
                          {/if}
                        {/each}
                      </span>
                    </span>
                  </li>
                {/each}
              </ul>
              </div>
            </div>
          </div>
        </Card>

        <Card title={t("tools.sources")} subtitle={t("col.calls")}>
          <div class="flex flex-col gap-6">
            <DonutList items={sources} dim="source" format={compact} loading={d.loading} />
            <!-- Every call grouped by what it does. Kinds aren't entities, so their bars wear the neutral data ink. -->
            <div class="flex flex-col gap-2.5" class:loading-dim={d.loading}>
              <!-- A section heading, as in the Files hotspots: set apart from the rows it heads. -->
              <div class="border-t border-line pt-4 text-[11px] font-medium tracking-wide text-muted uppercase">{t("tools.kinds")}</div>
              {#each kinds as k (k.key)}
                <div class="grid grid-cols-[9.5rem_minmax(0,1fr)_3.5rem_2.75rem] items-center gap-3 text-xs">
                  <span class="truncate text-ink-2">{t(`tools.kind.${k.key}` as MessageKey)}</span>
                  <span class="h-1.5 overflow-hidden rounded-full bg-surface-3"><span class="block h-full rounded-full bg-data" style:width="{Math.max(0.5, (k.calls / maxKind) * 100)}%"></span></span>
                  <span class="text-right font-medium text-ink tabular">{compact(k.calls)}</span>
                  <span class="text-right text-muted tabular">{percent(k.calls / total, k.calls / total < 0.1 ? 1 : 0)}</span>
                </div>
              {/each}
            </div>
          </div>
        </Card>
      </div>

      <TableCard
        title={t("tools.allTools")}
        subtitle={t("tools.allToolsHint")}
        rows={allTools}
        searchText={(r) => `${r.name} ${r.server ?? ""}`}
        sorts={TOOL_SORTS}
        bind:sortKey={toolSort}
        bind:asc={toolAsc}
      >
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-40" />
              <col class="w-36" />
              <col class="w-24" />
              <col class="w-44" />
              <col class="w-24" />
            </colgroup>
            <thead>
              <tr>
                <th><button onclick={() => sortTools("name")}>{t("col.tool")}{arrow("name")}</button></th>
                <th><button onclick={() => sortTools("kind")}>{t("tools.kind")}{arrow("kind")}</button></th>
                <th>{t("tools.source")}</th>
                <th class="num"><button onclick={() => sortTools("calls")}>{t("col.calls")}{arrow("calls")}</button></th>
                <th class="num">{t("col.share")}</th>
                <th class="num"><button onclick={() => sortTools("sessions")}>{t("col.sessions")}{arrow("sessions")}</button></th>
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as r (r.key)}
                <tr title={r.key}>
                  <td class="text-ink">{r.name}</td>
                  <td class="text-ink-2">{r.kind}</td>
                  <td class="text-ink-2">{#if r.server}<span class="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{r.server}</span>{:else}{t("tools.builtin")}{/if}</td>
                  <td class="num font-medium">{compact(r.calls)}</td>
                  <td class="num text-ink-2"><ValueBar label={percent(r.calls / total, r.calls / total < 0.1 ? 1 : 0)} fraction={r.calls / maxToolCalls} /></td>
                  <td class="num text-ink-2">{compact(r.sessions)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
