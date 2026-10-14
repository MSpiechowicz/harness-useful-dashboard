<script lang="ts">
  import type { Snippet } from "svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import Modal from "./Modal.svelte";

  /**
   * Asks before a destructive change (see Modal.svelte for how it opens and closes). It starts on the cancel button, so
   * the destructive one is never the default. While `busy` neither button works. A failed `onconfirm` can pass `error`.
   */
  interface Props {
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel?: string;
    item?: Snippet;
    busy?: boolean;
    error?: string | null;
    onconfirm: () => void;
    oncancel: () => void;
  }
  let { title, body, confirmLabel, cancelLabel, item, busy = false, error = null, onconfirm, oncancel }: Props = $props();

  let cancelButton = $state<HTMLButtonElement>();

  // A disabled button drops focus: after a failed request it goes back to the cancel button.
  $effect(() => {
    if (!busy && error) cancelButton?.focus();
  });
</script>

<Modal {title} {body} {busy} {error} {item} onclose={oncancel}>
  {#snippet footer()}
    <button bind:this={cancelButton} data-autofocus type="button" class="btn !border-transparent !bg-transparent hover:!bg-hover" disabled={busy} onclick={oncancel}>{cancelLabel ?? t("common.cancel")}</button>
    <button type="button" class="btn btn-danger" disabled={busy} onclick={onconfirm}>{confirmLabel}</button>
  {/snippet}
</Modal>
