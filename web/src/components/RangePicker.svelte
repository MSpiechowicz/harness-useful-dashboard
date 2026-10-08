<script lang="ts">
  import { Calendar, Check, ChevronDown } from "@lucide/svelte";
  import { tick } from "svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import { store, type RangePreset } from "../lib/state.svelte.ts";

  const presets: RangePreset[] = ["today", "7d", "30d", "90d", "month", "all"];
  let open = $state(false);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let presetList = $state<HTMLDivElement>();
  let from = $state(store.customFrom);
  let to = $state(store.customTo);

  const label = $derived(
    store.range === "custom" ? `${store.customFrom || "…"} – ${store.customTo || "…"}` : t(`range.${store.range}` as "range.7d"),
  );

  function presetButtons(): HTMLButtonElement[] {
    return [...(presetList?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  }

  // Like Dropdown: opening focuses the chosen range, the arrows move between ranges, Escape returns to the trigger.
  async function show() {
    open = true;
    await tick();
    (presetButtons().find((b) => b.getAttribute("aria-pressed") === "true") ?? presetButtons()[0])?.focus();
  }

  function hide(refocus = false) {
    open = false;
    if (refocus) trigger.focus();
  }

  function choose(p: RangePreset) {
    store.setRange(p);
    hide(true);
  }

  function applyCustom() {
    store.customFrom = from;
    store.customTo = to;
    store.setRange("custom");
    hide(true);
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show();
    }
  }

  function onPresetKey(e: KeyboardEvent) {
    const all = presetButtons();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = all[Math.min(all.length - 1, i + 1)];
    else if (e.key === "ArrowUp") next = all[Math.max(0, i - 1)];
    else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    else return;
    e.preventDefault();
    next?.focus();
  }

  function onWindowClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) hide();
  }

  // Tab moves on through the dates and Apply. Once focus leaves the picker, it closes.
  function onFocusOut(e: FocusEvent) {
    if (open && !root.contains(e.relatedTarget as Node | null)) hide();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => open && e.key === "Escape" && hide(true)} />

<div class="relative" bind:this={root} onfocusout={onFocusOut}>
  <button bind:this={trigger} class="btn" aria-haspopup="dialog" aria-expanded={open} onclick={() => (open ? hide() : show())} onkeydown={onTriggerKey}>
    <!-- Left out on a phone, so the range, the filters and Cost/Tokens fit one line at 375 px. --><Calendar size={14} class="hidden text-muted sm:block" />
    <span>{label}</span>
    <ChevronDown size={14} class="text-muted transition-transform {open ? 'rotate-180' : ''}" />
  </button>
  {#if open}
    <div class="popover left-0 w-64" role="dialog" aria-label={t("range.label")}>
      <!-- The arrow keys come from the range buttons inside. -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div bind:this={presetList} role="group" aria-label={t("range.label")} onkeydown={onPresetKey}>
        {#each presets as p (p)}
          <button type="button" aria-pressed={store.range === p} class="popover-item" onclick={() => choose(p)}>
            <span class="flex-1">{t(`range.${p}` as "range.7d")}</span>
            <Check size={14} strokeWidth={2.5} class="shrink-0 text-accent {store.range === p ? '' : 'invisible'}" />
          </button>
        {/each}
      </div>
      <div class="-mx-1 mt-1 border-t border-line px-3.5 pt-2 pb-2">
        <div class="mb-2 text-xs font-medium text-muted">{t("range.custom")}</div>
        <div class="flex flex-col gap-2">
          <label class="flex items-center justify-between gap-2 text-xs text-ink-2">
            {t("range.from")}<input type="date" class="input w-36" bind:value={from} />
          </label>
          <label class="flex items-center justify-between gap-2 text-xs text-ink-2">
            {t("range.to")}<input type="date" class="input w-36" bind:value={to} />
          </label>
          <button type="button" class="btn btn-primary justify-center" onclick={applyCustom} disabled={!from && !to}>{t("range.apply")}</button>
        </div>
      </div>
    </div>
  {/if}
</div>
