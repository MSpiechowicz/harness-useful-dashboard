<script lang="ts">
  import { t } from "../lib/i18n.svelte.ts";

  /** Marks usage whose input counts only the last model call of each request (Copilot Chat before VS Code is connected). */
</script>

<span class="shrink-0 rounded bg-surface-2 px-1.5 text-[10px] text-muted" title={t("common.partialHint")}>{t("common.partial")}</span>
