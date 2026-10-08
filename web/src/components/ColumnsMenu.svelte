<script lang="ts">
  import { Check, Columns3 } from "@lucide/svelte";
  import { tick } from "svelte";
  import type { ColumnSet } from "../lib/columns.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";

  /**
   * A card's column control: one icon button opening a list of its table's columns, each ticked while it shows.
   * Unticking hides a column, ticking brings it back, and Show all brings every one back. The button carries a dot
   * while any column is hidden, so a hidden one is never forgotten.
   */
  interface Props {
    sets: ColumnSet[];
    /** The chart cards' size (their table toggle), rather than the table cards' search and sort. */
    small?: boolean;
  }
  let { sets, small = false }: Props = $props();

  let open = $state(false);
  let alignRight = $state(true);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu = $state<HTMLDivElement>();

  const anyHidden = $derived(sets.some((s) => s.hidden.length > 0));
  const items = () => [...(menu?.querySelectorAll<HTMLButtonElement>("[role^=menuitem]") ?? [])];

  async function show() {
    // The menu opens toward the left unless that would run off the left edge.
    alignRight = trigger.getBoundingClientRect().right - 208 > 8;
    open = true;
    await tick();
    items()[0]?.focus();
  }

  function hide(refocus = false) {
    open = false;
    if (refocus) trigger.focus();
  }

  function onMenuKey(e: KeyboardEvent) {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === "ArrowDown") next = all[(i + 1) % all.length];
    else if (e.key === "ArrowUp") next = all[(i - 1 + all.length) % all.length];
    else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    else return;
    e.preventDefault();
    next?.focus();
  }

  function onTriggerKey(e: KeyboardEvent) {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      show();
    }
  }

  function onWindowClick(e: MouseEvent) {
    if (open && !root.contains(e.target as Node)) hide();
  }

  function onWindowKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") hide(true);
    else if (e.key === "Tab") hide();
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

<div class="relative" bind:this={root}>
  <button
    bind:this={trigger}
    type="button"
    class="btn relative justify-center !px-0 {small ? '!h-7 w-7' : 'w-8'}"
    title={t("table.columns")}
    aria-label={anyHidden ? `${t("table.columns")} (${t("table.someHidden")})` : t("table.columns")}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKey}
  >
    <Columns3 size={14} />
    {#if anyHidden}<span class="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent"></span>{/if}
  </button>
  {#if open}
    <div bind:this={menu} class="popover w-52 {alignRight ? 'right-0' : 'left-0'}" role="menu" aria-label={t("table.columns")} tabindex="-1" onkeydown={onMenuKey}>
      {#each sets as set, n (set)}
        {#if n > 0}<div class="my-1 border-t border-line"></div>{/if}
        {#each set.names as name, i (i)}
          {#if set.hideable(i)}
            {@const visible = !set.isHidden(i)}
            <button type="button" role="menuitemcheckbox" aria-checked={visible} class="popover-item" onclick={() => set.show(i, !visible)}>
              <span class="flex w-3.5 shrink-0 justify-center">{#if visible}<Check size={14} />{/if}</span>
              <span class="min-w-0 flex-1 truncate">{name}</span>
            </button>
          {/if}
        {/each}
      {/each}
      {#if anyHidden}
        <div class="my-1 border-t border-line"></div>
        <button type="button" role="menuitem" class="popover-item" onclick={() => sets.forEach((s) => s.showAll())}>
          <span class="w-3.5 shrink-0"></span>
          <span class="min-w-0 flex-1 truncate">{t("table.showAll")}</span>
        </button>
      {/if}
    </div>
  {/if}
</div>
