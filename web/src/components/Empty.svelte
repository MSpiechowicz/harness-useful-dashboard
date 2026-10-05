<script lang="ts">
  import { Inbox } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";

  let { title, body, compact = false }: { title?: string; body?: string; compact?: boolean } = $props();
</script>

<div class="flex flex-col items-center justify-center text-center {compact ? 'py-8' : 'py-16'}">
  <div class="mb-3 rounded-full bg-surface-2 p-3 text-muted"><Inbox size={compact ? 18 : 24} /></div>
  <div class="text-sm font-medium text-ink">{title ?? t("empty.title")}</div>
  {#if !compact}<p class="mt-1 max-w-md text-sm text-muted">{body ?? t("empty.body")}</p>{/if}
</div>
