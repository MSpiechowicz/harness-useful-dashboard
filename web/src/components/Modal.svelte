<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import { TriangleAlert, X } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";

  /**
   * A native modal dialog: focus stays inside, Escape, the close button or a click on the backdrop closes it, and focus
   * goes back to what opened it. It starts on the element in it marked `data-autofocus`. While `busy` it can't be closed.
   * `error` shows under the text, `item` shows what the dialog is about, ruled off between the text and the buttons.
   */
  interface Props {
    title: string;
    body: string;
    busy?: boolean;
    error?: string | null;
    onclose: () => void;
    item?: Snippet;
    footer: Snippet;
  }
  let { title, body, busy = false, error = null, onclose, item, footer }: Props = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement>();

  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The page behind doesn't scroll while the dialog is open.
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-autofocus]")?.focus();

    return () => {
      document.documentElement.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  });

  // Escape is the dialog's own "cancel" event. Not while a request runs, and not also the drawer behind it.
  function onCancelEvent(e: Event) {
    e.preventDefault();
    if (!busy) onclose();
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget && !busy) onclose();
  }
</script>

<!-- The backdrop is for the pointer: keyboard users close it with Escape. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<dialog
  bind:this={dialog}
  class="card glass m-auto w-full max-w-md p-0 text-ink !shadow-[var(--shadow-pop)] backdrop:bg-scrim backdrop:[backdrop-filter:var(--scrim-filter)]"
  aria-labelledby="{uid}-title"
  aria-describedby="{uid}-body"
  oncancel={onCancelEvent}
  onclick={onBackdrop}
>
  <div class="px-6 pt-5 pb-5">
    <div class="flex items-start justify-between gap-4">
      <h2 id="{uid}-title" class="text-lg font-semibold text-ink">{title}</h2>
      <button type="button" class="-mr-1.5 -mt-0.5 rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink disabled:opacity-50" aria-label={t("common.close")} disabled={busy} onclick={onclose}><X size={16} /></button>
    </div>
    <p id="{uid}-body" class="mt-1.5 text-sm leading-relaxed text-ink-2">{body}</p>
    <div class="flex items-start gap-1.5 text-xs text-bad empty:hidden" class:mt-2={!!error} role="alert">
      {#if error}<TriangleAlert size={12} class="mt-0.5 shrink-0" /><span class="min-w-0 break-words">{error}</span>{/if}
    </div>
  </div>
  {#if item}
    <div class="border-t border-line px-6 py-4">{@render item()}</div>
  {/if}
  <div class="flex items-center justify-end gap-2 border-t border-line px-6 py-4">{@render footer()}</div>
</dialog>
