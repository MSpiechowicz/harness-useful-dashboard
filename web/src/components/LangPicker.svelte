<script lang="ts">
  import { i18n, LANGS, t, type Lang } from "../lib/i18n.svelte.ts";
  import Dropdown from "./Dropdown.svelte";

  /**
   * The language, each named in its own language. `wide` fills a form column (Settings), `up` opens the list above
   * the control, for the sidebar's footer.
   */
  let { wide = false, up = false }: { wide?: boolean; up?: boolean } = $props();
</script>

<Dropdown
  label={t("settings.language")}
  value={i18n.lang}
  options={LANGS.map((l) => ({ value: l.code, label: l.label }))}
  onchange={(v: Lang) => i18n.set(v)}
  full={wide}
  {up}
/>
