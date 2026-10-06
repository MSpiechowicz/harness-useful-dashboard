<script lang="ts">
  import { ArrowDownRight, ArrowUpRight } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import TableCard from "../components/TableCard.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, settled, useFetch, type Drift, type DriftComparison, type DriftMetric } from "../lib/api.svelte.ts";
  import { driftLine } from "../lib/charts.ts";
  import { compact, decimal, integer, percent } from "../lib/format.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  // The model and effort compared here. Until one is picked, the server takes the global model filter or the busiest model.
  let selected = $state("");
  let effort = $state("");
  const d = useFetch<Drift>(() => apiUrl("/api/drift", { select: selected, effort }));
  const model = $derived(selected || d.data?.model || "");

  const METRICS: DriftMetric[] = ["speed", "ttft", "toolErrors", "interrupts", "steps", "output"];
  const FORMAT: Record<DriftMetric, (v: number) => string> = {
    speed: (v) => t("drift.unit.tps", { v: integer(v) }),
    ttft: (v) => t("drift.unit.s", { v: decimal(v, 1) }),
    toolErrors: (v) => percent(v / 100, 1),
    interrupts: (v) => decimal(v, 1),
    steps: (v) => decimal(v, 1),
    output: (v) => compact(v),
  };
  const fmt = (m: DriftMetric, v: number | null) => (v == null ? "–" : FORMAT[m](v));
  const label = (m: DriftMetric) => t(`drift.metric.${m}` as MessageKey);
  const hint = (m: DriftMetric) => t(`drift.metric.${m}Hint` as MessageKey);

  const PROVIDERS: Record<string, MessageKey> = {
    claude: "settings.source.claude",
    codex: "settings.source.codex",
    omp: "settings.source.omp",
    pi: "settings.source.pi",
    opencode: "settings.source.opencode",
  };
  const providerName = (p: string) => (PROVIDERS[p] ? t(PROVIDERS[p]) : p);

  /** The local day a timestamp falls on, as the server keys its days. */
  function dayKey(ts: number): string {
    const x = new Date(ts);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }

  const modelOptions = $derived.by(() => {
    const names = (d.data?.models ?? []).map((m) => m.model);
    if (model && !names.includes(model)) names.unshift(model);
    return names.map((m) => ({ value: m, label: m }));
  });
  const effortOptions = $derived([{ value: "", label: t("drift.allEfforts") }, ...(d.data?.efforts ?? []).map((e) => ({ value: e, label: e }))]);

  function pick(m: string) {
    selected = m;
    effort = "";
  }

  const series = $derived(new Map((d.data?.series ?? []).map((s) => [s.key, s])));
  const options = $derived.by(() => {
    void store.dark;
    const data = d.data;
    if (!data) return new Map();
    const recentFrom = dayKey(data.window.recentFrom);
    return new Map(
      data.series.map((s) => [
        s.key,
        driftLine({
          days: data.days,
          values: s.values,
          counts: s.counts,
          band: s.comparison.band,
          recentFrom,
          versions: data.versions,
          name: label(s.key),
          format: FORMAT[s.key],
          labels: { samples: t("drift.samples"), usual: t("drift.usualRange"), update: t("drift.update"), recent: t("drift.recent"),
            baselineWindow: t("drift.window.baseline", { n: data.window.baselineDays }),
            recentWindow: t("drift.window.recent", { n: data.window.recentDays }),
          },
        }),
      ]),
    );
  });

  const tone = (c: DriftComparison) => (c.status !== "changed" ? "neutral" : c.better == null ? "warn" : c.better ? "good" : "bad");
  const statusText = (c: DriftComparison) =>
    c.status === "insufficient" ? t("drift.status.insufficient") : c.status === "stable" ? t("drift.status.stable") : c.better == null ? t("drift.status.changed") : c.better ? t("drift.better") : t("drift.worse");
  const signed = (x: number) => `${x > 0 ? "+" : ""}${percent(x, Math.abs(x) < 0.1 ? 1 : 0)}`;

  // The all-models table, sorted here and paged by the card.
  type Row = Drift["models"][number] & { flagged: number };
  type Sort = "responses" | "flagged" | "model";
  let sort = $state<Sort>("responses");
  let asc = $state(false);
  const SORTS = $derived<{ value: Sort; label: string; asc?: boolean }[]>([
    { value: "responses", label: t("drift.responses") },
    { value: "flagged", label: t("drift.status.changed") },
    { value: "model", label: t("col.model"), asc: true },
  ]);
  const rows = $derived.by(() => {
    const dir = asc ? 1 : -1;
    return (d.data?.models ?? [])
      .map((m): Row => ({ ...m, flagged: METRICS.filter((k) => m.metrics[k].status === "changed").length }))
      .sort((a, b) => (sort === "model" ? dir * a.model.localeCompare(b.model) : dir * (a[sort] - b[sort])));
  });
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("drift.title")} subtitle={t("drift.subtitle", { recent: d.data?.window.recentDays ?? 7, baseline: d.data?.window.baselineDays ?? 28 })}>
    {#if modelOptions.length}
      <Dropdown prefix label={t("drift.model")} value={model} options={modelOptions} onchange={pick} />
      <Dropdown prefix label={t("drift.effort")} bind:value={effort} options={effortOptions} />
    {/if}
  </PageHeader>
  <ViewGate ready={settled(d)}>
    {#if d.data && !d.data.model}
      <div class="card"><Empty body={t("drift.empty")} /></div>
    {:else if d.data}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        {#each METRICS as m (m)}
          {@const c = series.get(m)?.comparison}
          {#if c}
            {@const tn = tone(c)}
            <div class="card flex min-w-0 flex-col gap-2 px-4 py-3.5" title={hint(m)}>
              <div class="truncate text-xs font-medium text-muted">{label(m)}</div>
              <div class="truncate text-2xl leading-tight font-semibold tracking-tight text-ink">{fmt(m, c.recent)}</div>
              <div class="flex h-4 items-center gap-1 text-xs whitespace-nowrap" class:text-good={tn === "good"} class:text-bad={tn === "bad"} class:text-warn={tn === "warn"} class:text-muted={tn === "neutral"}>
                {#if c.status === "changed" && c.change != null}
                  {#if c.change >= 0}<ArrowUpRight size={13} />{:else}<ArrowDownRight size={13} />{/if}
                  <span class="tabular">{signed(c.change)}</span>
                {/if}
                <span class="truncate">{c.baseline == null ? t("drift.noBaseline") : statusText(c)}</span>
              </div>
              <!-- Always there, so every tile is the same height. The usual value only when it adds something: what a
                   changed measure moved from, or what to expect when the last days are too thin to judge. -->
              <div class="h-4 truncate text-xs leading-4 text-muted">{c.baseline != null && c.status !== "stable" ? t("drift.usual", { value: fmt(m, c.baseline) }) : ""}</div>
            </div>
          {/if}
        {/each}
      </div>

      <!-- What the marks on every chart mean. -->
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
        <span class="flex items-center gap-1.5"><span class="h-0.5 w-3.5 rounded-full bg-accent"></span>{t("drift.legend.daily")}</span>
        <span class="flex items-center gap-1.5"><span class="h-3 w-3.5 rounded-sm bg-accent/20"></span>{t("drift.usualRange")}</span>
        <span class="flex items-center gap-1.5"><span class="h-3 w-3.5 rounded-sm bg-ink-2/20"></span>{t("drift.legend.recent", { n: d.data.window.recentDays })}</span>
        <span class="flex items-center gap-1.5"><span class="h-3.5 w-0 border-l border-dashed border-muted"></span>{t("drift.update")}</span>
      </div>

      <div class="grid gap-5 xl:grid-cols-2">
        {#each METRICS as m (m)}
          {@const s = series.get(m)}
          {#if s}
            <Card title={label(m)} subtitle={s.providers.length ? `${hint(m)} · ${t("drift.from", { providers: s.providers.map(providerName).join(", ") })}` : hint(m)}>
              {#if s.counts.some((n) => n > 0) && options.get(m)}
                <Chart option={options.get(m)} height={240} dim={d.loading} />
              {:else}
                <Empty compact title={t("drift.notRecorded")} />
              {/if}
            </Card>
          {/if}
        {/each}
      </div>

      <TableCard title={t("drift.allModels")} subtitle={t("drift.allModelsHint")} {rows} searchText={(r) => r.model} sorts={SORTS} bind:sortKey={sort} bind:asc>
        {#snippet children(view)}
          <div class="overflow-x-auto">
            <table class="data">
              <thead>
                <tr>
                  <th>{t("col.model")}</th>
                  <th>{t("col.provider")}</th>
                  <th class="num">{t("drift.responses")}</th>
                  {#each METRICS as m (m)}<th class="num" title={hint(m)}>{label(m)}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as r (r.model)}
                  <tr class="cursor-pointer" class:bg-surface-2={r.model === model} onclick={() => pick(r.model)}>
                    <td class="text-ink">{r.model}</td>
                    <td class="text-ink-2">{providerName(r.provider)}</td>
                    <td class="num text-ink-2">{compact(r.responses)}</td>
                    {#each METRICS as m (m)}
                      {@const c = r.metrics[m]}
                      {@const tn = tone(c)}
                      <td
                        class="num"
                        class:text-good={tn === "good"}
                        class:text-bad={tn === "bad"}
                        class:text-warn={tn === "warn"}
                        class:text-muted={c.status === "insufficient"}
                        class:text-ink-2={c.status === "stable"}
                        title={`${fmt(m, c.recent)} · ${t("drift.usual", { value: fmt(m, c.baseline) })}`}
                      >
                        {c.status === "insufficient" || c.change == null ? "–" : signed(c.change)}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/snippet}
      </TableCard>
    {/if}
  </ViewGate>
</div>
