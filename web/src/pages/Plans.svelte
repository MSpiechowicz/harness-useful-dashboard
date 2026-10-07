<script lang="ts">
  import Card from "../components/Card.svelte";
  import Chart from "../components/Chart.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import Empty from "../components/Empty.svelte";
  import Kpi from "../components/Kpi.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import { NAMES, planName, windowName } from "../components/PlanLimits.svelte";
  import ViewGate from "../components/ViewGate.svelte";
  import { apiUrl, getJson, send, settled, useFetch } from "../lib/api.svelte.ts";
  import { limitHistoryChart, timeSeriesChart } from "../lib/charts.ts";
  import { colorFor, rankKeys } from "../lib/colors.svelte.ts";
  import { compact, dayWithYear, decimal, integer, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { PROVIDER_NAMES } from "../lib/palette.ts";
  import { store } from "../lib/state.svelte.ts";

  interface PlanRow {
    key: string;
    providers: string[];
    calls: number;
    tokens: number;
    cost: number;
    premiumRequests: number;
    firstTs: number;
    lastTs: number;
    price: number | null;
    days: number;
    paid: number | null;
  }
  interface History {
    key: string;
    reportKey: string;
    provider: string;
    plan: string | null;
    windowId: string;
    windowMs: number | null;
    scope: string | null;
    label: string | null;
    points: [number, number][];
    cycles: { end: number; peak: number }[];
    hits: number;
  }
  interface PlansData {
    plans: PlanRow[];
    buckets: string[];
    series: { key: string; name: string; data: number[] }[];
    history: History[];
  }

  // Saving a price reloads the page's data, so what it was paid and worth follows at once.
  let saved = $state(0);
  const d = useFetch<PlansData>(() => apiUrl("/api/plans", { bucket: store.bucket, v: saved }));

  /** Plans by what people call them: Codex runs on a ChatGPT plan, and omp on whatever it is logged in to. */
  const LABELS: Record<string, string> = {
    claude: "Claude",
    codex: "ChatGPT",
    copilot: "GitHub Copilot",
    openai: "OpenAI API",
    anthropic: "Anthropic API",
    openrouter: "OpenRouter",
    "google-gemini-cli": "Gemini CLI",
  };
  const label = (key: string) => LABELS[key] ?? NAMES[key] ?? PROVIDER_NAMES[key as keyof typeof PROVIDER_NAMES] ?? key;
  const providerNames = (r: PlanRow) => r.providers.map((p) => PROVIDER_NAMES[p as keyof typeof PROVIDER_NAMES] ?? p).join(", ");

  // Prices are edited in place and kept in the settings.
  let prices = $state<Record<string, number>>({});
  let draft = $state<Record<string, string>>({});
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  $effect(() => {
    getJson<{ config: { planPrices?: Record<string, number> } }>("/api/settings")
      .then((s) => {
        prices = s.config.planPrices ?? {};
        draft = Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, String(v)]));
      })
      .catch(() => {});
  });
  async function savePrice(key: string) {
    const raw = (draft[key] ?? "").trim().replace(",", ".");
    const next = { ...prices };
    if (raw === "") delete next[key];
    else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        draft[key] = prices[key] != null ? String(prices[key]) : "";
        return;
      }
      next[key] = v;
    }
    if (JSON.stringify(next) === JSON.stringify(prices)) return;
    saving = true;
    saveError = null;
    try {
      await send("/api/settings", { planPrices: next }, "PUT");
      prices = next;
      saved++;
    } catch (e) {
      saveError = (e as Error).message;
    } finally {
      saving = false;
    }
  }

  const plans = $derived(d.data?.plans ?? []);
  const totalCost = $derived(plans.reduce((a, p) => a + p.cost, 0));
  const priced = $derived(plans.filter((p) => p.paid != null));
  const paid = $derived(priced.reduce((a, p) => a + (p.paid ?? 0), 0));
  const pricedCost = $derived(priced.reduce((a, p) => a + p.cost, 0));
  const value = (cost: number, paid: number | null) => (paid ? `${decimal(cost / paid)}×` : "–");

  const option = $derived.by(() => {
    void store.dark;
    if (!d.data) return null;
    const series = d.data.series.map((s) => ({ ...s, name: label(s.key) }));
    return timeSeriesChart({ buckets: d.data.buckets, series }, { dim: "provider", metric: "cost", bucket: store.bucket });
  });

  // Limit history: a line per window.
  const history = $derived(d.data?.history ?? []);
  const baseName = (h: History) => `${label(h.provider)}${h.plan ? ` ${planName(h.plan)}` : ""} · ${windowName({ id: h.windowId, windowMs: h.windowMs, scope: h.scope, label: h.label, usedFraction: 0, resetsAt: null })}`;
  // A plan can log two windows of the same length (Codex's primary and secondary after a plan change): names must
  // stay apart, as the legend tells series by name.
  const names = $derived.by(() => {
    const count = new Map<string, number>();
    for (const h of history) count.set(baseName(h), (count.get(baseName(h)) ?? 0) + 1);
    return new Map(history.map((h) => [h.key, (count.get(baseName(h)) ?? 0) > 1 ? `${baseName(h)} (${h.windowId})` : baseName(h)]));
  });
  const historyName = (h: History) => names.get(h.key) ?? baseName(h);
  $effect(() => {
    rankKeys("limit", history.map((h) => h.key));
  });
  // One limit at a time, over its own history: chosen here or by its row, the longest history first.
  let picked = $state<string | null>(null);
  const selected = $derived(history.find((h) => h.key === picked) ?? [...history].sort((a, b) => b.points.length - a.points.length)[0] ?? null);
  const historyOption = $derived.by(() => {
    void store.dark;
    const h = selected;
    if (!h?.points.length) return null;
    const to = Math.min(store.filters.to ?? Date.now(), Date.now());
    // A window's peak is the last reading before it reset: a red point where it ran out.
    const outs = h.cycles.filter((c) => c.peak >= 0.995).map((c) => [Math.min(c.end, to), c.peak] as [number, number]);
    return limitHistoryChart({ name: historyName(h), color: colorFor("limit", h.key), points: h.points, outs, from: h.points[0]![0], to });
  });
  const hits = $derived(history.reduce((a, h) => a + h.hits, 0));
  const cycles = $derived(history.reduce((a, h) => a + h.cycles.length, 0));
  const avgPeak = (h: History) => (h.cycles.length ? percent(h.cycles.reduce((a, c) => a + c.peak, 0) / h.cycles.length) : "–");
  const highest = (h: History) => (h.cycles.length ? percent(Math.max(...h.cycles.map((c) => c.peak))) : "–");
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("plans.title")} subtitle={t("plans.subtitle")} />
  <ViewGate ready={settled(d)}>
    {#if !d.data}
      <div class="card"><Empty compact title={t("common.loadFailed")} /></div>
    {:else if !plans.length}
      <div class="card"><Empty /></div>
    {:else}
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label={t("plans.apiCost")} amount={totalCost} format={usd} hint={t("plans.apiCostHint")} />
        <Kpi label={t("plans.paid")} amount={priced.length ? paid : null} format={usd} hint={priced.length ? t("plans.paidHint", { n: priced.length }) : t("plans.noPrices")} />
        <Kpi label={t("plans.value")} value={value(pricedCost, paid)} hint={t("plans.valueHint")} />
        <Kpi label={t("plans.runOuts")} amount={history.length ? hits : null} format={integer} hint={history.length ? t("plans.runOutsHint", { n: cycles }) : t("plans.noHistoryShort")} />
      </div>

      <Card title={t("plans.perPlan")} subtitle={t("plans.perPlanHint")} pad={false}>
        <div class="overflow-x-auto">
          <table class="data">
            <thead>
              <tr>
                <th>{t("plans.plan")}</th>
                <th class="num">{t("col.calls")}</th>
                <th class="num">{t("col.tokens")}</th>
                <th class="num">{t("plans.apiCost")}</th>
                <th class="num">{t("plans.price")}</th>
                <th class="num">{t("plans.paid")}</th>
                <th class="num">{t("plans.value")}</th>
              </tr>
            </thead>
            <tbody>
              {#each plans as p (p.key)}
                <tr>
                  <td>
                    <div class="flex items-center gap-2">
                      <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("provider", p.key)}></span>
                      <span class="font-medium text-ink">{label(p.key)}</span>
                    </div>
                    <div class="mt-0.5 pl-[18px] text-[11px] text-muted">{t("plans.usedBy", { names: providerNames(p) })}</div>
                  </td>
                  <td class="num text-ink-2">{compact(p.calls)}</td>
                  <td class="num text-ink-2">{compact(p.tokens)}</td>
                  <td class="num font-medium">{usd(p.cost)}</td>
                  <td class="num">
                    <label class="input ml-auto flex h-8 w-32 items-center gap-1.5">
                      <span class="text-xs text-muted">$</span>
                      <input
                        class="h-full min-w-0 flex-1 bg-transparent text-right tabular outline-none"
                        inputmode="decimal"
                        aria-label={t("plans.priceFor", { plan: label(p.key) })}
                        bind:value={draft[p.key]}
                        onchange={() => savePrice(p.key)}
                        disabled={saving}
                      />
                      <span class="shrink-0 text-xs text-muted">{t("plans.perMonth")}</span>
                    </label>
                  </td>
                  <td class="num text-ink-2" title={t("plans.paidFor", { n: p.days })}>{p.paid != null ? usd(p.paid) : "–"}</td>
                  <td class="num font-medium {p.paid != null && p.cost >= p.paid ? 'text-good' : ''}">{value(p.cost, p.paid)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if saveError}<p class="px-5 pb-4 text-xs text-bad">{saveError}</p>{/if}
      </Card>

      <Card title={t("plans.overTime")} subtitle={t("plans.overTimeHint")}>
        {#if option}<Chart {option} height={260} dim={d.loading} />{/if}
      </Card>

      <Card
        title={t("plans.history")}
        subtitle={selected ? t("plans.historyHint", { since: dayWithYear(selected.points[0]![0]) }) : t("plans.historyHintEmpty")}
      >
        {#snippet actions()}
          {#if history.length > 1 && selected}
            <Dropdown label={t("plans.window")} value={selected.key} options={history.map((h) => ({ value: h.key, label: historyName(h) }))} onchange={(k) => (picked = k)} />
          {/if}
        {/snippet}
        {#if historyOption && selected}
          <div class="flex flex-col gap-5">
            <Chart option={historyOption} height={260} dim={d.loading} />
            <table class="data">
              <thead>
                <tr>
                  <th>{t("plans.window")}</th>
                  <th class="num">{t("plans.since")}</th>
                  <th class="num">{t("plans.cycles")}</th>
                  <th class="num">{t("plans.runOuts")}</th>
                  <th class="num">{t("plans.avgPeak")}</th>
                  <th class="num">{t("plans.highest")}</th>
                </tr>
              </thead>
              <tbody>
                {#each history as h (h.key)}
                  <tr class="cursor-pointer {h.key === selected.key ? 'bg-surface-2' : ''}" onclick={() => (picked = h.key)}>
                    <td>
                      <div class="flex items-center gap-2">
                        <span class="h-2.5 w-2.5 shrink-0 rounded-sm" style:background={colorFor("limit", h.key)}></span>
                        <!-- A button for the keyboard, without a handler of its own: its click reaches the row's. -->
                        <button type="button" class="truncate text-left" class:font-medium={h.key === selected.key} aria-pressed={h.key === selected.key}>{historyName(h)}</button>
                      </div>
                    </td>
                    <td class="num text-ink-2">{dayWithYear(h.points[0]![0])}</td>
                    <td class="num text-ink-2">{h.cycles.length}</td>
                    <td class="num font-medium {h.hits ? 'text-bad' : ''}">{h.hits}</td>
                    <td class="num text-ink-2">{avgPeak(h)}</td>
                    <td class="num text-ink-2">{highest(h)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="flex flex-col items-center gap-1.5 py-8 text-center">
            <div class="text-sm text-ink-2">{t("plans.noHistory")}</div>
            <div class="max-w-md text-xs text-muted">{t("plans.noHistoryHint")}</div>
          </div>
        {/if}
      </Card>
    {/if}
  </ViewGate>
</div>
