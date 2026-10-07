<script lang="ts">
  import { RefreshCw, TriangleAlert } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import { apiHealth } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import Loading from "./Loading.svelte";

  /** A view that answers within this long appears without a spinner at all. */
  const DELAY_MS = 250;
  /** Once shown, the spinner stays at least this long, so it never just flashes by. */
  const MIN_MS = 400;

  let { ready, children }: { ready: boolean; children: Snippet } = $props();

  // A view waits until all its data has arrived, then renders everything at once. Once shown it stays: later
  // refreshes (filters, live updates) dim the content in place instead of bringing the spinner back.
  let spinnerAt = $state<number | null>(null);
  let shown = $state(false);
  const failed = $derived(apiHealth.failing > 0);
  // The server answers, but this browser didn't come in through the sign-in link.
  const signedOut = $derived(apiHealth.message === "unauthorized");

  $effect(() => {
    const id = setTimeout(() => (spinnerAt = performance.now()), DELAY_MS);
    return () => clearTimeout(id);
  });
  $effect(() => {
    if (shown || !ready || failed) return;
    const wait = spinnerAt == null ? 0 : MIN_MS - (performance.now() - spinnerAt);
    const show = () => {
      shown = true;
      store.restoreScroll();
    };
    if (wait <= 0) return show();
    const id = setTimeout(show, wait);
    return () => clearTimeout(id);
  });

  const retry = () => store.refreshTick++;
</script>

{#if shown}
  {#if failed}
    <!-- The data on screen stays, with a word that it may be out of date. -->
    <div class="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-2" role="status">
      <TriangleAlert size={14} class="shrink-0" style="color: var(--status-warning)" />
      <span class="min-w-0 flex-1 truncate">{t("error.stale")}</span>
      <button type="button" class="btn !h-7 !px-2" onclick={retry}><RefreshCw size={13} />{t("error.retry")}</button>
    </div>
  {/if}
  <div class="view-enter">{@render children()}</div>
{:else if failed && ready}
  <div class="card flex flex-col items-center justify-center py-16 text-center" role="alert">
    <div class="mb-3 rounded-full bg-surface-2 p-3" style="color: var(--status-warning)"><TriangleAlert size={24} /></div>
    <div class="text-sm font-medium text-ink">{t("error.title")}</div>
    <p class="mt-1 max-w-md text-sm text-muted">{t(signedOut ? "error.signedOut" : "error.body")}</p>
    {#if apiHealth.message && !signedOut}<p class="mt-2 max-w-md truncate font-mono text-xs text-muted" title={apiHealth.message}>{apiHealth.message}</p>{/if}
    <button type="button" class="btn mt-4" onclick={retry}><RefreshCw size={14} />{t("error.retry")}</button>
  </div>
{:else if spinnerAt != null}
  <div class="card"><Loading /></div>
{/if}
