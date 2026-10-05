<script lang="ts">
  import { Search } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";

  let { value = $bindable(""), placeholder }: { value?: string; placeholder?: string } = $props();
</script>

<label class="relative">
  <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
  <input class="input w-56 pl-8" type="search" placeholder={placeholder ?? t("filter.search")} aria-label={placeholder ?? t("filter.search")} bind:value />
</label>
