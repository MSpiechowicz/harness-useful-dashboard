<script module lang="ts">
  import { getJson } from "../lib/api.svelte.ts";

  // Whether this machine has a native folder dialog: asked once.
  let native: Promise<boolean> | undefined;
  const hasNative = () => (native ??= getJson<{ native: boolean }>("/api/pick-folder/available").then((r) => r.native, () => false));
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import { FolderOpen } from "@lucide/svelte";
  import { send } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import FolderDialog from "./FolderDialog.svelte";
  import Spinner from "./Spinner.svelte";

  /**
   * A folder path you can type, with a Browse button: the system's folder dialog when this machine has one (the server
   * opens it on this desktop and answers with the path), else a folder browser in the app. The input keeps its own
   * look, so `class` and the rest go to it. `inline` puts Browse inside the field as an icon, with `actions` (more
   * icons, such as Remove) after it, for a list of folders.
   */
  let {
    value = $bindable(""),
    disabled = false,
    label,
    placeholder = "",
    inline = false,
    actions,
    class: cls = "",
  }: { value?: string; disabled?: boolean; label: string; placeholder?: string; inline?: boolean; actions?: Snippet; class?: string } = $props();

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

{#if inline}
  <div class="input flex w-full items-center gap-0.5 !pr-1" class:opacity-50={disabled}>
    <input class="min-w-0 flex-1 bg-transparent outline-none {cls}" bind:value {placeholder} {disabled} aria-label={label} spellcheck="false" autocomplete="off" />
    <button class="field-btn" aria-label={t("folder.browse")} title={t("folder.browse")} onclick={browse} disabled={disabled || waiting}>
      {#if waiting}<Spinner size={14} />{:else}<FolderOpen size={14} />{/if}
    </button>
    {@render actions?.()}
  </div>
{:else}
  <div class="flex w-full min-w-0 items-center gap-2">
    <input class="input min-w-0 flex-1 {cls}" bind:value {placeholder} {disabled} aria-label={label} spellcheck="false" autocomplete="off" />
    <button class="btn shrink-0" title={t("folder.browse")} onclick={browse} disabled={disabled || waiting}>
      {#if waiting}<Spinner size={14} />{:else}<FolderOpen size={14} />{/if}{t("folder.browse")}
    </button>
  </div>
{/if}

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
