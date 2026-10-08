<script lang="ts">
  import { Search } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";

  let { value = $bindable(""), placeholder }: { value?: string; placeholder?: string } = $props();
  let input: HTMLInputElement;
  let focused = $state(false);
  // Open while it has focus or holds a search, so a filter is never hidden.
  const open = $derived(focused || value.trim() !== "");
</script>

<!-- An icon until it is clicked or tabbed to: then the field opens to the left, and folds back when it loses focus. -->
<label class="search-fold" class:open>
  <input
    bind:this={input}
    class="input"
    type="search"
    placeholder={placeholder ?? t("filter.search")}
    aria-label={placeholder ?? t("filter.search")}
    bind:value
    onfocus={() => (focused = true)}
    onblur={() => (focused = false)}
    onkeydown={(e) => {
      if (e.key === "Escape" && !value) input.blur();
    }}
  />
  <Search size={14} class="search-icon" />
</label>
