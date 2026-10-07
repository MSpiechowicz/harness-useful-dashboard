<script lang="ts">
  import Card from "../components/Card.svelte";
  import DonutList from "../components/DonutList.svelte";
  import Empty from "../components/Empty.svelte";
  import Link from "../components/Link.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import SortTh from "../components/SortTh.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, entityLabel, percent, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate } from "../lib/state.svelte.ts";

  interface BranchRow {
    id: string;
    branch: string;
    project: string | null;
    projectLabel: string;
    longLived: boolean;
    tokens: number;
    cost: number;
    messages: number;
    sessions: number;
    prompts: number;
    firstTs: number;
    lastTs: number;
    days: number;
  }
  interface BranchesData {
    total: { cost: number; tokens: number };
    rows: BranchRow[];
  }

  const d = useFetch<BranchesData>(() => apiUrl("/api/branches"));

  // Work branches by default: main and the like hold everything that wasn't done on a branch of its own.
  type Scope = "work" | "all";
  let scope = $state<Scope>("work");
  try {
    if (localStorage.getItem("hd.branchScope") === "all") scope = "all";
  } catch {
    /* no storage: the default */
  }
  function pickScope(s: Scope) {
    scope = s;
    try {
      localStorage.setItem("hd.branchScope", s);
    } catch {
      /* not kept */
    }
  }

  const NONE = "(none)";
  const isWork = (r: BranchRow) => !r.longLived && r.branch !== NONE;
  const rows = $derived((d.data?.rows ?? []).filter((r) => scope === "all" || isWork(r)));
  const shownCost = $derived(rows.reduce((a, r) => a + r.cost, 0));
  const median = $derived.by(() => {
    const costs = rows.map((r) => r.cost).sort((a, b) => a - b);
    if (!costs.length) return null;
    const mid = costs.length >> 1;
    return costs.length % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2;
  });
  const top = $derived(rows.slice(0, 10));
  const maxTop = $derived(Math.max(1e-9, ...top.map((r) => r.cost)));
  const projects = $derived.by(() => {
    const m = new Map<string, { key: string; label: string; value: number }>();
    for (const r of rows) {
      const key = r.project ?? NONE;
      const p = m.get(key) ?? { key, label: entityLabel("project", key, r.projectLabel), value: 0 };
      p.value += r.cost;
      m.set(key, p);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  });
  // How big the pieces of work are: branches counted by cost band.
  const BANDS = [1, 5, 20];
  const sizes = $derived.by(() => {
    const counts = new Array<number>(BANDS.length + 1).fill(0);
    for (const r of rows) {
      const i = BANDS.findIndex((b) => r.cost < b);
      counts[i < 0 ? BANDS.length : i]!++;
    }
    return counts.map((n, i) => ({
      key: String(i),
      label:
        i === 0 ? t("branches.size.under", { v: usd(BANDS[0], { whole: true }) })
        : i === BANDS.length ? t("branches.size.above", { v: usd(BANDS[i - 1], { whole: true }) })
        : t("branches.size.range", { from: usd(BANDS[i - 1], { whole: true }), to: usd(BANDS[i], { whole: true }) }),
      n,
    }));
  });
  const maxSize = $derived(Math.max(1, ...sizes.map((x) => x.n)));
  const branchName = (r: { branch: string }) => (r.branch === NONE ? t("branches.noBranch") : r.branch);

  type Sort = "cost" | "tokens" | "sessions" | "days" | "recent" | "branch";
  let sort = $state<Sort>("cost");
  let asc = $state(false);
  const SORTS = $derived<{ value: Sort; label: string; asc?: boolean }[]>([
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "sessions", label: t("col.sessions") },
    { value: "days", label: t("branches.days") },
    { value: "recent", label: t("sort.recent") },
    { value: "branch", label: t("col.branch"), asc: true },
  ]);
  const sorted = $derived.by(() => {
    const dir = asc ? 1 : -1;
    const value = (r: BranchRow) => (sort === "recent" ? r.lastTs : sort === "branch" ? r.branch : r[sort]);
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  function sortBy(k: Sort) {
    if (sort === k) asc = !asc;
    else {
      sort = k;
      asc = k === "branch";
    }
  }
  const dir = (k: Sort) => (sort === k ? (asc ? "ascending" : "descending") : undefined);
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("branches.title")} subtitle={t("branches.subtitle")}>
    <div class="seg" role="radiogroup" aria-label={t("branches.scope")}>
      <button role="radio" aria-checked={scope === "work"} onclick={() => pickScope("work")}>{t("branches.scope.work")}</button>
      <button role="radio" aria-checked={scope === "all"} onclick={() => pickScope("all")}>{t("branches.scope.all")}</button>
    </div>
  </PageHeader>
  <ViewGate ready={settled(d)}>
    {#if !d.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !rows.length}
      <div class="card"><Empty title={t("branches.empty")} body={scope === "work" ? t("branches.emptyWork") : undefined} /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("branches.count")} value={compact(rows.length)} hint={t("branches.inProjects", { n: projects.length })} />
        <Kpi label={t("branches.cost")} value={usd(shownCost)} hint={t("branches.ofTotal", { share: percent(d.data.total.cost ? shownCost / d.data.total.cost : 0) })} />
        <Kpi label={t("branches.median")} value={usd(median)} hint={t("branches.medianHint")} />
        <Kpi label={t("branches.costliest")} value={usd(top[0]?.cost)} hint={top[0] ? branchName(top[0]) : undefined} />
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <Card title={t("branches.top")} subtitle={t("branches.topHint")} class="xl:col-span-2">
          <ul class="-mx-2 flex flex-col" class:loading-dim={d.loading}>
            {#each top as r (r.id)}
              <li>
                <button
                  type="button"
                  class="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5 rounded-lg px-2 py-2 text-left hover:bg-surface-2"
                  title="{branchName(r)} · {r.projectLabel}"
                  onclick={() => navigate("branches", r.id)}
                >
                  <span class="flex min-w-0 items-baseline gap-2">
                    <span class="truncate font-mono text-[12.5px] text-ink-2 group-hover:text-ink" class:italic={r.branch === NONE}>{branchName(r)}</span>
                    <span class="shrink-0 truncate text-[11px] text-muted">{entityLabel("project", r.project, r.projectLabel)}</span>
                  </span>
                  <span class="tabular text-right text-[13px] font-medium text-ink">{usd(r.cost)}</span>
                  <span class="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <span class="block h-full rounded-full" style:width="{Math.max(0.5, (r.cost / maxTop) * 100)}%" style:background={colorFor("project", r.project ?? NONE)}></span>
                  </span>
                </button>
              </li>
            {/each}
          </ul>
        </Card>
        <Card title={t("branches.byProject")} subtitle={t("metric.cost")}>
          <div class="flex flex-col gap-6">
            <DonutList items={projects} dim="project" format={(v) => usd(v)} loading={d.loading} />
            <!-- Bands aren't entities, so their bars wear the neutral data ink, as the kinds of work on Tools do. -->
            <div class="flex flex-col gap-2.5" class:loading-dim={d.loading}>
              <div class="border-t border-line pt-4 text-[11px] font-medium tracking-wide text-muted uppercase">{t("branches.size")}</div>
              {#each sizes as b (b.key)}
                <div class="grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem_2.75rem] items-center gap-3 text-xs">
                  <span class="truncate text-ink-2">{b.label}</span>
                  <span class="h-1.5 overflow-hidden rounded-full bg-surface-3"><span class="block h-full rounded-full bg-data" style:width="{b.n ? Math.max(0.5, (b.n / maxSize) * 100) : 0}%"></span></span>
                  <span class="text-right font-medium text-ink tabular">{b.n}</span>
                  <span class="text-right text-muted tabular">{percent(rows.length ? b.n / rows.length : 0)}</span>
                </div>
              {/each}
            </div>
          </div>
        </Card>
      </div>

      <TableCard title={t("branches.all")} subtitle={t("branches.allHint")} rows={sorted} searchText={(r) => `${r.branch} ${r.projectLabel}`} sorts={SORTS} bind:sortKey={sort} bind:asc>
        {#snippet children(view)}
          <table class="data fixed-cols">
            <colgroup>
              <col />
              <col class="w-44" />
              <col class="w-24" />
              <col class="w-24" />
              <col class="w-24" />
              <col class="w-44" />
              <col class="w-28" />
            </colgroup>
            <thead>
              <tr>
                <SortTh label={t("col.branch")} sort={dir("branch")} onclick={() => sortBy("branch")} />
                <th>{t("col.project")}</th>
                <SortTh num label={t("col.sessions")} sort={dir("sessions")} onclick={() => sortBy("sessions")} />
                <SortTh num label={t("branches.days")} sort={dir("days")} onclick={() => sortBy("days")} />
                <SortTh num label={t("col.tokens")} sort={dir("tokens")} onclick={() => sortBy("tokens")} />
                <SortTh num label={t("col.cost")} sort={dir("cost")} onclick={() => sortBy("cost")} />
                <SortTh num label={t("col.lastSeen")} sort={dir("recent")} onclick={() => sortBy("recent")} />
              </tr>
            </thead>
            <tbody>
              {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as r (r.id)}
                <tr class="cursor-pointer" onclick={() => navigate("branches", r.id)}>
                  <td>
                    <div class="flex items-center gap-2">
                      <Link to="#/branches/{encodeURIComponent(r.id)}" class="truncate font-mono text-xs text-ink {r.branch === NONE ? 'italic' : ''}" title={r.branch}>{branchName(r)}</Link>
                      {#if r.longLived}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{t("branches.longLived")}</span>{/if}
                    </div>
                  </td>
                  <td class="truncate text-ink-2" title={r.project ?? ""}>{entityLabel("project", r.project, r.projectLabel)}</td>
                  <td class="num text-ink-2">{compact(r.sessions)}</td>
                  <td class="num text-ink-2">{r.days}</td>
                  <td class="num text-ink-2">{compact(r.tokens)}</td>
                  <td class="num"><ValueBar label={usd(r.cost)} fraction={r.cost / maxTop} /></td>
                  <td class="num text-ink-2">{relative(r.lastTs)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
