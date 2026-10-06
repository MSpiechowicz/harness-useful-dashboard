<script lang="ts">
  import Card from "./Card.svelte";
  import Chart from "./Chart.svelte";
  import { callIntervals, contextByAgent, intervalBars, type CallRow } from "../lib/charts.ts";
  import { colorFor, cssVar } from "../lib/colors.svelte.ts";
  import { compact, duration, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";

  /**
   * A session's or prompt's model calls in four plain charts, one question each: how the context grew, agent by agent,
   * and per interval what was read from and written to the cache, what went in and came out fresh, and what it cost.
   */
  /** `prompts`: each prompt's number in the session, to mark where each began (left out for a single prompt). */
  let { rows, prompts }: { rows: (CallRow & { promptId?: string | null })[]; prompts?: Map<string, number> } = $props();

  const groups = $derived(callIntervals(rows));
  const every = $derived(duration(groups.step));
  const name = (k: string) => t(`tok.${k}` as "tok.input");
  const context = $derived.by(() => (void store.dark, contextByAgent(rows, prompts)));
  const cache = $derived.by(
    () => (void store.dark, intervalBars(groups, (["cacheRead", "cacheWrite"] as const).map((k) => ({ key: k, name: name(k), color: colorFor("type", k) })), compact)),
  );
  const fresh = $derived.by(() => (void store.dark, intervalBars(groups, (["input", "output"] as const).map((k) => ({ key: k, name: name(k), color: colorFor("type", k) })), compact)));
  const cost = $derived.by(() => (void store.dark, intervalBars(groups, [{ key: "cost", name: t("col.cost"), color: cssVar("--data") }], (v) => usd(v, { compact: true }))));
</script>

<Card title={t("timeline.agentsTitle")} subtitle={`${t("timeline.agentsHint", { n: compact(rows.length) })}${prompts ? ` ${t("timeline.promptLines")}` : ""}`}>
  <Chart option={context} height={280} />
</Card>
<div class="grid gap-5 xl:grid-cols-3">
  <Card title={t("timeline.cacheTitle")} subtitle={t("timeline.cacheHint", { every })}>
    <Chart option={cache} height={220} />
  </Card>
  <Card title={t("timeline.ioTitle")} subtitle={t("timeline.ioHint", { every })}>
    <Chart option={fresh} height={220} />
  </Card>
  <Card title={t("timeline.costTitle")} subtitle={t("timeline.costHint", { every })}>
    <Chart option={cost} height={220} />
  </Card>
</div>
