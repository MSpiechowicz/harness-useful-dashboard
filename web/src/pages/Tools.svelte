<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import KeyCountList from "../components/KeyCountList.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch } from "../lib/api.svelte.ts";
  import { matrixHeatmap } from "../lib/charts.ts";
  import { compact, shortPath } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  interface ToolsData {
    tools: { key: string; calls: number; sessions: number }[];
    files: { key: string; calls: number; reads: number; edits: number; sessions: number; projectLabel: string }[];
    matrix: { tools: string[]; projects: { key: string; label: string }[]; cells: [number, number, number][] };
    byHour: { tools: string[]; cells: [number, number, number][] };
  }

  const d = useFetch<ToolsData>(() => apiUrl("/api/tools"));
  const short = (name: string) => name.replace(/^mcp__/, "mcp:").replace(/__/g, ":");
  const matrixOption = $derived.by(() => {
    void store.dark;
    const m = d.data?.matrix;
    if (!m || !m.tools.length || !m.projects.length) return null;
    // tools on the y axis, projects on the x axis
    return matrixHeatmap(m.projects.map((p) => p.label), m.tools.map(short), m.cells.map(([ti, pi, v]) => [pi, ti, v] as const), t("col.calls"));
  });
  const hourOption = $derived.by(() => {
    void store.dark;
    const h = d.data?.byHour;
    if (!h || !h.tools.length) return null;
    return matrixHeatmap(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")), h.tools.map(short), h.cells, t("col.calls"));
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("tools.title")} subtitle={t("tools.subtitle")} />

  {#if d.data && d.data.tools.length === 0}
    <div class="card"><Empty /></div>
  {:else if d.data}
    <div class="grid gap-5 xl:grid-cols-3">
      <Card title={t("tools.topTools")}>
        <KeyCountList items={d.data.tools.slice(0, 20).map((x) => ({ ...x, key: short(x.key) }))} />
      </Card>
      <Card title={t("tools.byProject")} class="xl:col-span-2">
        {#if matrixOption}<Chart option={matrixOption} height={Math.max(260, d.data.matrix.tools.length * 30 + 80)} dim={d.loading} />{/if}
      </Card>
    </div>

    <Card title={t("tools.byHour")}>
      {#if hourOption}<Chart option={hourOption} height={Math.max(240, d.data.byHour.tools.length * 26 + 70)} dim={d.loading} />{/if}
    </Card>

    <Card title={t("tools.files")} pad={false}>
      <div class="mt-2 max-h-[560px] overflow-auto">
        <table class="data">
          <thead><tr><th>{t("col.file")}</th><th>{t("col.project")}</th><th class="num">{t("col.calls")}</th><th class="num">{t("col.reads")}</th><th class="num">{t("col.edits")}</th><th class="num">{t("col.sessions")}</th></tr></thead>
          <tbody>
            {#each d.data.files as f (f.key)}
              <tr>
                <td class="max-w-lg truncate font-mono text-xs" title={f.key}>{shortPath(f.key, 3)}</td>
                <td class="text-ink-2">{f.projectLabel}</td>
                <td class="num">{compact(f.calls)}</td>
                <td class="num text-ink-2">{compact(f.reads)}</td>
                <td class="num text-ink-2">{compact(f.edits)}</td>
                <td class="num text-ink-2">{compact(f.sessions)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}
</div>
