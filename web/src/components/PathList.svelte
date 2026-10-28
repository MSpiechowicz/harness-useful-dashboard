<script lang="ts">
  import { Plus, X } from "@lucide/svelte";
  import FolderField from "./FolderField.svelte";
  import { t } from "../lib/i18n.svelte.ts";

  /** A list of folders, one field each with Browse and Remove inside it, with a button to add another. There is always one row. */
  let { paths = $bindable([""]), disabled = false, placeholder = "" }: { paths?: string[]; disabled?: boolean; placeholder?: string } = $props();

  function remove(i: number) {
    paths = paths.length > 1 ? paths.filter((_, j) => j !== i) : [""];
  }
</script>

<div class="flex w-full min-w-0 flex-col gap-2">
  {#each paths as _, i (i)}
    <FolderField inline class="font-mono text-xs" bind:value={paths[i]} {placeholder} {disabled} label={t("folder.path")}>
      {#snippet actions()}
        <button class="field-btn" aria-label={t("common.remove")} title={t("common.remove")} onclick={() => remove(i)} {disabled}><X size={14} /></button>
      {/snippet}
    </FolderField>
  {/each}
  <button class="btn w-fit" onclick={() => (paths = [...paths, ""])} {disabled}><Plus size={14} />{t("settings.addFolder")}</button>
</div>
