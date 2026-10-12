<script lang="ts">
  import { Download, Loader } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { isShell } from "../lib/shell.ts";
  import { downloadFraction, installText, installUpdate, updater, watchUpdates } from "../lib/update.svelte.ts";

  watchUpdates();
  const status = $derived(updater.status);
  const fraction = $derived(downloadFraction());
</script>

<!-- A waiting update is easy to miss in the corner: the arrow on the button (or on the download link, in a browser,
     where the app can't update itself) bobs, until it is installing. Still for whoever asked for less motion. -->
{#if status?.available}
  <div class="rounded-lg border border-line bg-accent-wash px-3 py-2.5 text-xs">
    <div class="font-medium text-ink">{t("update.available", { v: status.latest })}</div>
    {#if updater.message}
      <div class="mt-1 text-ink-2">{updater.message}</div>
    {/if}
    {#if updater.installing && !updater.message}
      <div class="mt-1 flex items-center gap-1.5 text-ink-2" role="status"><Loader size={13} class="animate-spin" />{installText()}</div>
      {#if fraction !== null}
        <div class="mt-2 h-1 overflow-hidden rounded-full bg-surface-3"><div class="h-full rounded-full bg-accent" style:width="{fraction * 100}%"></div></div>
      {/if}
    {:else if !updater.installing}
      <div class="mt-2 flex gap-2">
        {#if isShell()}
          <button class="btn btn-primary !h-7 !text-xs" onclick={installUpdate}><span class="update-arrow"><Download size={13} /></span>{t("update.install")}</button>
        {:else if status.releaseUrl}
          <a class="btn !h-7 !text-xs" href={status.releaseUrl} target="_blank" rel="noreferrer"><span class="update-arrow"><Download size={13} /></span>{t("update.manual")}</a>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .update-arrow {
    display: inline-flex;
    animation: update-bob 1.8s ease-in-out infinite;
  }
  @keyframes update-bob {
    0%,
    100% {
      transform: translateY(-1px);
    }
    50% {
      transform: translateY(1.5px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .update-arrow {
      animation: none;
    }
  }
</style>
