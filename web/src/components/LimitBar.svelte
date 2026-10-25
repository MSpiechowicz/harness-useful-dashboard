<script lang="ts">
  import type { Dial } from "./LimitGauge.svelte";

  interface Props {
    /** The provider's color: the blocks are never recolored for a warning. */
    color: string;
    dial: Dial;
    mode: "used" | "left";
    /** Smaller, when four or more limits share the card. */
    small: boolean;
  }
  let { color, dial, mode, small }: Props = $props();

  // Twenty blocks, lit from the 0% end like the segmented arc: a block is lit when its middle is within the solid part, pale
  // when within the forecast stretch (up to half a block past it), and red when in the red end, the last tenth when counting up
  // and the first when counting down.
  const COUNT = 20;
  const red = $derived<[number, number]>(mode === "used" ? [0.9, 1] : [0, 0.1]);
  const blocks = $derived(
    Array.from({ length: COUNT }, (_, i) => {
      const mid = (i + 0.5) / COUNT;
      const lit = mid <= dial.solid + 1e-6 || (dial.solid >= 0.02 && i === 0);
      const pale = !lit && dial.ahead != null && mid >= dial.ahead.from && mid <= dial.ahead.to + 0.5 / COUNT;
      const hot = mid >= red[0] && mid <= red[1];

      if (lit) return { background: color, opacity: 1 };
      if (pale) return { background: color, opacity: 0.35 };
      if (hot) return { background: "var(--bad-ink)", opacity: 0.45 };
      return { background: "var(--surface-3)", opacity: 1 };
    }),
  );
</script>

<div class="flex gap-0.5 {small ? 'h-[7px]' : 'h-2.5'}" aria-hidden="true">
  {#each blocks as block, i (i)}
    <b class="min-w-0 flex-1 rounded-[2px]" style:background={block.background} style:opacity={block.opacity}></b>
  {/each}
</div>
