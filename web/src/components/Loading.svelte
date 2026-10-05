<script lang="ts">
  import { t } from "../lib/i18n.svelte.ts";
  import Spinner from "./Spinner.svelte";

  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="flex items-center justify-center gap-2.5 text-sm text-muted {compact ? 'py-8' : 'py-16'}" role="status">
  <span class="text-accent"><Spinner size={18} /></span>
  {t("common.loading")}
</div>
