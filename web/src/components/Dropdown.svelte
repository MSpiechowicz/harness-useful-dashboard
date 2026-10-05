<script lang="ts" generics="V extends string">
  import { Check, ChevronDown, Search } from "@lucide/svelte";
  import { tick } from "svelte";
  import { t } from "../lib/i18n.svelte.ts";

  interface Option {
    value: V;
    label: string;
  }
  interface Props {
    value: V;
    options: Option[];
    /** Accessible name; shown before the value when `prefix` is set. */
    label: string;
    prefix?: boolean;
    /** Highlights the trigger, e.g. for an applied filter. */
    active?: boolean;
    /** Lists at least this long get a search box. */
    searchAt?: number;
    class?: string;
    onchange?: (value: V) => void;
    /** Share the row's free space equally with the other stretched dropdowns (a group of filters), up to 11rem. */
    stretch?: boolean;
    /** Fill the width of its container, like the other controls of a form. */
    full?: boolean;
    /** Open above the trigger, for a control at the bottom of the screen (the sidebar's footer). */
    up?: boolean;
    /** With `prefix`, an empty value (no filter) shows just the label, not "Label: All": it fits in every language. */
    labelWhenEmpty?: boolean;
  }
  let { value = $bindable(), options, label, prefix = false, active = false, searchAt = 9, class: cls = "", onchange, stretch = false, full = false, up = false, labelWhenEmpty = false }: Props = $props();

  let open = $state(false);
  let query = $state("");
  let alignRight = $state(false);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();

  const selected = $derived(options.find((o) => o.value === value));
  const searchable = $derived(options.length >= searchAt);

  // Long lists (the filters) share the free space of their row equally, up to their longest option (capped, a
  // longer name is truncated and the tooltip carries it whole). Their width depends on the room they have, never
  // on the value chosen, so choosing one doesn't shift the controls beside them.
  const MAX_WIDTH = 208;
  let width = $state<number | null>(null);
  let canvas: HTMLCanvasElement | undefined;
  function measure() {
    if (stretch || full || !searchable || !trigger) return;
    const css = getComputedStyle(trigger);
    const ctx = (canvas ??= document.createElement("canvas")).getContext("2d");
    if (!ctx) return;
    ctx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    const text = Math.max(...options.map((o) => ctx.measureText(o.label).width)) + (prefix ? ctx.measureText(`${label}: `).width : 0);
    // Padding, borders, the chevron and the gap before it.
    const chrome = parseFloat(css.paddingLeft) + parseFloat(css.paddingRight) + parseFloat(css.borderLeftWidth) * 2 + 14 + parseFloat(css.columnGap || "0");
    width = Math.min(MAX_WIDTH, Math.ceil(text + chrome + 1));
  }
  $effect(() => {
    void options;
    void label;
    measure();
    // Measure again once the web font is in, in case it wasn't at first.
    document.fonts?.ready.then(measure);
  });
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
  });

  function items(): HTMLButtonElement[] {
    return [...(list?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
  }

  async function show() {
    // Open toward the left when the popover would run off the right edge.
    alignRight = trigger.getBoundingClientRect().left + 288 > window.innerWidth - 8;
    query = "";
    open = true;
    await tick();
    if (search) search.focus();
    else (items().find((b) => b.getAttribute("aria-selected") === "true") ?? items()[0])?.focus();
  }

  function hide(refocus = false) {
    open = false;
    if (refocus) trigger.focus();
  }

  function choose(v: V) {
    value = v;
    onchange?.(v);
    hide(true);
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show();
    }
  }

  function onListKey(e: KeyboardEvent) {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = all[Math.min(all.length - 1, i + 1)];
    else if (e.key === "ArrowUp") next = i <= 0 && search ? undefined : all[Math.max(0, i - 1)];
    else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    else return;
    e.preventDefault();
    if (next) next.focus();
    else search?.focus();
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items()[0]?.focus();
    } else if (e.key === "Enter" && shown[0]) {
      e.preventDefault();
      choose(shown[0].value);
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (open && !root.contains(e.target as Node)) hide();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") hide(true);
    // Tab leaves the popover the native way: let focus move on, just close.
    else if (e.key === "Tab") hide();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div
  class="relative min-w-0 {full ? 'w-full' : stretch ? 'max-w-44 min-w-[7.5rem] flex-1 basis-0' : width ? 'min-w-[7.5rem] flex-1' : ''}"
  bind:this={root}
  style:max-width={!stretch && width ? `${width}px` : undefined}
>
  <button
    bind:this={trigger}
    type="button"
    class="btn w-full justify-between {active ? '!border-accent/60 !bg-accent-wash' : ''} {cls}"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={prefix ? undefined : label}
    title={prefix ? `${label}: ${selected?.label ?? value}` : undefined}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKey}
  >
    <span class="min-w-0 truncate">
      {#if prefix && labelWhenEmpty && value === ""}<span class="text-ink-2">{label}</span>
      {:else}
      {#if prefix}<span class="text-muted">{label}:</span>{/if}
      {#if !searchable && !stretch && selected}
        <!-- Short lists stack every option in one cell, only the chosen one visible: the button keeps the widest
             option's width, so picking another never shifts the controls beside it. Long lists and stretched
             dropdowns get their width from the layout instead. -->
        <span class="inline-grid align-bottom">
          {#each options as o (o.value)}
            <span class="[grid-area:1/1] text-left {o.value !== value ? 'invisible' : active ? 'text-accent-ink' : ''}" aria-hidden={o.value !== value}>{o.label}</span>
          {/each}
        </span>
      {:else}
        <span class={active ? "text-accent-ink" : ""}>{selected?.label ?? value}</span>
      {/if}
      {/if}
    </span>
    <ChevronDown size={14} class="shrink-0 text-muted transition-transform {open ? 'rotate-180' : ''}" />
  </button>
  {#if open}
    <div class="popover w-max max-w-72 min-w-full {alignRight ? 'right-0' : 'left-0'} {up ? 'bottom-full !mt-0 mb-1' : ''}">
      {#if searchable}
        <div class="relative mb-1">
          <Search size={13} class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            bind:this={search}
            bind:value={query}
            class="input h-8 w-full !border-transparent !bg-transparent pl-7 !outline-none"
            placeholder={t("filter.search")}
            aria-label={t("filter.search")}
            onkeydown={onSearchKey}
          />
        </div>
        <div class="-mx-1 mb-1 border-t border-line"></div>
      {/if}
      <div bind:this={list} class="max-h-72 overflow-y-auto" role="listbox" aria-label={label} tabindex="-1" onkeydown={onListKey}>
        {#each shown as o (o.value)}
          <button type="button" role="option" aria-selected={o.value === value} class="popover-item" title={o.label} onclick={() => choose(o.value)}>
            <span class="min-w-0 flex-1 truncate">{o.label}</span>
            <Check size={14} strokeWidth={2.5} class="shrink-0 text-accent {o.value === value ? '' : 'invisible'}" />
          </button>
        {:else}
          <div class="px-2.5 py-2 text-xs text-muted">{t("filter.noMatches")}</div>
        {/each}
      </div>
    </div>
  {/if}
</div>
