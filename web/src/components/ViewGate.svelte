<script lang="ts">
  import type { Snippet } from "svelte";
  import Loading from "./Loading.svelte";

  /** The spinner stays at least this long, so it never just flashes by. */
  const MIN_MS = 1500;

  let { ready, children }: { ready: boolean; children: Snippet } = $props();

  // A view waits behind one spinner until all its data has arrived, then renders everything at once. Once shown it
  // stays: later refreshes (filters, live updates) dim the content in place instead of bringing the spinner back.
  let waited = $state(false);
  let shown = $state(false);
  $effect(() => {
    const id = setTimeout(() => (waited = true), MIN_MS);
    return () => clearTimeout(id);
  });
  $effect(() => {
    if (ready && waited) shown = true;
  });
</script>

{#if shown}
  {@render children()}
{:else}
  <div class="card"><Loading /></div>
{/if}
