<script lang="ts">
  import { Monitor, Moon, Sun } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type ThemePref } from "../lib/state.svelte.ts";

  const options: { value: ThemePref; icon: typeof Sun }[] = [
    { value: "system", icon: Monitor },
    { value: "light", icon: Sun },
    { value: "dark", icon: Moon },
  ];

  /** `wide` fills a form column and names each choice beside its icon. */
  let { wide = false }: { wide?: boolean } = $props();
</script>

<div class="seg" class:wide role="radiogroup" aria-label={t("settings.theme")}>
  {#each options as o (o.value)}
    <button
      role="radio"
      aria-checked={store.theme === o.value}
      title={t(`settings.theme.${o.value}` as "settings.theme.system")}
      aria-label={t(`settings.theme.${o.value}` as "settings.theme.system")}
      onclick={() => store.setTheme(o.value)}
    >
      <o.icon size={13} />
      {#if wide}{t(`settings.theme.${o.value}` as "settings.theme.system")}{/if}
    </button>
  {/each}
</div>
