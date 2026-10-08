<script lang="ts">
  import { ArrowLeft, GitBranch } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Empty from "../components/Empty.svelte";
  import ListCard from "../components/ListCard.svelte";
  import Kpi from "../components/Kpi.svelte";
  import Link from "../components/Link.svelte";
  import SortTh from "../components/SortTh.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import ValueBar from "../components/ValueBar.svelte";
  import { qs, settled, useFetch, type GitCommit, type GitPr } from "../lib/api.svelte.ts";
  import { timeSeriesChart } from "../lib/charts.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, dateTime, dayWithYear, days, integer, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate, store } from "../lib/state.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";

  let { id }: { id: string } = $props();

  interface Detail {
    branch: string;
    project: string | null;
    projectLabel: string;
    longLived: boolean;
    totals: { tokens: number; cost: number; messages: number; sessions: number; prompts: number; firstTs: number | null; lastTs: number | null; commits?: number; prs?: number; costPerPr?: number | null };
    lines: { added: number; removed: number; files: number; costPer100: number | null };
    days: { buckets: string[]; cost: number[]; tokens: number[] };
    sessions: { id: string; title: string | null; provider: string; tokens: number; cost: number; messages: number; prompts: number; subagents: number; firstTs: number; lastTs: number; added: number; removed: number }[];
    models: { key: string; tokens: number; cost: number; messages: number }[];
    files: { key: string; edits: number }[];
    // Newer servers only.
    commits?: GitCommit[];
    prs?: GitPr[];
  }

  const d = useFetch<Detail>(() => `/api/branch${qs({ id })}`);
  const tot = $derived(d.data?.totals);
  const activeDays = $derived(d.data?.days.cost.filter((v) => v > 0).length ?? 0);
  const spanDays = $derived(tot?.firstTs && tot.lastTs ? Math.max(1, Math.ceil((tot.lastTs - tot.firstTs) / 86_400_000)) : 0);
  const maxSession = $derived(Math.max(1e-9, ...(d.data?.sessions ?? []).map((s) => s.cost)));
  const option = $derived.by(() => {
    void store.dark;
    const x = d.data?.days;
    if (!x?.buckets.length) return null;
    return timeSeriesChart({ buckets: x.buckets, series: [{ key: "all", name: t("metric.cost"), data: x.cost }] }, { dim: "none", metric: "cost", bucket: "day", kind: "bar" });
  });
  const commits = $derived(d.data?.commits ?? []);
  const prs = $derived(d.data?.prs ?? []);
  const commitCount = $derived(tot?.commits ?? commits.length);
  const prCount = $derived(tot?.prs ?? prs.length);
  const commitsHint = $derived(
    tot?.costPerPr != null
      ? t("branches.commitsHint", { prs: integer(prCount), perPr: t("branches.perPr", { cost: usd(tot.costPerPr) }) })
      : `${t("col.prs")}: ${integer(prCount)}`,
  );
  // Links to the outside only when they are https.
  const safeUrl = (u: string | null | undefined) => (u?.startsWith("https://") ? u : null);
  const prLabel = (p: GitPr) => (p.number == null ? (p.url ?? "") : p.repo ? `${p.repo}#${p.number}` : t("branches.prNumber", { n: p.number }));
  const sessionTitle = (sessionId: string) => {
    const s = d.data?.sessions.find((x) => x.id === sessionId);
    return s ? titleOf(s) : (sessionId.split(":").pop()?.slice(0, 13) ?? sessionId);
  };

  // The branch's sessions, latest first unless sorted otherwise.
  type SessionSort = "recent" | "cost" | "tokens" | "prompts" | "lines" | "title";
  const SESSION_SORTS = $derived<{ value: SessionSort; label: string; asc?: boolean }[]>([
    { value: "recent", label: t("sort.recent") },
    { value: "cost", label: t("col.cost") },
    { value: "tokens", label: t("col.tokens") },
    { value: "prompts", label: t("col.prompts") },
    { value: "lines", label: t("col.lines") },
    { value: "title", label: t("col.title"), asc: true },
  ]);
  let sessionSort = $state<SessionSort>("recent");
  let sessionAsc = $state(false);
  const sortedSessions = $derived.by(() => {
    const dir = sessionAsc ? 1 : -1;
    const value = (s: Detail["sessions"][number]) =>
      sessionSort === "recent" ? s.lastTs
      : sessionSort === "lines" ? s.added + s.removed
      : sessionSort === "title" ? titleOf(s)
      : s[sessionSort];
    return [...(d.data?.sessions ?? [])].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return dir * (typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number));
    });
  });
  function sortSessions(k: SessionSort) {
    if (sessionSort === k) sessionAsc = !sessionAsc;
    else {
      sessionSort = k;
      sessionAsc = k === "title";
    }
  }
  const sessionDir = (k: SessionSort) => (sessionSort === k ? (sessionAsc ? "ascending" : "descending") : undefined);

  // Commits and pull requests are listed newest first, or oldest first.
  type GitSort = "newest" | "oldest";
  const GIT_SORTS = $derived<{ value: GitSort; label: string; asc?: boolean }[]>([
    { value: "newest", label: t("sort.newest") },
    { value: "oldest", label: t("sort.oldest"), asc: true },
  ]);
  let commitSort = $state<GitSort>("newest");
  let prSort = $state<GitSort>("newest");
  const byTime = <T extends { ts: number }>(list: T[], sort: GitSort) => [...list].sort((a, b) => (sort === "oldest" ? a.ts - b.ts : b.ts - a.ts));
  const sortedCommits = $derived(byTime(commits, commitSort));
  const sortedPrs = $derived(byTime(prs, prSort));
  const timeDir = (sort: GitSort) => (sort === "oldest" ? "ascending" : "descending");
  const titleOf = (s: Detail["sessions"][number]) => s.title ?? s.id.split(":").pop()?.slice(0, 13) ?? s.id;
</script>

<div class="flex flex-col gap-5">
  <ViewGate ready={settled(d)}>
    <Link to="#/branches" class="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted hover:text-ink"><ArrowLeft size={13} />{t("branches.back")}</Link>

    {#if !d.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !d.data.totals.messages}
      <div class="card"><Empty compact title={t("branches.notFound")} /></div>
    {:else}
      <div>
        <h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <GitBranch size={18} class="shrink-0 text-muted" />
          <span class="truncate font-mono">{d.data.branch === "(none)" ? t("branches.noBranch") : d.data.branch}</span>
          {#if d.data.longLived}<span class="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-normal text-muted">{t("branches.longLived")}</span>{/if}
        </h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
          <span class="font-mono">{d.data.project ?? t("common.noProject")}</span>
          {#if tot?.firstTs && tot.lastTs}<span>{dayWithYear(tot.firstTs)} – {dayWithYear(tot.lastTs)}</span>{/if}
        </div>
      </div>

      <!-- Six tiles: two columns of three rows, then three of two, then one row. -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label={t("col.cost")} amount={tot?.cost} format={usd} hint={tot?.sessions ? t("branches.perSession", { cost: usd((tot.cost ?? 0) / tot.sessions) }) : undefined} />
        <Kpi label={t("col.tokens")} amount={tot?.tokens} format={compact} hint={t("prompts.calls", { n: compact(tot?.messages) })} />
        <Kpi label={t("col.sessions")} amount={tot?.sessions} format={compact} hint={`${compact(tot?.prompts)} ${t("col.prompts")}`} />
        <Kpi label={t("branches.days")} amount={activeDays} format={integer} hint={t("branches.over", { span: days(spanDays) })} />
        <Kpi
          label={t("lines.kpi")}
          amount={d.data.lines.added + d.data.lines.removed}
          format={compact}
          hint={d.data.lines.costPer100 != null ? t("lines.per100", { v: usd(d.data.lines.costPer100) }) : t("lines.none")}
        />
        <Kpi label={t("branches.commits")} amount={commitCount} format={integer} hint={commitsHint} />
      </div>

      <Card title={t("branches.costByDay")} subtitle={t("branches.costByDayHint")}>
        {#if option}<Chart {option} height={240} />{/if}
      </Card>

      <div class="grid gap-5 xl:grid-cols-3">
        <TableCard
          title={t("branches.sessions")}
          subtitle={t("branches.sessionsHint")}
          class="xl:col-span-2"
          rows={sortedSessions}
          searchText={titleOf}
          sorts={SESSION_SORTS}
          bind:sortKey={sessionSort}
          bind:asc={sessionAsc}
          exportName="branch-sessions"
          exportRows={(list) => list.map((s) => ({ title: titleOf(s), provider: s.provider, prompts: s.prompts, tokens: s.tokens, lines: s.added + s.removed, cost: s.cost, lastTs: s.lastTs }))}
        >
          {#snippet children(view)}
            <!-- Laid out by its content, like before: it fits the two-thirds card instead of a fixed minimum width. -->
            <table class="data" use:resizableColumns={"branch-detail-v3"}>
              <thead>
                <tr>
                  <SortTh label={t("col.title")} sort={sessionDir("title")} onclick={() => sortSessions("title")} />
                  <SortTh num label={t("col.prompts")} sort={sessionDir("prompts")} onclick={() => sortSessions("prompts")} />
                  <SortTh num label={t("col.tokens")} sort={sessionDir("tokens")} onclick={() => sortSessions("tokens")} />
                  <SortTh num label={t("col.lines")} sort={sessionDir("lines")} onclick={() => sortSessions("lines")} />
                  <SortTh num label={t("col.cost")} sort={sessionDir("cost")} onclick={() => sortSessions("cost")} />
                  <SortTh num label={t("col.lastSeen")} sort={sessionDir("recent")} onclick={() => sortSessions("recent")} />
                </tr>
              </thead>
              <tbody>
                {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as s (s.id)}
                  <tr class="cursor-pointer" onclick={() => navigate("sessions", s.id)}>
                    <td>
                      <div class="flex items-center gap-2">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", s.provider)} title={s.provider}></span>
                        <Link to="#/sessions/{encodeURIComponent(s.id)}" class="truncate">{titleOf(s)}</Link>
                        {#if s.subagents}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{t("live.subagents", { n: s.subagents })}</span>{/if}
                      </div>
                    </td>
                    <td class="num text-ink-2">{s.prompts}</td>
                    <td class="num text-ink-2">{compact(s.tokens)}</td>
                    <td class="num text-ink-2" title={t("lines.addedRemoved", { added: integer(s.added), removed: integer(s.removed) })}>{s.added + s.removed ? compact(s.added + s.removed) : "–"}</td>
                    <td class="num"><ValueBar label={usd(s.cost)} fraction={s.cost / maxSession} /></td>
                    <td class="num text-ink-2">{relative(s.lastTs)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/snippet}
        </TableCard>
        <div class="flex flex-col gap-5">
          <ListCard title={t("chart.byModel")} subtitle={t("detail.models.branch")} items={d.data.models} value="cost" exportName="branch-models" />
          <ListCard title={t("branches.files")} subtitle={t("branches.filesHint")} items={d.data.files.map((f) => ({ key: f.key, calls: f.edits }))} paths exportName="branch-files" />
        </div>
      </div>

      {#if commits.length || prs.length}
        <div class="flex flex-col gap-5">
          {#if commits.length}
            <TableCard
              title={t("branches.commitsList")}
              subtitle={t("branches.commitsListHint")}
              rows={sortedCommits}
              searchText={(c) => `${c.sha ?? ""} ${c.subject ?? ""}`}
              sorts={GIT_SORTS}
              bind:sortKey={commitSort}
              exportName="branch-commits"
            >
              {#snippet children(view)}
                <table class="data fixed-cols" use:resizableColumns={"branch-commits"}>
                  <colgroup>
                    <col />
                    <col class="w-28" />
                    <col class="w-64" />
                    <col class="w-44" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{t("col.message")}</th>
                      <th>{t("col.commit")}</th>
                      <th>{t("col.session")}</th>
                      <SortTh num label={t("col.time")} sort={timeDir(commitSort)} onclick={() => (commitSort = commitSort === "newest" ? "oldest" : "newest")} />
                    </tr>
                  </thead>
                  <tbody>
                    {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as c (c.id)}
                      {@const url = safeUrl(c.url)}
                      <tr>
                        <td class={c.subject ? "text-ink" : "text-muted"} title={c.subject ?? undefined}>{c.subject ?? t("branches.noSubject")}</td>
                        <td>
                          {#if c.sha && url}
                            <a href={url} target="_blank" rel="noreferrer noopener" class="font-mono text-xs text-accent-ink hover:underline">{c.sha.slice(0, 7)}</a>
                          {:else}
                            <span class="font-mono text-xs text-ink-2">{c.sha?.slice(0, 7) ?? "–"}</span>
                          {/if}
                        </td>
                        <td><Link to="#/sessions/{encodeURIComponent(c.sessionId)}" class="truncate text-ink-2 hover:text-ink" title={sessionTitle(c.sessionId)}>{sessionTitle(c.sessionId)}</Link></td>
                        <td class="num text-ink-2">{dateTime(c.ts)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/snippet}
            </TableCard>
          {/if}
          {#if prs.length}
            <TableCard
              title={t("branches.prsList")}
              subtitle={t("branches.prsHint")}
              rows={sortedPrs}
              searchText={(p) => `${p.repo ?? ""} ${p.number ?? ""} ${p.branch ?? ""}`}
              sorts={GIT_SORTS}
              bind:sortKey={prSort}
              exportName="branch-prs"
            >
              {#snippet children(view)}
                <table class="data fixed-cols" use:resizableColumns={"branch-prs"}>
                  <colgroup>
                    <col />
                    <col class="w-56" />
                    <col class="w-64" />
                    <col class="w-44" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{t("col.pr")}</th>
                      <th>{t("col.branch")}</th>
                      <th>{t("col.session")}</th>
                      <SortTh num label={t("col.time")} sort={timeDir(prSort)} onclick={() => (prSort = prSort === "newest" ? "oldest" : "newest")} />
                    </tr>
                  </thead>
                  <tbody>
                    {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as p (p.id)}
                      {@const url = safeUrl(p.url)}
                      <tr>
                        <td>
                          {#if url}
                            <a href={url} target="_blank" rel="noreferrer noopener" class="text-accent-ink hover:underline">{prLabel(p)}</a>
                          {:else}
                            <span class="text-ink-2">{prLabel(p)}</span>
                          {/if}
                        </td>
                        <td class="font-mono text-xs text-ink-2" title={p.branch ?? undefined}>{p.branch ?? "–"}</td>
                        <td><Link to="#/sessions/{encodeURIComponent(p.sessionId)}" class="truncate text-ink-2 hover:text-ink" title={sessionTitle(p.sessionId)}>{sessionTitle(p.sessionId)}</Link></td>
                        <td class="num text-ink-2">{dateTime(p.ts)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/snippet}
            </TableCard>
          {/if}
        </div>
      {:else}
        <Card title={t("branches.gitTitle")} subtitle={t("branches.gitHint")} divided>
          <div class="py-4"><Empty compact title={t("branches.noCommits")} /></div>
        </Card>
      {/if}
    {/if}
  </ViewGate>
</div>
