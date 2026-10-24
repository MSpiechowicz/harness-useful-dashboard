<script lang="ts" module>
  /** How much each ring fades, outer first. The list beside the rings gives its dots the same steps. */
  export const RING_OPACITY = [1, 0.78, 0.58, 0.42, 0.32, 0.24];
  export const ringOpacity = (i: number) => RING_OPACITY[Math.min(i, RING_OPACITY.length - 1)]!;
</script>

<script lang="ts">
  import { arcPath, type Dial } from "./LimitGauge.svelte";

  interface Props {
    /** One dial per limit, the outer ring first. */
    dials: Dial[];
    color: string;
    /** Larger, when the card has the room: no pager under it. */
    roomy?: boolean;
  }
  let { dials, color, roomy = false }: Props = $props();

  // Rings of 270 degrees from the top, nested in a 128 box. Up to four have room for a thick stroke, more get thinner rings.
  const CENTER = 64;
  const START = -90;
  const SWEEP = 270;
  const at = (f: number) => START + SWEEP * f;
  const arc = (r: number, from: number, to: number) => arcPath(CENTER, CENTER, r, at(from), at(to));

  const stroke = $derived(dials.length > 4 ? 6 : 9);
  const step = $derived(dials.length > 4 ? (56 - 14) / (dials.length - 1) : 13);
</script>

<svg viewBox="0 0 128 128" width={roomy ? 164 : 136} height={roomy ? 164 : 136} class="shrink-0" aria-hidden="true">
  {#each dials as dial, i (i)}
    {@const r = 56 - i * step}
    {@const opacity = ringOpacity(i)}
    <path d={arc(r, 0, 1)} fill="none" class="stroke-surface-3" stroke-width={stroke} stroke-linecap="round" />
    {#if dial.ahead}<path d={arc(r, dial.ahead.from, dial.ahead.to)} fill="none" stroke={color} stroke-opacity={(opacity * 0.35).toFixed(2)} stroke-width={stroke} stroke-linecap="round" />{/if}
    {#if dial.solid > 0.003}<path d={arc(r, 0, Math.max(dial.solid, 0.012))} fill="none" stroke={color} stroke-opacity={opacity} stroke-width={stroke} stroke-linecap="round" />{/if}
  {/each}
</svg>
