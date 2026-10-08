<script lang="ts">
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import TableCard from "../components/TableCard.svelte";
  import { Eye, Pencil } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import Loading from "../components/Loading.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, getJson, settled, useFetch } from "../lib/api.svelte.ts";
  import { compact, entityLabel, percent, relative } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, keeper } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  interface FileRow {
    key: string;
    project: string | null;
    projectLabel: string;
    /** Path relative to the project root when the file lies inside it. */
    path: string;
    calls: number;
    reads: number;
    edits: number;
  }
  interface Overview {
    totals: { files: number; calls: number; reads: number; edits: number };
    projects: { key: string; label: string; files: number; calls: number }[];
  }
  interface Hotspots {
    folders: { path: string; files: number; calls: number; reads: number; edits: number }[];
    files: FileRow[];
  }

  const overview = useFetch<Overview>(() => apiUrl("/api/files"));

  // The hotspot card looks at one project at a time: the globally filtered one, else the busiest.
  let picked = $state<string | null>(null);
  const project = $derived(store.project || (picked ?? overview.data?.projects[0]?.key ?? null));
  const hot = useFetch<Hotspots>(() => (project ? apiUrl("/api/files/hotspots", { project }) : null));

  const keep = keeper();
  let query = $state(keep.recall("query", ""));
  let debounced = $state(keep.recall("query", ""));
  type Sort = "calls" | "edits" | "reads" | "recent";
  let sort = $state<Sort>(keep.recall("sort", "calls"));
  const SORTS = $derived((["calls", "edits", "reads", "recent"] as const).map((value) => ({ value: value as Sort, label: t(`files.sort.${value}`) })));
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
  const list = useFetch<{ total: number; rows: (FileRow & { sessions: number; lastTs: number })[] }>(() =>
    apiUrl("/api/files/list", { q: debounced, sort, limit: PAGE, offset: (page - 1) * PAGE }),
  );

  const name = (p: string) => p.split(/[\\/]/).pop() ?? p;
  const dir = (p: string) => p.split(/[\\/]/).slice(0, -1).join("/");
  const maxListCalls = $derived(Math.max(1, ...(list.data?.rows.map((f) => f.calls) ?? [])));
  const maxFolder = $derived(Math.max(1, ...(hot.data?.folders.filter((f) => f.path !== "__outside__").map((f) => f.calls) ?? [])));
  const maxFile = $derived(Math.max(1, ...(hot.data?.files.map((f) => f.calls) ?? [])));
</script>

<!-- Edit and read counts as icons: action types carry no color, since color means identity elsewhere. -->
{#snippet counts(f: { edits: number; reads: number })}
  <span class="flex shrink-0 items-center gap-2.5 text-xs text-muted">
    <span class="inline-flex items-center gap-1" title={t("col.edits")}><Pencil size={11} />{compact(f.edits)}</span>
    <span class="inline-flex items-center gap-1" title={t("col.reads")}><Eye size={11} />{compact(f.reads)}</span>
  </span>
{/snippet}

{#snippet bar(value: number, max: number)}
  <span class="block h-1 overflow-hidden rounded-full bg-surface-3">
    <span class="block h-full rounded-full bg-data" style:width="{Math.max(1, (value / max) * 100)}%"></span>
  </span>
{/snippet}

<div class="flex flex-col gap-5">
  <PageHeader title={t("files.title")} subtitle={t("files.subtitle")} />
  <ViewGate ready={settled(overview, list, ...(project ? [hot] : []))}>

    {#if !overview.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if overview.data.totals.files === 0}
      <div class="card"><Empty /></div>
    {:else}
      {@const tot = overview.data.totals}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label={t("files.touched")} amount={tot.files} format={compact} hint={t("files.touchesN", { n: compact(tot.calls) })} />
        <Kpi label={t("files.edits")} amount={tot.edits} format={compact} hint={t("files.shareOfTouches", { share: percent(tot.edits / Math.max(1, tot.calls)) })} />
        <Kpi label={t("files.projects")} amount={overview.data.projects.length} format={compact} hint={overview.data.projects[0] ? t("files.busiest", { project: entityLabel("project", overview.data.projects[0].key, overview.data.projects[0].label) }) : undefined} />
      </div>

      <Card title={t("files.hotspots")} subtitle={t("files.hotspotsHint")}>
        {#snippet actions()}
          {#if !store.project && project}
            <Dropdown
              prefix
              label={t("filter.project")}
              value={project}
              class="max-w-64"
              options={overview.data!.projects.map((p) => ({ value: p.key, label: entityLabel("project", p.key, p.label) }))}
              onchange={(v) => (picked = v)}
            />
          {/if}
        {/snippet}
        {#if !hot.data}
          <Loading compact />
        {:else}
          <div class="grid gap-x-10 gap-y-6 md:grid-cols-2" class:loading-dim={hot.loading}>
            <section class="min-w-0">
              <h3 class="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">{t("files.folders")}</h3>
              <ul class="flex flex-col gap-3">
                {#each hot.data.folders as g (g.path)}
                  <li class="flex flex-col gap-1.5">
                    <span class="flex items-baseline justify-between gap-3 text-[13px]">
                      <span class="min-w-0 truncate" title={g.path}>
                        <span class={g.path === "__outside__" ? "text-muted italic" : "text-ink"}>{g.path === "." ? t("files.root") : g.path === "__outside__" ? t("files.outside") : g.path}</span>
                        <span class="ml-1.5 text-xs text-muted">{t("files.filesN", { n: compact(g.files) })}</span>
                      </span>
                      <span class="tabular shrink-0 font-medium text-ink">{compact(g.calls)}</span>
                    </span>
                    {#if g.path !== "__outside__"}{@render bar(g.calls, maxFolder)}{/if}
                  </li>
                {/each}
              </ul>
            </section>
            <section class="min-w-0">
              <h3 class="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">{t("files.files")}</h3>
              <ul class="flex flex-col gap-3">
                {#each hot.data.files as f (f.key)}
                  <li class="flex flex-col gap-1.5">
                    <span class="flex items-baseline justify-between gap-3 text-[13px]">
                      <span class="min-w-0 truncate" title={f.key}>
                        <span class="text-ink">{name(f.path)}</span>
                        {#if dir(f.path)}<span class="ml-1.5 text-xs text-muted">{dir(f.path)}</span>{/if}
                      </span>
                      <span class="flex shrink-0 items-baseline gap-3">
                        {@render counts(f)}
                        <span class="tabular w-8 text-right font-medium text-ink">{compact(f.calls)}</span>
                      </span>
                    </span>
                    {@render bar(f.calls, maxFile)}
                  </li>
                {/each}
              </ul>
            </section>
          </div>
        {/if}
      </Card>

      <TableCard
        title={t("tools.files")}
        subtitle={t("files.allFiles")}
        rows={list.data?.rows ?? []}
        total={list.data?.total ?? 0}
        sorts={SORTS}
        bind:sortKey={sort}
        bind:query
        bind:page
        loading={list.loading}
        exportName="files"
        exportAll={() => getJson<{ rows: (FileRow & { sessions: number; lastTs: number })[] }>(apiUrl("/api/files/list", { q: debounced, sort, limit: 10000, export: 1 })).then((d) => d.rows)}
      >
        {#snippet children(view)}
          <table class="data fixed-cols" use:resizableColumns={"files"}>
            <colgroup>
              <col />
              <col class="w-44" />
              <col class="w-48" />
              <col class="w-20" />
              <col class="w-20" />
              <col class="w-24" />
              <col class="w-32" />
            </colgroup>
            <thead>
              <tr>
                <th>{t("col.file")}</th>
                <th>{t("col.project")}</th>
                <th class="num w-48">{t("files.touches")}</th>
                <th class="num">{t("col.edits")}</th>
                <th class="num">{t("col.reads")}</th>
                <th class="num">{t("col.sessions")}</th>
                <th class="num">{t("col.lastTouched")}</th>
              </tr>
            </thead>
            <tbody>
              {#each view.rows as f (f.key)}
                <tr>
                  <td class="max-w-md">
                    <span class="block truncate text-[13px]" title={f.key}>
                      <span class="text-ink">{name(f.path)}</span>
                      {#if dir(f.path)}<span class="ml-1.5 text-xs text-muted">{dir(f.path)}</span>{/if}
                    </span>
                  </td>
                  <td class="max-w-40 truncate text-ink-2" title={f.project}>{entityLabel("project", f.project, f.projectLabel)}</td>
                  <td class="num font-medium"><ValueBar label={compact(f.calls)} fraction={f.calls / maxListCalls} /></td>
                  <td class="num text-ink-2">{compact(f.edits)}</td>
                  <td class="num text-ink-2">{compact(f.reads)}</td>
                  <td class="num text-ink-2">{compact(f.sessions)}</td>
                  <td class="num text-muted">{relative(f.lastTs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
