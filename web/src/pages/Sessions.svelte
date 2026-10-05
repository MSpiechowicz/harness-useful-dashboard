<script lang="ts">
  import { GitBranch, Search } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, relative, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate } from "../lib/state.svelte.ts";

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
  }

  let sort = $state<"recent" | "cost" | "tokens" | "messages">("recent");
  let query = $state("");
  let debounced = $state("");
  let limit = $state(50);
  $effect(() => {
    const q = query;
    const h = setTimeout(() => {
      debounced = q;
      limit = 50;
    }, 250);
    return () => clearTimeout(h);
  });

  const data = useFetch<{ total: number; rows: SessionRow[] }>(() => apiUrl("/api/sessions", { sort, q: debounced, limit }));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("sessions.title")} subtitle={t("sessions.subtitle")}>
    <label class="relative">
      <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
      <input class="input w-56 pl-8" placeholder={t("filter.search")} bind:value={query} />
    </label>
    <select class="input" bind:value={sort}>
      {#each ["recent", "cost", "tokens", "messages"] as s (s)}<option value={s}>{t(`sort.${s}` as "sort.cost")}</option>{/each}
    </select>
  </PageHeader>

  <Card pad={false}>
    {#if data.data && data.data.rows.length === 0}
      <Empty compact />
    {:else}
      <div class="overflow-x-auto" class:loading-dim={data.loading}>
        <table class="data">
          <thead>
            <tr>
              <th>{t("col.title")}</th>
              <th>{t("col.project")}</th>
              <th>{t("col.models")}</th>
              <th class="num">{t("col.prompts")}</th>
              <th class="num">{t("col.messages")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num">{t("col.cost")}</th>
              <th class="num">{t("col.lastSeen")}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.data?.rows ?? [] as r (r.id)}
              <tr class="cursor-pointer" onclick={() => navigate("sessions", r.id)}>
                <td class="max-w-md">
                  <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", r.provider)} title={r.provider}></span>
                    <span class="truncate font-medium">{r.title ?? r.id.split(":").pop()?.slice(0, 13)}</span>
                    {#if r.sessionAgent}<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted">{r.sessionAgent}</span>{/if}
                  </div>
                </td>
                <td class="max-w-48">
                  <div class="truncate text-ink-2" title={r.project}>{r.projectLabel}</div>
                  {#if r.gitBranch}<div class="flex items-center gap-1 truncate text-[11px] text-muted" title={r.gitBranch}><GitBranch size={10} class="shrink-0" /><span class="truncate">{r.gitBranch}</span></div>{/if}
                </td>
                <td class="max-w-40 truncate text-xs text-ink-2">{r.models?.split(",").join(", ")}</td>
                <td class="num text-ink-2">{compact(r.prompts)}</td>
                <td class="num text-ink-2">{compact(r.messages)}</td>
                <td class="num text-ink-2">{compact(r.tokens)}</td>
                <td class="num font-medium">{usd(r.cost)}</td>
                <td class="num text-muted">{relative(r.lastTs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if data.data}
        <div class="flex items-center justify-between px-5 py-3 text-xs text-muted">
          <span>{t("common.showing", { n: data.data.rows.length, total: data.data.total })}</span>
          {#if data.data.rows.length < data.data.total}
            <button class="btn" onclick={() => (limit += 50)}>{t("common.more")}</button>
          {/if}
        </div>
      {/if}
    {/if}
  </Card>
</div>
