<script lang="ts">
  import { Download } from "@lucide/svelte";
  import { tick } from "svelte";
  import { exportFilename, exportText, type ExportFormat } from "../lib/export.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import Spinner from "./Spinner.svelte";

  /**
   * A card's export control: one icon button opening a menu of CSV and JSON. `rows` gives every row the card has
   * under the current filters and search (it may fetch them, for a list the server pages).
   */
  interface Props {
    /** The file's name part, English and stable: `sessions` saves harness-dashboard-sessions-<date>.csv. */
    name: string;
    rows: () => readonly unknown[] | Promise<readonly unknown[]>;
    /** The chart cards' size (their table toggle), rather than the table cards' search and sort. */
    small?: boolean;
  }
  let { name, rows, small = false }: Props = $props();

  const FORMATS: { value: ExportFormat; label: string }[] = [
    { value: "csv", label: "CSV" },
    { value: "json", label: "JSON" },
  ];

  let open = $state(false);
  let busy = $state(false);
  let failed = $state(false);
  let alignRight = $state(true);
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu = $state<HTMLDivElement>();

  const items = () => [...(menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];

  async function show() {
    // The menu opens toward the left unless that would run off the left edge.
    alignRight = trigger.getBoundingClientRect().right - 160 > 8;
    failed = false;
    open = true;
    await tick();
    items()[0]?.focus();
  }

  function hide(refocus = false) {
    open = false;
    if (refocus) trigger.focus();
  }

  /** Saves the rows as a file through a blob link (the CSP allows blob:). */
  function download(data: readonly unknown[], format: ExportFormat) {
    const type = format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8";
    const url = URL.createObjectURL(new Blob([exportText(data, format)], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(name, format);
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoked once the browser has taken the file.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function save(format: ExportFormat) {
    busy = true;
    failed = false;
    try {
      download(await rows(), format);
      hide(true);
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
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
    class="btn justify-center !px-0 {small ? '!h-7 w-7' : 'w-8'}"
    title={t("export.label")}
    aria-label={t("export.label")}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open ? hide() : show())}
    onkeydown={onTriggerKey}
  >
    {#if busy}<Spinner size={14} />{:else}<Download size={14} />{/if}
  </button>
  {#if open}
    <div bind:this={menu} class="popover w-40 {alignRight ? 'right-0' : 'left-0'}" role="menu" aria-label={t("export.label")} tabindex="-1" onkeydown={onMenuKey}>
      {#each FORMATS as f (f.value)}
        <button type="button" role="menuitem" class="popover-item" disabled={busy} onclick={() => save(f.value)}>
          <span class="min-w-0 flex-1 truncate">{t("export.as", { format: f.label })}</span>
        </button>
      {/each}
      {#if failed}<p class="px-2.5 py-1.5 text-xs text-bad" role="alert">{t("export.failed")}</p>{/if}
    </div>
  {/if}
</div>
