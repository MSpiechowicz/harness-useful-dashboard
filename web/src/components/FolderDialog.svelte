<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowUp, Folder, House, TriangleAlert } from "@lucide/svelte";
  import { getJson, qs } from "../lib/api.svelte.ts";
  import { t, type MessageKey } from "../lib/i18n.svelte.ts";
  import Spinner from "./Spinner.svelte";
  import Switch from "./Switch.svelte";

  /**
   * The folder browser for a machine without a native dialog: the folders of the server's own machine, one level at a
   * time, with a path field to type into. A modal dialog like the command palette: focus stays inside, Escape closes.
   */
  interface Listing {
    path: string;
    parent: string | null;
    home: string;
    dirs: { name: string; path: string }[];
    truncated: boolean;
  }
  let { start, onchoose, onclose }: { start: string; onchoose: (path: string) => void; onclose: () => void } = $props();

  const CODES = ["not-found", "not-a-directory", "denied", "not-absolute"];

  let dialog = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();
  let listing = $state<Listing | null>(null);
  let typed = $state("");
  let error = $state<string | null>(null);
  let loading = $state(true);
  let hidden = $state(false);
  // Only the latest answer counts.
  let asked = 0;

  async function load(path: string, first = false) {
    const n = ++asked;
    loading = true;
    try {
      const r = await getJson<Listing>(`/api/dirs${qs({ path, hidden: hidden ? "1" : undefined })}`);
      if (n !== asked) return;
      listing = r;
      typed = r.path;
      error = null;
    } catch (e) {
      if (n !== asked) return;
      // The folder it opens on may be gone: start from home then.
      if (first && path) return load("");
      const code = (e as Error).message;
      error = CODES.includes(code) ? t(`folder.err.${code}` as MessageKey) : code;
      typed = path;
    } finally {
      if (n === asked) loading = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      // Not also the drawer behind it: one Escape closes one thing.
      e.stopPropagation();
      onclose();
    } else if (e.key === "Tab") {
      // Focus stays in the dialog: Tab cycles through what can take it. The folder rows are reached with the arrow keys.
      const all = [...(dialog?.querySelectorAll<HTMLElement>('input, button:not([disabled]):not([tabindex="-1"]), [role="switch"]:not([disabled])') ?? [])];
      if (!all.length) return;
      const i = all.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? all.length - 1 : i - 1) : i >= all.length - 1 ? 0 : i + 1;
      e.preventDefault();
      all[next]!.focus();
    }
  }

  function rows(): HTMLElement[] {
    return [...(dialog?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
  }

  function onRowKey(e: KeyboardEvent, i: number) {
    const all = rows();
    if (e.key === "ArrowDown") all[Math.min(all.length - 1, i + 1)]?.focus();
    else if (e.key === "ArrowUp") (i === 0 ? input : all[i - 1])?.focus();
    else if (e.key === "Home") all[0]?.focus();
    else if (e.key === "End") all[all.length - 1]?.focus();
    else if (e.key === "Backspace" && listing?.parent) void load(listing.parent);
    else return;
    e.preventDefault();
  }

  function onInputKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void load(typed);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rows()[0]?.focus();
    }
  }

  onMount(() => {
    void load(start, true);
    input?.focus();
    // The page behind doesn't scroll while the dialog is open.
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.documentElement.style.overflow = overflow;
    };
  });
</script>

<!-- The backdrop is for the pointer: keyboard users close with Escape. -->
<div
  class="palette-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[10vh]"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    bind:this={dialog}
    class="palette card flex max-h-[min(36rem,80vh)] w-full max-w-xl flex-col overflow-hidden !shadow-[var(--shadow-pop)]"
    role="dialog"
    aria-modal="true"
    aria-label={t("folder.pickTitle")}
    tabindex="-1"
    onkeydown={onKey}
  >
    <div class="border-b border-line px-4 pt-3.5 pb-3">
      <div class="mb-2.5 text-[13px] font-medium text-ink">{t("folder.pickTitle")}</div>
      <div class="flex items-center gap-2">
        <button class="btn !w-8 shrink-0 justify-center !px-0" aria-label={t("folder.up")} title={t("folder.up")} disabled={!listing?.parent} onclick={() => listing?.parent && load(listing.parent)}><ArrowUp size={14} /></button>
        <button class="btn !w-8 shrink-0 justify-center !px-0" aria-label={t("folder.home")} title={t("folder.home")} disabled={!listing} onclick={() => listing && load(listing.home)}><House size={14} /></button>
        <input bind:this={input} bind:value={typed} class="input min-w-0 flex-1 font-mono text-xs" aria-label={t("folder.path")} spellcheck="false" autocomplete="off" onkeydown={onInputKey} />
      </div>
      <div class="mt-2 flex min-h-4 items-start gap-1.5 text-[11px] text-bad" aria-live="polite">
        {#if error}<TriangleAlert size={12} class="mt-px shrink-0" /><span class="min-w-0 break-all">{error}</span>{/if}
      </div>
    </div>

    <div class="relative min-h-40 flex-1 overflow-y-auto p-1.5" aria-busy={loading}>
      {#if listing}
        <ul class="flex flex-col" class:opacity-50={loading}>
          {#each listing.dirs as d, i (d.path)}
            <li>
              <button data-row tabindex="-1" class="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent" onclick={() => load(d.path)} onkeydown={(e) => onRowKey(e, i)}>
                <Folder size={14} class="shrink-0 text-muted" /><span class="min-w-0 truncate">{d.name}</span>
              </button>
            </li>
          {/each}
        </ul>
        {#if !listing.dirs.length}<div class="px-3 py-6 text-center text-xs text-muted">{t("folder.empty")}</div>{/if}
        {#if listing.truncated}<div class="px-3 py-2 text-center text-[11px] text-muted">{t("folder.truncated")}</div>{/if}
      {:else if loading}
        <div class="flex justify-center py-8 text-muted"><Spinner /></div>
      {/if}
    </div>

    <div class="flex items-center gap-3 border-t border-line px-4 py-3">
      <label class="flex min-w-0 items-center gap-2 text-xs text-ink-2">
        <Switch bind:checked={hidden} label={t("folder.hidden")} onchange={() => load(listing?.path ?? typed)} />
        <span class="min-w-0">{t("folder.hidden")}</span>
      </label>
      <span class="flex-1"></span>
      <button class="btn" onclick={onclose}>{t("common.cancel")}</button>
      <button class="btn btn-primary" disabled={!listing || !!error} onclick={() => listing && onchoose(listing.path)}>{t("folder.choose")}</button>
    </div>
  </div>
</div>
