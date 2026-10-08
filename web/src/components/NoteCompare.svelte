<script lang="ts">
  import { X } from "@lucide/svelte";
  import { apiUrl, useFetch, type NoteCompare, type NoteWindow } from "../lib/api.svelte.ts";
  import { compact, dateTime, dayWithYear, days as daysText, integer, parseBucket, percent, usd } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { noteChangeChart, NOTE_CHANGE_PAD, NOTE_CHANGE_ROW, type NoteChangeRow } from "../lib/charts.ts";
  import { store } from "../lib/state.svelte.ts";
  import Card from "./Card.svelte";
  import Chart from "./Chart.svelte";

  interface Props {
    /** The note's id. */
    id: string;
    /** The note let go: the card closes. */
    onclose: () => void;
  }
  let { id, onclose }: Props = $props();

  const WINDOWS = [7, 14, 30] as const;
  let windowDays = $state<(typeof WINDOWS)[number]>(14);

  const compare = useFetch<NoteCompare>(() => apiUrl("/api/notes/compare", { id, days: windowDays }));

  type Key = Exclude<keyof NoteWindow, "from" | "to">;
  const rate = (v: number | null | undefined) => percent(v, 1);
  // Rising cost, tokens or errors per prompt is bad and a higher cache hit rate is good. More or fewer prompts is neither.
  const metrics: { key: Key; label: string; format: (v: number | null | undefined) => string; upIsGood: boolean | null }[] = $derived([
    { key: "cost", label: t("notes.compare.cost"), format: (v) => usd(v), upIsGood: false },
    { key: "prompts", label: t("notes.compare.prompts"), format: integer, upIsGood: null },
    { key: "costPerPrompt", label: t("notes.compare.costPerPrompt"), format: (v) => usd(v), upIsGood: false },
    { key: "tokensPerPrompt", label: t("notes.compare.tokensPerPrompt"), format: compact, upIsGood: false },
    { key: "cacheHitRate", label: t("notes.compare.cacheHitRate"), format: rate, upIsGood: true },
    { key: "toolErrorRate", label: t("notes.compare.toolErrorRate"), format: rate, upIsGood: false },
    { key: "apiErrorRate", label: t("notes.compare.apiErrorRate"), format: rate, upIsGood: false },
  ]);

  /** Changes smaller than this (half a percent) read as no change, whether good or bad. */
  const NO_CHANGE = 0.005;

  /** A metric's change from before to after as a fraction, null when either side is missing or the one before is zero. */
  function changeOf(before: number | null | undefined, after: number | null | undefined): number | null {
    if (before == null || after == null || before === 0) return null;

    return (after - before) / before;
  }

  function toneOf(change: number | null, upIsGood: boolean | null): NoteChangeRow["tone"] {
    if (change == null || upIsGood == null || Math.abs(change) < NO_CHANGE) return "neutral";

    return change > 0 === upIsGood ? "good" : "bad";
  }

  const rows = $derived.by((): NoteChangeRow[] => {
    const c = compare.data;
    if (!c) return [];

    return metrics.map((m) => {
      const before = c.before[m.key] ?? null;
      const after = c.after[m.key] ?? null;
      const change = changeOf(before, after);

      return { label: m.label, before, after, change, tone: toneOf(change, m.upIsGood), beforeText: m.format(before), afterText: m.format(after) };
    });
  });
  const option = $derived.by(() => {
    void store.dark;

    return noteChangeChart(rows);
  });

  /** What went wrong, in words of the interface instead of the server's. */
  function problem(message: string): string {
    if (message === "database-newer") return t("readonly.title");
    if (message === "unknown note") return t("notes.compare.notFound");
    return t("error.body");
  }

  /** The days each side covers: the chosen window, or a shorter one while the after window still runs into today. */
  const coveredDays = $derived.by(() => {
    const c = compare.data;
    if (!c?.clipped) return windowDays;

    return Math.max(1, Math.round((c.after.to - c.after.from) / 86_400_000));
  });

  /** The note's text as far as the title has room for it. */
  const TITLE_MAX = 60;
  const shortNote = (text: string) => (text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text);

  const note = $derived(compare.data?.note);
  const noteWhen = $derived(note ? (note.day ? dayWithYear(parseBucket(note.day).getTime()) : dateTime(note.ts)) : "");
</script>

<Card title={note ? t("notes.compare.titleNote", { note: shortNote(note.text) }) : t("notes.compare.title")} subtitle={note ? t("notes.compare.subtitle", { date: noteWhen, days: daysText(coveredDays), n: coveredDays }) : undefined}>
  {#snippet actions()}
    <div class="seg" role="group" aria-label={t("notes.compare.window")}>
      {#each WINDOWS as w (w)}
        <button type="button" aria-pressed={windowDays === w} onclick={() => (windowDays = w)}>{daysText(w)}</button>
      {/each}
    </div>
    <button type="button" class="btn !px-2" aria-label={t("common.close")} title={t("common.close")} onclick={onclose}><X size={14} /></button>
  {/snippet}

  <div class="flex flex-col gap-4 {compare.loading ? 'loading-dim' : ''}">
    {#if compare.data}
      <Chart {option} height={rows.length * NOTE_CHANGE_ROW + NOTE_CHANGE_PAD} label={t("notes.compare.title")} />
      <div class="flex flex-wrap gap-x-4 gap-y-1 pl-2 text-[11px] text-muted">
        <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-good"></span>{t("notes.compare.better")}</span>
        <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-bad"></span>{t("notes.compare.worse")}</span>
        <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-muted"></span>{t("notes.compare.neither")}</span>
      </div>
    {:else if compare.error}
      <p class="text-xs text-bad" role="alert">{problem(compare.error)}</p>
    {/if}
  </div>
</Card>

