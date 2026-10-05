<script lang="ts">
  import { i18n, LANGS, t } from "../lib/i18n.svelte.ts";

  /** `wide` fills a form column and names each language in full. */
  let { wide = false }: { wide?: boolean } = $props();
</script>

<div class="flex items-center" class:w-full={wide}>
  <div class="seg" class:wide role="radiogroup" aria-label={t("settings.language")}>
    {#each LANGS as l (l.code)}
      <button
        role="radio"
        aria-checked={i18n.lang === l.code}
        title={l.label}
        onclick={() => i18n.set(l.code)}
      >
        {wide ? l.label : l.code.toUpperCase()}
      </button>
    {/each}
  </div>
</div>
