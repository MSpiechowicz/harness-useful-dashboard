<script lang="ts">
  import { Download, Loader } from "@lucide/svelte";
  import { getJson, send, type UpdateStatus } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";

  let status = $state<UpdateStatus | null>(null);
  let busy = $state(false);
  let message = $state<string | null>(null);

  $effect(() => {
    getJson<UpdateStatus>("/api/update").then((s) => (status = s)).catch(() => {});
  });

  async function install() {
    busy = true;
    message = null;
    try {
      const r = await send<{ restarting: boolean }>("/api/update");
      if (r.restarting) message = t("update.restarting");
    } catch (e) {
      message = t("update.failed", { error: (e as Error).message });
      busy = false;
    }
  }
</script>

{#if status?.available}
  <div class="rounded-lg border border-line bg-accent-wash px-3 py-2.5 text-xs">
    <div class="font-medium text-ink">{t("update.available", { v: status.latest })}</div>
    {#if message}
      <div class="mt-1 text-ink-2">{message}</div>
    {:else}
      <div class="mt-2 flex gap-2">
        {#if status.canSelfUpdate}
          <button class="btn btn-primary !h-7 !text-xs" onclick={install} disabled={busy}>
            {#if busy}<Loader size={13} class="animate-spin" />{t("update.installing")}{:else}<Download size={13} />{t("update.install")}{/if}
          </button>
        {:else if status.releaseUrl}
          <a class="btn !h-7 !text-xs" href={status.releaseUrl} target="_blank" rel="noreferrer"><Download size={13} />{t("update.manual")}</a>
        {/if}
      </div>
    {/if}
  </div>
{/if}
