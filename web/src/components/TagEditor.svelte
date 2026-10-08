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
  const listId = $derived(`tag-suggestions-${id.replace(/[^a-z0-9]/gi, "")}`);

  let input = $state("");
  let tagError = $state(false);
  let busy = $state(false);

  // Existing tags as you type: ones that start with what's typed first, then ones that contain it, the most used first
  // within each (the list comes most used first). With nothing typed, the most used ones.
  const MAX_SUGGESTIONS = 8;
  let open = $state(false);
  let active = $state(-1);
  const matches = $derived.by(() => {
    const q = input.trim().toLowerCase();
    const free = (suggestions.data ?? []).filter((s) => !tags.includes(s.tag) && s.tag.toLowerCase() !== q);
    if (!q) return free.slice(0, MAX_SUGGESTIONS);
    const starts = free.filter((s) => s.tag.toLowerCase().startsWith(q));
    const within = free.filter((s) => !s.tag.toLowerCase().startsWith(q) && s.tag.toLowerCase().includes(q));
    return [...starts, ...within].slice(0, MAX_SUGGESTIONS);
  });
  const showList = $derived(open && matches.length > 0);
  $effect(() => {
    void matches;
    active = -1;
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open = true;
      if (!matches.length) return;
      // Past either end goes back to the typed text (-1).
      const next = active + (e.key === "ArrowDown" ? 1 : -1);
      active = next < -1 ? matches.length - 1 : next >= matches.length ? -1 : next;
    } else if (e.key === "Enter" && showList && active >= 0) {
      e.preventDefault();
      void add(matches[active]!.tag);
    } else if (e.key === "Escape" && showList) {
      e.preventDefault();
      open = false;
    }
  }

  /** Changed data other views show (the filter's tags, the tables): they load again. */
  const changed = () => store.refreshTick++;

  async function add(picked?: string) {
    const value = (picked ?? input).trim();
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
      <form class="flex items-center gap-2" onsubmit={(e) => { e.preventDefault(); void add(); }}>
        <div class="relative min-w-0 flex-1">
          <input
            class="input w-full"
            bind:value={input}
            maxlength={MAX_TAG}
            autocomplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
            aria-label={t("tags.input")}
            placeholder={t("tags.input")}
            onfocus={() => (open = true)}
            oninput={() => (open = true)}
            onblur={() => (open = false)}
            onkeydown={onKey}
          />
          {#if showList}
            <ul id={listId} role="listbox" class="popover right-0 left-0 max-h-64 overflow-auto">
              {#each matches as m, i (m.tag)}
                <!-- Pressed, not clicked: a click would blur the input and close the list first. -->
                <li
                  id="{listId}-{i}"
                  role="option"
                  aria-selected={i === active}
                  class="popover-item justify-between {i === active ? 'bg-popover-hover text-ink' : ''}"
                  onmousedown={(e) => { e.preventDefault(); void add(m.tag); }}
                  onmouseenter={() => (active = i)}
                >
                  <span class="truncate">{m.tag}</span>
                  <span class="shrink-0 text-xs text-muted tabular">{t("common.sessionsN", { n: m.sessions })}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        <button type="submit" class="btn btn-primary shrink-0" disabled={busy || !input.trim()}><Plus size={14} />{t("tags.add")}</button>
      </form>
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
      {#if tagError}<p class="text-xs text-bad" role="alert">{t("tags.failed")}</p>{/if}
    </div>
  </Card>

  <Card title={t("tags.note")} subtitle={t("tags.noteHint")}>
    <div class="flex flex-col gap-3">
      <textarea
        class="input !h-auto min-h-24 w-full resize-none py-2 leading-relaxed"
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
