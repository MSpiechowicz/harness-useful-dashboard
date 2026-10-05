<script lang="ts">
  import { Languages } from "@lucide/svelte";
  import { i18n, LANGS, t } from "../lib/i18n.svelte.ts";
</script>

<div class="flex items-center gap-2">
  <Languages size={15} class="shrink-0 text-muted" aria-hidden="true" />
  <div class="seg" role="radiogroup" aria-label={t("settings.language")}>
    {#each LANGS as l (l.code)}
      <button
        role="radio"
        aria-checked={i18n.lang === l.code}
        title={l.label}
        onclick={() => i18n.set(l.code)}
      >
        {l.code.toUpperCase()}
      </button>
    {/each}
  </div>
</div>
