<script lang="ts">
  import { Calendar, Check, ChevronDown } from "@lucide/svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type RangePreset } from "../lib/state.svelte.ts";

  const presets: RangePreset[] = ["today", "7d", "30d", "90d", "month", "all"];
  let open = $state(false);
  let root: HTMLDivElement;
  let from = $state(store.customFrom);
  let to = $state(store.customTo);

  const label = $derived(
    store.range === "custom" ? `${store.customFrom || "…"} – ${store.customTo || "…"}` : t(`range.${store.range}` as "range.7d"),
  );

  function choose(p: RangePreset) {
    store.setRange(p);
    open = false;
  }

  function applyCustom() {
    store.customFrom = from;
    store.customTo = to;
    store.setRange("custom");
    open = false;
  }

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => e.key === "Escape" && (open = false)} />

<div class="relative" bind:this={root}>
  <button class="btn" aria-haspopup="listbox" aria-expanded={open} onclick={() => (open = !open)}>
    <Calendar size={14} class="text-muted" />
    <span>{label}</span>
    <ChevronDown size={14} class="text-muted transition-transform {open ? 'rotate-180' : ''}" />
  </button>
  {#if open}
    <div class="popover left-0 w-64" role="listbox">
      {#each presets as p (p)}
        <button role="option" aria-selected={store.range === p} class="popover-item" onclick={() => choose(p)}>
          <span class="flex-1">{t(`range.${p}` as "range.7d")}</span>
          <Check size={14} strokeWidth={2.5} class="shrink-0 text-accent {store.range === p ? '' : 'invisible'}" />
        </button>
      {/each}
      <div class="-mx-1 mt-1 border-t border-line px-3.5 pt-2 pb-2">
        <div class="mb-2 text-xs font-medium text-muted">{t("range.custom")}</div>
        <div class="flex flex-col gap-2">
          <label class="flex items-center justify-between gap-2 text-xs text-ink-2">
            {t("range.from")}<input type="date" class="input w-36" bind:value={from} />
          </label>
          <label class="flex items-center justify-between gap-2 text-xs text-ink-2">
            {t("range.to")}<input type="date" class="input w-36" bind:value={to} />
          </label>
          <button class="btn btn-primary justify-center" onclick={applyCustom} disabled={!from && !to}>{t("range.apply")}</button>
        </div>
      </div>
    </div>
  {/if}
</div>
