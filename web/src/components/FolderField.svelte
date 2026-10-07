<script module lang="ts">
  import { getJson } from "../lib/api.svelte.ts";

  // Whether this machine has a native folder dialog: asked once.
  let native: Promise<boolean> | undefined;
  const hasNative = () => (native ??= getJson<{ native: boolean }>("/api/pick-folder/available").then((r) => r.native, () => false));
</script>

<script lang="ts">
  import { FolderOpen } from "@lucide/svelte";
  import { send } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import FolderDialog from "./FolderDialog.svelte";
  import Spinner from "./Spinner.svelte";

  /**
   * A folder path you can type, with a Browse button: the system's folder dialog when this machine has one (the server
   * opens it on this desktop and answers with the path), else a folder browser in the app. The input keeps its own
   * look, so `class` and the rest go to it. `iconOnly` shrinks the button to its icon for tight rows.
   */
  let {
    value = $bindable(""),
    disabled = false,
    label,
    placeholder = "",
    iconOnly = false,
    class: cls = "",
  }: { value?: string; disabled?: boolean; label: string; placeholder?: string; iconOnly?: boolean; class?: string } = $props();

  let waiting = $state(false);
  let browsing = $state(false);

  async function browse() {
    if (waiting) return;
    waiting = true;
    try {
      if (await hasNative()) {
        // The request waits for as long as the dialog is open. Cancelled: no path, and the field stays as it was.
        const r = await send<{ path: string | null }>("/api/pick-folder", { start: value.trim(), title: t("folder.pickTitle") });
        if (r.path) value = r.path;
      } else browsing = true;
    } catch {
      // The dialog couldn't open (or one is open already): the in-app browser still can.
      browsing = true;
    } finally {
      waiting = false;
    }
  }
</script>

<div class="flex w-full min-w-0 items-center gap-2">
  <input class="input min-w-0 flex-1 {cls}" bind:value {placeholder} {disabled} aria-label={label} spellcheck="false" autocomplete="off" />
  <button class="btn shrink-0 {iconOnly ? '!w-8 justify-center !px-0' : ''}" aria-label={iconOnly ? t("folder.browse") : undefined} title={t("folder.browse")} onclick={browse} disabled={disabled || waiting}>
    {#if waiting}<Spinner size={14} />{:else}<FolderOpen size={14} />{/if}{#if !iconOnly}{t("folder.browse")}{/if}
  </button>
</div>

{#if browsing}
  <FolderDialog
    start={value.trim()}
    onclose={() => (browsing = false)}
    onchoose={(p) => {
      value = p;
      browsing = false;
    }}
  />
{/if}
