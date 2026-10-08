<script lang="ts">
  import type { TimeSeries } from "../lib/api.svelte.ts";
  import { timeSeriesChart, timeSeriesKind, type ChartNote } from "../lib/charts.ts";
  import { store } from "../lib/state.svelte.ts";
  import Chart from "./Chart.svelte";

  interface Props {
    ts: TimeSeries;
    /** Dimension the series belong to (provider, model, project, type…). */
    dim: string;
    bucket: string;
    metric: "tokens" | "cost";
    valueKind?: "tokens" | "cost";
    kind?: "bar" | "area";
    average?: { window: number; label: string };
    height?: number;
    /** Fill the card's height, with `height` as the least (see Chart). */
    fill?: boolean;
    loading?: boolean;
    /** Notes marked on the chart as vertical rules (see chartNotes). */
    notes?: ChartNote[];
    /** A note's rule was clicked: its id. */
    onnote?: (id: string) => void;
    /** A click on the plot: the key of the bucket under it. */
    onbucket?: (bucket: string) => void;
  }
  let { ts, dim, bucket, metric, valueKind, kind, average, height = 300, fill = false, loading = false, notes, onnote, onbucket }: Props = $props();

  // Columns stack every series, so clicking one in the legend switches it on and off; the area of a long range
  // shows one series at a time, so there clicking highlights it. The average's entry always switches the dashed
  // line. A new grouping starts over with everything on and the biggest series highlighted.
  let highlight = $state<string | null>(null);
  let hidden = $state<string[]>([]);
  $effect(() => {
    void dim;
    highlight = null;
    hidden = [];
  });
  const option = $derived.by(() => {
    void store.dark;
    return timeSeriesChart(ts, { dim, metric, bucket, kind, valueKind, average, highlight, hidden, notes });
  });
  function onlegend(name: string) {
    if ((average && name === average.label) || timeSeriesKind(ts, kind) === "bar") hidden = hidden.includes(name) ? hidden.filter((n) => n !== name) : [...hidden, name];
    else highlight = name;
  }
  // A click on a note's rule, dot or label picks the note.
  function onclick(p: { seriesName?: string; data?: unknown }) {
    if (p.seriesName !== "__notes__") return;
    const id = (p.data as { noteId?: string } | undefined)?.noteId;
    if (id) onnote?.(id);
  }
  function onpoint(index: number) {
    const key = ts.buckets[index];
    if (key) onbucket?.(key);
  }
</script>

<Chart
  {option}
  {height}
  {fill}
  dim={loading}
  legendOff={hidden}
  {onlegend}
  onclick={onnote ? onclick : undefined}
  onpoint={onbucket ? onpoint : undefined}
/>
