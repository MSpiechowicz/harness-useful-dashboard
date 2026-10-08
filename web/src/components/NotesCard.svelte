<script lang="ts">
  import { tick, untrack } from "svelte";
  import { Pencil, Plus, Trash2 } from "@lucide/svelte";
  import { send, type Note } from "../lib/api.svelte.ts";
  import { resizableColumns } from "../lib/columns.svelte.ts";
  import { dateTime, dayWithYear, parseBucket } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { localDay } from "../lib/noteBuckets.ts";
  import { store } from "../lib/state.svelte.ts";
  import TableCard from "./TableCard.svelte";

  interface Props {
    /** The notes in the range. */
    notes: Note[];
    /** The id of the picked note, empty for none. */
    selected: string;
    /** A note was picked for its before and after (an empty id when it is let go). */
    onselect: (id: string) => void;
    /** A day to add the next note to, such as the one clicked on the chart. A new `n` picks the same day again. */
    pick?: { day: string; n: number };
    /** The notes could not be loaded. */
    loadFailed?: boolean;
  }
  let { notes, selected, onselect, pick, loadFailed = false }: Props = $props();

  // Same limit as the server (src/core/notes.ts), which has the last word.
  const MAX_TEXT = 200;

  /** What the fields of a note hold: a day, with a time for a note at a moment, and its text. */
  interface Draft {
    day: string;
    time: string;
    text: string;
  }
  const blank = (): Draft => ({ day: localDay(Date.now()), time: "", text: "" });

  let adding = $state<Draft>(blank());
  let editing = $state<string | null>(null);
  let edit = $state<Draft>(blank());
  let removing = $state<string | null>(null);
  let busy = $state(false);
  let failed = $state<"save" | "delete" | "readonly" | null>(null);
  let open = $state(false);

  type Sort = "recent" | "oldest" | "text";
  let sortKey = $state<Sort>("recent");
  let sortAsc = $state(false);
  const SORTS = $derived<{ value: Sort; label: string; asc?: boolean }[]>([
    { value: "recent", label: t("sort.recent") },
    { value: "oldest", label: t("sort.oldest"), asc: true },
    { value: "text", label: t("sort.textAz"), asc: true },
  ]);

  const sorted = $derived.by(() => {
    const list = [...notes];
    if (sortKey === "oldest") return list.sort((a, b) => a.ts - b.ts);
    if (sortKey === "text") return list.sort((a, b) => a.text.localeCompare(b.text));

    return list.sort((a, b) => b.ts - a.ts);
  });

  /** The rows of a download: the day, the time of a note at a moment, and the text. */
  function exportOf(list: Note[]) {
    return list.map((n) => ({ day: n.day ?? localDay(n.ts), time: draftOf(n).time, text: n.text }));
  }

  // A click on the chart opens the form on that day.
  $effect(() => {
    if (!pick) return;

    untrack(() => {
      adding.day = pick.day;
      void openAdd();
    });
  });

  /** Puts the cursor in the form's text field and brings the form into view. */
  async function focusText(prefix: string) {
    await tick();
    const input = document.getElementById(`${prefix}-text`);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    input?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    input?.focus({ preventScroll: true });
  }

  async function openAdd() {
    open = true;
    failed = null;
    await focusText("note-add");
  }

  function toggleAdd() {
    if (open) {
      open = false;
      return;
    }
    void openAdd();
  }

  function whenText(n: Note): string {
    return n.day ? dayWithYear(parseBucket(n.day).getTime()) : dateTime(n.ts);
  }

  function draftOf(n: Note): Draft {
    if (n.day) return { day: n.day, time: "", text: n.text };
    const d = new Date(n.ts);
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { day: localDay(n.ts), time, text: n.text };
  }

  const valid = (d: Draft) => !!d.day && !!d.text.trim() && d.text.length <= MAX_TEXT;

  /** A whole-day note stands at the day's local midnight and keeps its date, a note at a moment has the time and no day. */
  function fields(d: Draft): { ts: number; day: string | null; text: string } {
    if (d.time) return { ts: new Date(`${d.day}T${d.time}`).getTime(), day: null, text: d.text.trim() };
    return { ts: new Date(`${d.day}T00:00`).getTime(), day: d.day, text: d.text.trim() };
  }

  /** Runs a change, then has the views that show notes load again. */
  async function run(job: () => Promise<unknown>, kind: "save" | "delete" = "save"): Promise<boolean> {
    if (busy) return false;
    busy = true;
    failed = null;
    try {
      await job();
      store.refreshTick++;
      return true;
    } catch (e) {
      failed = e instanceof Error && e.message === "database-newer" ? "readonly" : kind;
      return false;
    } finally {
      busy = false;
    }
  }

  async function add() {
    if (!valid(adding)) return;
    const { day: noteDay, ...rest } = fields(adding);
    const body = noteDay ? { ...rest, day: noteDay } : rest;
    if (!(await run(() => send("/api/notes", body)))) return;

    adding = blank();
    open = false;
  }

  async function save(id: string) {
    if (!valid(edit)) return;
    if (await run(() => send("/api/notes", { id, ...fields(edit) }, "PUT"))) editing = null;
  }

  async function remove(id: string) {
    if (!(await run(() => send("/api/notes", { id }, "DELETE"), "delete"))) return;
    removing = null;
    if (selected === id) onselect("");
  }

  function startEdit(n: Note) {
    edit = draftOf(n);
    editing = n.id;
    removing = null;
    failed = null;
    void focusText("note-edit");
  }

  function startRemove(n: Note) {
    removing = n.id;
    editing = null;
    failed = null;
  }
</script>

<TableCard
  title={t("notes.title")}
  subtitle={t("notes.subtitle")}
  rows={sorted}
  searchText={(n) => `${whenText(n)} ${n.text}`}
  sorts={SORTS}
  bind:sortKey
  bind:asc={sortAsc}
  exportName="notes"
  exportRows={exportOf}
  emptyTitle={loadFailed ? t("notes.loadFailed") : t("notes.empty")}
>
  {#snippet actions()}
    <button type="button" class="btn btn-primary" aria-expanded={open} onclick={toggleAdd}><Plus size={14} />{t("notes.add")}</button>
  {/snippet}

  {#snippet above()}
    {#if open}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <form
        class="flex flex-wrap items-center gap-2 border-b border-line px-5 pb-3"
        onsubmit={(e) => { e.preventDefault(); void add(); }}
        onkeydown={(e) => e.key === "Escape" && (open = false)}
      >
        <input type="date" class="input w-36" bind:value={adding.day} aria-label={t("notes.day")} title={t("notes.day")} required />
        <input type="time" class="input w-28" bind:value={adding.time} aria-label={t("notes.time")} title={t("notes.time")} />
        <input
          id="note-add-text"
          class="input min-w-48 flex-1"
          bind:value={adding.text}
          maxlength={MAX_TEXT}
          placeholder={t("notes.text")}
          aria-label={t("notes.text")}
          aria-describedby="note-add-limit"
          autocomplete="off"
          required
        />
        <button type="submit" class="btn btn-primary shrink-0" disabled={busy || !valid(adding)}>{t("settings.save")}</button>
        <button type="button" class="btn shrink-0" onclick={() => (open = false)}>{t("common.cancel")}</button>
        <p id="note-add-limit" class="basis-full text-xs text-muted">{t("notes.limit", { n: MAX_TEXT })}. {t("notes.hint")}</p>
      </form>
    {/if}

    {#if failed}
      <p class="border-b border-line px-5 py-2.5 text-xs text-bad" role="alert">{t(failed === "readonly" ? "readonly.title" : failed === "delete" ? "notes.deleteFailed" : "notes.saveFailed")}</p>
    {/if}
    {#if loadFailed && sorted.length}
      <p class="border-b border-line px-5 py-2.5 text-xs text-muted" role="alert">{t("notes.loadFailed")}</p>
    {/if}

  {/snippet}

  {#snippet children(view)}
    <!-- The fields of a note being edited belong to this form, whose cells they sit in. -->
    <form id="note-edit-form" onsubmit={(e) => { e.preventDefault(); if (editing) void save(editing); }}></form>

    <table class="data fixed-cols !min-w-[42rem]" use:resizableColumns={"notes"}>
      <colgroup>
        <col class="w-44" />
        <col />
        <col class="w-60" />
      </colgroup>
      <thead>
        <tr>
          <th>{t("notes.day")}</th>
          <th>{t("notes.text")}</th>
          <th data-fixed>{t("palette.actions")}</th>
        </tr>
      </thead>
      <tbody>
        {#each view.rows.slice(view.offset, view.offset + (view.limit ?? view.rows.length)) as n (n.id)}
          {#if editing === n.id}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <tr onkeydown={(e) => e.key === "Escape" && (editing = null)}>
              <td class="align-top">
                <div class="flex flex-col gap-2">
                  <input type="date" class="input w-full" form="note-edit-form" bind:value={edit.day} aria-label={t("notes.day")} title={t("notes.day")} required />
                  <input type="time" class="input w-full" form="note-edit-form" bind:value={edit.time} aria-label={t("notes.time")} title={t("notes.time")} />
                </div>
              </td>
              <td class="align-top !whitespace-normal">
                <input
                  id="note-edit-text"
                  class="input w-full"
                  form="note-edit-form"
                  bind:value={edit.text}
                  maxlength={MAX_TEXT}
                  placeholder={t("notes.text")}
                  aria-label={t("notes.text")}
                  aria-describedby="note-edit-limit"
                  autocomplete="off"
                  required
                />
                <p id="note-edit-limit" class="mt-1 text-xs text-muted">{t("notes.limit", { n: MAX_TEXT })}</p>
              </td>
              <td class="align-top">
                <div class="flex flex-nowrap gap-1.5">
                  <button type="submit" form="note-edit-form" class="btn btn-primary !h-7 !px-2.5 shrink-0" disabled={busy || !valid(edit)}>{t("settings.save")}</button>
                  <button type="button" class="btn !h-7 !px-2.5 shrink-0" onclick={() => (editing = null)}>{t("common.cancel")}</button>
                </div>
              </td>
            </tr>
          {:else if removing === n.id}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <tr onkeydown={(e) => e.key === "Escape" && (removing = null)}>
              <td class="text-xs whitespace-nowrap text-muted tabular">{whenText(n)}</td>
              <td class="!whitespace-normal text-ink">{t("notes.deleteConfirm")}</td>
              <td>
                <div class="flex flex-nowrap gap-1.5">
                  <button type="button" class="btn btn-danger !h-7 !px-2.5 shrink-0" disabled={busy} onclick={() => remove(n.id)}><Trash2 size={13} />{t("notes.delete")}</button>
                  <button type="button" class="btn !h-7 !px-2.5 shrink-0" onclick={() => (removing = null)}>{t("common.cancel")}</button>
                </div>
              </td>
            </tr>
          {:else}
            <tr class={selected === n.id ? "bg-surface-2" : ""}>
              <td class="text-xs whitespace-nowrap text-muted tabular">{whenText(n)}</td>
              <td class="!whitespace-normal break-words text-ink">{n.text}</td>
              <td>
                <div class="flex flex-wrap gap-1.5">
                  <button type="button" class="btn btn-primary !h-7 !px-2.5" aria-pressed={selected === n.id} onclick={() => onselect(selected === n.id ? "" : n.id)}>{t("notes.compare.open")}</button>
                  <button type="button" class="btn !h-7 !px-2" aria-label={t("notes.edit")} title={t("notes.edit")} onclick={() => startEdit(n)}><Pencil size={13} /></button>
                  <button type="button" class="btn btn-danger !h-7 !px-2" aria-label={t("notes.delete")} title={t("notes.delete")} onclick={() => startRemove(n)}><Trash2 size={13} /></button>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/snippet}
</TableCard>
