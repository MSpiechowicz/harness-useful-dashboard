<script lang="ts">
  import { TriangleAlert } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { live } from "../lib/live.svelte.ts";
</script>

<!-- The database was upgraded by a newer version of the app, so this one only reads it. The condition lasts until the app
     is updated, so the notice can't be dismissed. It sits in the flow above the page, not over it. -->
{#if live.status?.readOnly === "newer-schema"}
  <div role="status" class="border-b border-line bg-surface-2">
    <div class="mx-auto flex max-w-[1500px] items-start gap-2.5 px-4 py-2.5 text-xs sm:px-6">
      <TriangleAlert size={14} class="mt-px shrink-0 text-warn" />
      <div class="min-w-0">
        <div class="font-medium text-ink">{t("readonly.title")}</div>
        <div class="mt-0.5 text-ink-2">{t("readonly.body")}</div>
      </div>
    </div>
  </div>
{/if}
