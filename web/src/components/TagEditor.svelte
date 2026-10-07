<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
  import { send, useFetch } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import Card from "./Card.svelte";

  interface Props {
    /** The session's id. */
    id: string;
    /** The tags the session has itself, and the ones it takes from its parent session and from its project's default. */
    tags: string[];
    inherited: string[];
    rule: string | null;
    note: { note: string; updatedAt: number } | null;
  }
  let { id, tags: given, inherited, rule, note }: Props = $props();

  // Same limits as the server (src/core/tags.ts), which has the last word.
  const MAX_TAG = 32;
  const MAX_NOTE = 2000;

  let tags = $state<string[]>([]);
  $effect(() => {
    tags = given;
  });
  const suggestions = useFetch<{ tag: string; sessions: number }[]>(() => "/api/tags/all");
  const free = $derived((suggestions.data ?? []).map((s) => s.tag).filter((tag) => !tags.includes(tag)));
  const listId = $derived(`tag-suggestions-${id.replace(/[^a-z0-9]/gi, "")}`);

  let input = $state("");
  let tagError = $state(false);
  let busy = $state(false);

  /** Changed data other views show (the filter's tags, the tables): they load again. */
  const changed = () => store.refreshTick++;

  async function add() {
    const value = input.trim();
    if (!value || busy) return;
    busy = true;
    tagError = false;
    try {
      tags = await send<string[]>("/api/tags", { session: id, tag: value });
      input = "";
      changed();
    } catch {
      tagError = true;
    } finally {
      busy = false;
    }
  }

  async function remove(tag: string) {
    if (busy) return;
    busy = true;
    tagError = false;
    try {
      tags = await send<string[]>("/api/tags", { session: id, tag }, "DELETE");
      changed();
    } catch {
      tagError = true;
    } finally {
      busy = false;
    }
  }

  // The note is saved when the box loses focus or with the button. A draft is kept until it is saved.
  const savedNote = $derived(note?.note ?? "");
  let draft = $state("");
  let saved = $state(false);
  let noteError = $state(false);
  $effect(() => {
    void id;
    draft = savedNote;
    saved = false;
  });
  const dirty = $derived(draft.trim() !== savedNote);

  async function saveNote() {
    if (!dirty || busy) return;
    busy = true;
    noteError = false;
    try {
      await send("/api/session/note", { session: id, note: draft }, "PUT");
      saved = true;
      changed();
    } catch {
      noteError = true;
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid items-stretch gap-5 md:grid-cols-2">
  <Card title={t("nav.tags")} subtitle={t("tags.hint")}>
    <div class="flex flex-col gap-3">
      {#if tags.length || inherited.length || rule}
        <ul class="flex flex-wrap gap-1.5">
          {#each tags as tag (tag)}
            <li class="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 pr-1 pl-2.5 text-xs text-accent-ink">
              {tag}
              <button type="button" class="grid h-4 w-4 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink" aria-label={t("tags.remove", { tag })} title={t("tags.remove", { tag })} onclick={() => remove(tag)}><X size={11} /></button>
            </li>
          {/each}
          {#each inherited as tag (tag)}
            <li class="inline-flex h-6 items-center rounded-full border border-dashed border-line px-2.5 text-xs text-ink-2" title={t("tags.fromParent")}>{tag}</li>
          {/each}
          {#if rule}<li class="inline-flex h-6 items-center rounded-full border border-dashed border-line px-2.5 text-xs text-ink-2" title={t("tags.fromProject")}>{rule}</li>{/if}
        </ul>
      {/if}
      <form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); void add(); }}>
        <input class="input min-w-0 flex-1" bind:value={input} list={listId} maxlength={MAX_TAG} autocomplete="off" aria-label={t("tags.input")} placeholder={t("tags.input")} />
        <datalist id={listId}>{#each free as tag (tag)}<option value={tag}></option>{/each}</datalist>
        <button type="submit" class="btn shrink-0" disabled={busy || !input.trim()}><Plus size={14} />{t("tags.add")}</button>
      </form>
      {#if tagError}<p class="text-xs text-bad" role="alert">{t("tags.failed")}</p>{/if}
    </div>
  </Card>

  <Card title={t("tags.note")} subtitle={t("tags.noteHint")}>
    <div class="flex flex-col gap-3">
      <textarea
        class="input !h-auto min-h-24 w-full resize-y py-2 leading-relaxed"
        bind:value={draft}
        maxlength={MAX_NOTE}
        aria-label={t("tags.noteInput")}
        placeholder={t("tags.noteInput")}
        oninput={() => (saved = false)}
        onblur={saveNote}
      ></textarea>
      <div class="flex items-center justify-end gap-3">
        {#if noteError}<span class="mr-auto text-xs text-bad" role="alert">{t("tags.noteFailed")}</span>{:else if saved && !dirty}<span class="mr-auto text-xs text-good">{t("tags.noteSaved")}</span>{/if}
        <span class="text-xs text-muted tabular">{t("tags.noteCount", { n: draft.length, max: MAX_NOTE })}</span>
        <button type="button" class="btn btn-primary shrink-0" disabled={busy || !dirty} onclick={saveNote}>{t("tags.noteSave")}</button>
      </div>
    </div>
  </Card>
</div>
