<script lang="ts">
  import { onMount } from "svelte";
  import { Keyboard, X } from "@lucide/svelte";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import { formatShortcut, GLOBAL_SHORTCUTS, isMacPlatform, pageCombos, type ShortcutAction } from "../lib/shortcuts.ts";

  /**
   * The list of keyboard shortcuts, as a native modal dialog: focus stays inside, Escape, the close button or a click on
   * the backdrop closes it, and focus goes back to what opened it. Mounted only while open.
   */
  interface Props {
    /** The pages of the menu, in its order: each with a key is listed under "Go to". */
    pages: { page: string; label: MessageKey }[];
    onclose: () => void;
  }
  let { pages, onclose }: Props = $props();

  const uid = $props.id();
  const mac = isMacPlatform(navigator.platform || navigator.userAgent);
  let dialog = $state<HTMLDialogElement>();

  /** `or` when each key does the job alone, `and` when the keys belong together (↑ ↓). */
  interface Row {
    label: string;
    combos: string[];
    joiner?: "or" | "and";
  }
  interface Group {
    id: string;
    title: string;
    rows: Row[];
  }

  const globalCombos = (action: ShortcutAction) => GLOBAL_SHORTCUTS.find((s) => s.action === action)?.combos ?? [];
  const groups = $derived.by<Group[]>(() => {
    const combos = pageCombos(pages.map((p) => p.page));
    return [
      {
        id: "global",
        title: t("shortcuts.group.global"),
        rows: [
          { label: t("palette.key.palette"), combos: globalCombos("palette") },
          { label: t("palette.key.help"), combos: globalCombos("shortcuts") },
          { label: t("palette.key.search"), combos: globalCombos("search") },
          { label: t("shortcuts.sidebar"), combos: globalCombos("sidebar") },
          { label: t("shortcuts.back"), combos: globalCombos("back") },
          { label: t("shortcuts.forward"), combos: globalCombos("forward") },
        ],
      },
      {
        id: "goto",
        title: t("shortcuts.group.goTo"),
        rows: pages.flatMap((p) => {
          const combo = combos.get(p.page);
          return combo ? [{ label: t(p.label), combos: [combo] }] : [];
        }),
      },
      {
        id: "palette",
        title: t("palette.label"),
        rows: [
          { label: t("palette.key.move"), combos: ["arrowup", "arrowdown"], joiner: "and" },
          { label: t("palette.key.choose"), combos: ["enter"] },
          { label: t("palette.key.close"), combos: ["escape"] },
        ],
      },
      {
        id: "lists",
        title: t("shortcuts.group.lists"),
        rows: [
          { label: t("shortcuts.lists.move"), combos: ["arrowup", "arrowdown"], joiner: "and" },
          { label: t("shortcuts.lists.jump"), combos: ["home", "end"], joiner: "and" },
          { label: t("shortcuts.lists.close"), combos: ["escape"] },
        ],
      },
    ];
  });

  // The hint holds a key cap in the middle of a sentence: split around a marker the cap replaces.
  const KEYS_MARK = "\u0000";
  const hint = $derived(t("shortcuts.hint", { keys: KEYS_MARK }).split(KEYS_MARK));

  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The page behind doesn't scroll while the dialog is open.
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    dialog?.showModal();

    return () => {
      document.documentElement.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  });

  // Escape is the dialog's own "cancel" event.
  function onCancelEvent(e: Event) {
    e.preventDefault();
    onclose();
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<!-- One key cap. The same size for every cap of a list: square for a single glyph, wider for a word. -->
{#snippet cap(label: string, even: boolean)}
  <kbd
    class="inline-flex h-6 items-center justify-center rounded-md border border-line-strong bg-surface-2 font-sans text-[11px] leading-none font-medium text-ink-2 shadow-[var(--control-shadow)] {even ? (label.length === 1 ? 'w-6' : 'w-12') : 'mx-0.5 min-w-6 px-1.5 align-middle'}"
    aria-hidden="true">{label}</kbd
  >
{/snippet}

<!-- The backdrop is for the pointer: keyboard users close it with Escape. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<dialog
  bind:this={dialog}
  class="card glass m-auto w-full max-w-[min(56rem,calc(100%-2rem))] max-h-[85vh] flex-col overflow-hidden p-0 text-ink open:flex !shadow-[var(--shadow-pop)] backdrop:bg-scrim backdrop:[backdrop-filter:var(--scrim-filter)]"
  aria-labelledby="{uid}-title"
  oncancel={onCancelEvent}
  onclick={onBackdrop}
>
  <header class="flex items-start gap-3 border-b border-line px-6 py-4">
    <span class="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-accent shadow-[var(--control-shadow)]">
      <Keyboard size={16} aria-hidden="true" />
    </span>
    <div class="flex min-w-0 flex-1 flex-col">
      <h2 id="{uid}-title" class="text-lg font-semibold text-ink">{t("palette.shortcuts")}</h2>
      <p class="mt-0.5 text-sm text-ink-2">{hint[0]}{@render cap("?", false)}{hint[1]}</p>
    </div>
    <button type="button" class="-mt-0.5 -mr-1.5 shrink-0 rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink" aria-label={t("common.close")} title={t("common.close")} onclick={onclose}><X size={16} /></button>
  </header>

  <div class="grid grid-cols-1 gap-x-10 gap-y-7 overflow-y-auto px-6 pt-6 pb-4 md:grid-cols-2">
    {#each groups as group (group.id)}
      <section aria-labelledby="{uid}-{group.id}" class="flex flex-col gap-1">
        <h3 id="{uid}-{group.id}" class="pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{group.title}</h3>
        <ul class="flex flex-col">
          {#each group.rows as row (row.label)}
            <li class="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 transition-colors hover:bg-hover">
              <span class="text-sm text-ink-2">{row.label}</span>
              <span class="flex shrink-0 items-center gap-1.5">
                {#each row.combos as combo, ci (combo)}
                  {#if ci > 0 && row.joiner !== "and"}<span class="text-xs text-muted">{t("shortcuts.or")}</span>{/if}
                  <span class="flex items-center gap-1" aria-label={formatShortcut(combo, mac).join(" ")}>
                    {#each formatShortcut(combo, mac) as label (label)}{@render cap(label, true)}{/each}
                  </span>
                {/each}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  </div>
</dialog>
