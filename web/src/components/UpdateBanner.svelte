<script lang="ts">
  import { Download, Loader } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { installUpdate, updater, watchUpdates } from "../lib/update.svelte.ts";

  watchUpdates();
  const status = $derived(updater.status);
</script>

{#if status?.available}
  <div class="rounded-lg border border-line bg-accent-wash px-3 py-2.5 text-xs">
    <div class="font-medium text-ink">{t("update.available", { v: status.latest })}</div>
    {#if updater.message}
      <div class="mt-1 text-ink-2">{updater.message}</div>
    {:else}
      <div class="mt-2 flex gap-2">
        {#if status.canSelfUpdate}
          <button class="btn btn-primary !h-7 !text-xs" onclick={installUpdate} disabled={updater.installing}>
            {#if updater.installing}<Loader size={13} class="animate-spin" />{t("update.installing")}{:else}<Download size={13} />{t("update.install")}{/if}
          </button>
        {:else if status.releaseUrl}
          <a class="btn !h-7 !text-xs" href={status.releaseUrl} target="_blank" rel="noreferrer"><Download size={13} />{t("update.manual")}</a>
        {/if}
      </div>
    {/if}
  </div>
{/if}
