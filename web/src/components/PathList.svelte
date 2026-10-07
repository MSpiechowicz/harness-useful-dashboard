<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
  import FolderField from "./FolderField.svelte";
  import { t } from "../lib/i18n.svelte.ts";

  /** A list of folders, one input each with a Browse button, with a button to add another and one to remove each. There is always one row. */
  let { paths = $bindable([""]), disabled = false, placeholder = "" }: { paths?: string[]; disabled?: boolean; placeholder?: string } = $props();

  function remove(i: number) {
    paths = paths.length > 1 ? paths.filter((_, j) => j !== i) : [""];
  }
</script>

<div class="flex w-full min-w-0 flex-col gap-2">
  {#each paths as _, i (i)}
    <div class="flex min-w-0 items-center gap-2">
      <FolderField iconOnly class="font-mono text-xs" bind:value={paths[i]} {placeholder} {disabled} label={t("folder.path")} />
      <button class="btn !w-8 shrink-0 justify-center !px-0" aria-label={t("common.remove")} title={t("common.remove")} onclick={() => remove(i)} {disabled}><X size={14} /></button>
    </div>
  {/each}
  <button class="btn w-fit !h-7 !px-2 !text-xs text-ink-2" onclick={() => (paths = [...paths, ""])} {disabled}><Plus size={13} />{t("settings.addFolder")}</button>
</div>
