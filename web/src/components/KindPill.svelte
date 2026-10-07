<script lang="ts">
  import { colorFor } from "../lib/colors.svelte.ts";
  import { kindName } from "../lib/format.ts";

  /** A session's kind of work as a small pill with the kind's color. */
  let { kind }: { kind: string } = $props();
</script>

<span class="inline-flex shrink-0 items-center gap-1 rounded bg-surface-2 px-1.5 text-[10px] text-ink-2"><span class="h-1.5 w-1.5 rounded-full" style:background={colorFor("kind", kind)}></span>{kindName(kind)}</span>
