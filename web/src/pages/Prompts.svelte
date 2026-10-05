<script lang="ts">
  import { Search, Sparkles } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { apiUrl, useFetch } from "../lib/api.svelte.ts";
  import { colorFor } from "../lib/colors.svelte.ts";
  import { compact, dateTime, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { navigate } from "../lib/state.svelte.ts";

  interface PromptRow {
    id: string;
    ts: number;
    text: string | null;
    skill: string | null;
    provider: string;
    projectLabel: string;
    project: string | null;
    sessionTitle: string | null;
    tokens: number;
    cost: number;
    messages: number;
    toolCalls: number;
    subagentCost: number;
    models: string | null;
  }

  let sort = $state<"cost" | "tokens" | "recent" | "messages">("cost");
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

  const data = useFetch<{ total: number; rows: PromptRow[] }>(() => apiUrl("/api/prompts", { sort, q: debounced, limit }));
  const maxCost = $derived(Math.max(1e-9, ...(data.data?.rows ?? []).map((r) => r.cost)));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("prompts.title")} subtitle={t("prompts.subtitle")}>
    <label class="relative">
      <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
      <input class="input w-56 pl-8" placeholder={t("filter.search")} bind:value={query} />
    </label>
    <select class="input" bind:value={sort}>
      {#each ["cost", "tokens", "recent", "messages"] as s (s)}<option value={s}>{t(`sort.${s}` as "sort.cost")}</option>{/each}
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
              <th>{t("col.prompt")}</th>
              <th>{t("col.project")}</th>
              <th class="num">{t("col.messages")}</th>
              <th class="num">{t("col.tools")}</th>
              <th class="num">{t("col.tokens")}</th>
              <th class="num w-44">{t("col.cost")}</th>
              <th class="num">{t("col.time")}</th>
            </tr>
          </thead>
          <tbody>
            {#each data.data?.rows ?? [] as r (r.id)}
              <tr class="cursor-pointer" onclick={() => navigate("prompts", r.id)}>
                <td class="max-w-xl">
                  <div class="flex items-start gap-2">
                    <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", r.provider)} title={r.provider}></span>
                    <div class="min-w-0">
                      <div class="line-clamp-2 text-ink">{r.text ?? t("prompts.noText")}</div>
                      {#if r.skill}<div class="mt-0.5 inline-flex items-center gap-1 text-[11px] text-accent-ink"><Sparkles size={10} />{r.skill}</div>{/if}
                    </div>
                  </div>
                </td>
                <td class="max-w-40 truncate text-ink-2" title={r.project}>{r.projectLabel}</td>
                <td class="num text-ink-2">{compact(r.messages)}</td>
                <td class="num text-ink-2">{compact(r.toolCalls)}</td>
                <td class="num text-ink-2">{compact(r.tokens)}</td>
                <td class="num">
                  <div class="flex items-center justify-end gap-2">
                    <div class="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                      <div class="h-full rounded-full bg-accent" style:width="{(r.cost / maxCost) * 100}%"></div>
                    </div>
                    <span class="font-medium">{usd(r.cost)}</span>
                  </div>
                </td>
                <td class="num text-xs text-muted">{dateTime(r.ts)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if data.data}
        <div class="flex items-center justify-between px-5 py-3 text-xs text-muted">
          <span>{t("common.showing", { n: data.data.rows.length, total: data.data.total })}</span>
          {#if data.data.rows.length < data.data.total}<button class="btn" onclick={() => (limit += 50)}>{t("common.more")}</button>{/if}
        </div>
      {/if}
    {/if}
  </Card>
</div>
