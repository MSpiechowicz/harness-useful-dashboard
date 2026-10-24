<script lang="ts" module>
  /** What a gauge draws, as fractions of its scale from the 0% end: the reading, where the solid part stops, and the pale forecast stretch. */
  export interface Dial {
    value: number;
    solid: number;
    ahead: { from: number; to: number } | null;
  }
  export type GaugeKind = "tach" | "segments" | "vu" | "thermo";

  const rad = (deg: number) => (deg * Math.PI) / 180;
  const num = (n: number) => n.toFixed(2);

  /** An arc of the circle round (cx, cy) between two angles in degrees, clockwise from the right, as a path. */
  export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
    const x1 = cx + r * Math.cos(rad(from));
    const y1 = cy + r * Math.sin(rad(from));
    const x2 = cx + r * Math.cos(rad(to));
    const y2 = cy + r * Math.sin(rad(to));
    return `M${num(x1)} ${num(y1)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${num(x2)} ${num(y2)}`;
  }

  /** The size each gauge is drawn at: its viewBox, and its width on its own and among four or more. */
  const SIZES: Record<GaugeKind, { box: [number, number]; width: [number, number] }> = {
    tach: { box: [120, 112], width: [112, 92] },
    segments: { box: [120, 84], width: [120, 96] },
    vu: { box: [120, 70], width: [120, 96] },
    thermo: { box: [120, 100], width: [120, 96] },
  };
</script>

<script lang="ts">
  import { t } from "../lib/i18n.svelte.ts";

  interface Props {
    kind: GaugeKind;
    /** The provider's color: the fill is never recolored for a warning. */
    color: string;
    dial: Dial;
    mode: "used" | "left";
    /** Read out by screen readers in place of the drawing. */
    label: string;
    /** Smaller, when four or more share a row. */
    small: boolean;
  }
  let { kind, color, dial, mode, label, small }: Props = $props();

  // Ids in an svg are shared by the whole page: each gauge needs its own for its clip path.
  const uid = $props.id();

  const size = $derived(SIZES[kind]);
  const width = $derived(size.width[small ? 1 : 0]);
  const height = $derived(Math.round((width * size.box[1]) / size.box[0]));
  const pct = $derived(`${Math.round(dial.value * 100)}%`);
  const word = $derived(t(mode === "used" ? "live.dial.used" : "live.dial.left"));

  // The red end of the scale: the last tenth when counting up, the first when counting down. Its label is red too.
  const red = $derived<[number, number]>(mode === "used" ? [0.9, 1] : [0, 0.1]);
  const RED = "var(--bad-ink)";
  const EMPTY = "var(--surface-4, var(--surface-3))";
  const MIN_SOLID = 0.003;

  // A pointer tapering from its pivot (cx, cy) along an angle, as the points of a polygon.
  function needle(cx: number, cy: number, deg: number, length: number, back: number, wide: number): string {
    const ux = Math.cos(rad(deg));
    const uy = Math.sin(rad(deg));
    const tip = [cx + ux * length, cy + uy * length];
    const tail = [cx - ux * back, cy - uy * back];
    return [
      [tip[0]! - uy * 0.9, tip[1]! + ux * 0.9],
      [tip[0]! + uy * 0.9, tip[1]! - ux * 0.9],
      [tail[0]! + uy * wide, tail[1]! - ux * wide],
      [tail[0]! - uy * wide, tail[1]! + ux * wide],
    ]
      .map(([x, y]) => `${num(x!)},${num(y!)}`)
      .join(" ");
  }

  // Eleven ticks, at every tenth, the ends and the middle longer.
  const TENTHS = Array.from({ length: 11 }, (_, i) => i / 10);
  const major = (f: number) => f === 0 || f === 0.5 || f === 1;

  // Tachometer: 270 degrees from the lower left round to the lower right, the number in the gap at the bottom.
  const TACH = { cx: 60, cy: 56, r: 46, start: 135, sweep: 270 };
  const tachAt = (f: number) => TACH.start + TACH.sweep * f;
  const tachArc = (from: number, to: number) => arcPath(TACH.cx, TACH.cy, TACH.r, tachAt(from), tachAt(to));
  const tachTicks = $derived(
    TENTHS.map((f) => {
      const a = rad(tachAt(f));
      const inner = TACH.r - 13;
      const outer = TACH.r - (major(f) ? 6 : 9);
      return {
        x1: TACH.cx + inner * Math.cos(a),
        y1: TACH.cy + inner * Math.sin(a),
        x2: TACH.cx + outer * Math.cos(a),
        y2: TACH.cy + outer * Math.sin(a),
        hot: mode === "used" ? f >= 0.9 : f <= 0.1,
        major: major(f),
      };
    }),
  );

  // Segmented arc: ten blocks round a half circle, lit one by one. A block is lit when its middle is within the solid
  // part, pale when within the forecast stretch.
  const SEGS = { cx: 60, cy: 62, r: 46, gap: 3.2, count: 10 };
  const blocks = $derived(
    Array.from({ length: SEGS.count }, (_, i) => {
      const step = 180 / SEGS.count;
      const d = arcPath(SEGS.cx, SEGS.cy, SEGS.r, 180 + step * i + SEGS.gap / 2, 180 + step * (i + 1) - SEGS.gap / 2);
      const mid = (i + 0.5) / SEGS.count;
      const hot = mode === "used" ? i === SEGS.count - 1 : i === 0;
      const lit = mid <= dial.solid + 1e-6 || (dial.solid >= 0.02 && i === 0);
      const pale = !lit && dial.ahead != null && mid >= dial.ahead.from && mid <= dial.ahead.to + 0.05;

      if (lit) return { d, fill: color, opacity: 1 };
      if (pale) return { d, fill: color, opacity: 0.35 };
      if (hot) return { d, fill: RED, opacity: 0.45 };
      return { d, fill: "var(--surface-3)", opacity: 1 };
    }),
  );

  // VU meter: a face with a flat scale high up and a long needle from a pivot below it.
  const VU = { cx: 60, cy: 104, r: 84, start: 237, sweep: 66 };
  const vuAt = (f: number) => VU.start + VU.sweep * f;
  const vuArc = (from: number, to: number) => arcPath(VU.cx, VU.cy, VU.r, vuAt(from), vuAt(to));
  const vuTicks = TENTHS.map((f) => {
    const a = rad(vuAt(f));
    const inner = VU.r + 5;
    const outer = VU.r + (major(f) ? 11 : 8);
    return { x1: VU.cx + inner * Math.cos(a), y1: VU.cy + inner * Math.sin(a), x2: VU.cx + outer * Math.cos(a), y2: VU.cy + outer * Math.sin(a), major: major(f) };
  });
  const vuNeedle = $derived({ x: VU.cx + (VU.r + 9) * Math.cos(rad(vuAt(dial.value))), y: VU.cy + (VU.r + 9) * Math.sin(rad(vuAt(dial.value))) });

  // Thermometer: a tube on a bulb. Every layer is clipped to the glass's inside, a capsule that runs on into the bulb, so
  // the top of the tube is round and the fill flows into the bulb without a seam. The bulb is well wider than the tube,
  // so it reads as a round bulb rather than a square end.
  const THERMO = { x: 30, tube: 12, rim: 2.5, bottom: 78, top: 5.5, bulb: 87 };
  const thermoY = (f: number) => THERMO.bottom - (THERMO.bottom - THERMO.top) * f;
  const thermoTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: thermoY(f), long: f === 0.5 }));
  const channel = THERMO.tube - 2 * THERMO.rim;
  // The layers inside the glass span the bulb's full width: the clip gives them the tube's and the bulb's round shapes.
  const BULB = 11;
  // The bulb is the bottom of the fill: coloured while the tube shows anything, empty at 0% in either mode.
  const filled = $derived(dial.value > MIN_SOLID);

  /** A layer of the tube from the share a to the share b. The fill goes on into the bulb. */
  function layer(a: number, b: number, intoBulb = false): { y: number; height: number } {
    const top = thermoY(b);
    const bottom = intoBulb ? THERMO.bulb + 10 : thermoY(a);
    return { y: top, height: Math.max(0, bottom - top) };
  }
</script>

{#if kind === "tach"}
  <svg viewBox="0 0 {size.box[0]} {size.box[1]}" {width} {height} class="shrink-0" role="img" aria-label={label}>
    <path d={tachArc(0, 1)} fill="none" class="stroke-surface-3" stroke-width="7" stroke-linecap="round" />
    <path d={tachArc(red[0], red[1])} fill="none" stroke={RED} stroke-opacity=".55" stroke-width="7" />
    {#if dial.ahead}<path d={tachArc(dial.ahead.from, dial.ahead.to)} fill="none" stroke={color} stroke-opacity=".35" stroke-width="7" />{/if}
    {#if dial.solid > MIN_SOLID}<path d={tachArc(0, dial.solid)} fill="none" stroke={color} stroke-width="7" stroke-linecap="round" />{/if}
    {#each tachTicks as tick, i (i)}
      <line x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} class={tick.hot ? "stroke-bad" : "stroke-muted"} stroke-width={tick.major ? 1.8 : 1.1} stroke-linecap="round" />
    {/each}
    <polygon points={needle(TACH.cx, TACH.cy, tachAt(dial.value), TACH.r - 16, 7, 3)} class="fill-ink stroke-ink" stroke-width=".8" stroke-linejoin="round" />
    <circle cx={TACH.cx} cy={TACH.cy} r="6" class="fill-ink" />
    <circle cx={TACH.cx} cy={TACH.cy} r="2" class="fill-surface" />
    <text x={TACH.cx} y="92" text-anchor="middle" dominant-baseline="central" font-size="19" font-weight="700" class="fill-ink">{pct}</text>
    <text x={TACH.cx} y="106" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="500" class="fill-ink-2">{word}</text>
  </svg>
{:else if kind === "segments"}
  <svg viewBox="0 0 {size.box[0]} {size.box[1]}" {width} {height} class="shrink-0" role="img" aria-label={label}>
    {#each blocks as block, i (i)}
      <path d={block.d} fill="none" stroke={block.fill} stroke-opacity={block.opacity} stroke-width="11" />
    {/each}
    <text x={SEGS.cx - SEGS.r} y={SEGS.cy + 14} text-anchor="middle" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-ink-2" : "fill-bad"}>0%</text>
    <text x={SEGS.cx + SEGS.r} y={SEGS.cy + 14} text-anchor="middle" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-bad" : "fill-ink-2"}>100%</text>
    <text x={SEGS.cx} y="48" text-anchor="middle" dominant-baseline="central" font-size="22" font-weight="700" letter-spacing="-.5" class="fill-ink">{pct}</text>
    <text x={SEGS.cx} y="64" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="500" class="fill-ink-2">{word}</text>
  </svg>
{:else if kind === "vu"}
  <!-- A short face, so the number gets a line of its own under it. -->
  <div class="flex shrink-0 flex-col items-center gap-1.5">
    <svg viewBox="0 0 {size.box[0]} {size.box[1]}" {width} {height} class="shrink-0" role="img" aria-label={label}>
      <defs><clipPath id="{uid}-face"><rect x="2" y="2" width="116" height="66" rx="9" /></clipPath></defs>
      <rect x="2" y="2" width="116" height="66" rx="9" class="fill-surface-2 stroke-line-strong" />
      <g clip-path="url(#{uid}-face)">
        <path d={vuArc(0, 1)} fill="none" stroke={EMPTY} stroke-width="5" />
        <path d={vuArc(red[0], red[1])} fill="none" stroke={RED} stroke-opacity=".7" stroke-width="5" />
        {#if dial.ahead}<path d={vuArc(dial.ahead.from, dial.ahead.to)} fill="none" stroke={color} stroke-opacity=".35" stroke-width="5" />{/if}
        {#if dial.solid > MIN_SOLID}<path d={vuArc(0, dial.solid)} fill="none" stroke={color} stroke-width="5" />{/if}
        {#each vuTicks as tick, i (i)}
          <line x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} class="stroke-muted" stroke-width={tick.major ? 1.6 : 1} stroke-linecap="round" />
        {/each}
        <text x="7" y="13" text-anchor="start" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-ink-2" : "fill-bad"}>0%</text>
        <text x="113" y="13" text-anchor="end" font-size="8.5" font-weight="700" class={mode === "used" ? "fill-bad" : "fill-ink-2"}>100%</text>
        <line x1={VU.cx} y1={VU.cy} x2={vuNeedle.x} y2={vuNeedle.y} class="stroke-ink" stroke-width="1.8" stroke-linecap="round" />
        <rect x="2" y="54" width="116" height="14" class="fill-surface-3" />
      </g>
    </svg>
    <span class="flex items-baseline justify-center gap-1 leading-none">
      <b class="font-bold tracking-[-0.02em] tabular-nums {small ? 'text-[18px]' : 'text-[22px]'}">{pct}</b>
      <span class="text-[11px] font-medium text-ink-2">{word}</span>
    </span>
  </div>
{:else}
  <svg viewBox="0 0 {size.box[0]} {size.box[1]}" {width} {height} class="shrink-0" role="img" aria-label={label}>
    <defs>
      <clipPath id="{uid}-glass">
        <rect x={THERMO.x - channel / 2} y={THERMO.top} width={channel} height={THERMO.bulb - THERMO.top} rx={channel / 2} />
        <circle cx={THERMO.x} cy={THERMO.bulb} r="8.5" />
      </clipPath>
    </defs>
    <rect x={THERMO.x - THERMO.tube / 2} y={THERMO.top - THERMO.rim} width={THERMO.tube} height={THERMO.bulb - THERMO.top + THERMO.rim} rx={THERMO.tube / 2} class="fill-surface-3" />
    <circle cx={THERMO.x} cy={THERMO.bulb} r="11" class="fill-surface-3" />
    <g clip-path="url(#{uid}-glass)">
      <rect x={THERMO.x - BULB} y="0" width={2 * BULB} height="100" fill={EMPTY} />
      {#if filled}<rect x={THERMO.x - BULB} y={THERMO.bottom} width={2 * BULB} height={THERMO.bulb + 10 - THERMO.bottom} fill={color} />{/if}
      <rect x={THERMO.x - BULB} width={2 * BULB} {...layer(red[0], red[1])} fill={RED} fill-opacity=".5" />
      {#if dial.ahead}<rect x={THERMO.x - BULB} width={2 * BULB} {...layer(dial.ahead.from, dial.ahead.to)} fill={color} fill-opacity=".35" />{/if}
      {#if dial.solid > MIN_SOLID}<rect x={THERMO.x - BULB} width={2 * BULB} {...layer(0, dial.solid, true)} fill={color} />{/if}
    </g>
    {#each thermoTicks as tick, i (i)}
      <line x1={THERMO.x + THERMO.tube / 2 + 3} y1={tick.y} x2={THERMO.x + THERMO.tube / 2 + (tick.long ? 9 : 7)} y2={tick.y} class="stroke-muted" stroke-width="1.4" stroke-linecap="round" />
    {/each}
    <text x={THERMO.x + THERMO.tube / 2 + 12} y={thermoY(1) + 3} font-size="8.5" font-weight="700" class={mode === "used" ? "fill-bad" : "fill-ink-2"}>100%</text>
    <text x={THERMO.x + THERMO.tube / 2 + 12} y={thermoY(0) + 3} font-size="8.5" font-weight="700" class={mode === "used" ? "fill-ink-2" : "fill-bad"}>0%</text>
    <text x="86" y="44" text-anchor="middle" dominant-baseline="central" font-size="21" font-weight="700" letter-spacing="-.5" class="fill-ink">{pct}</text>
    <text x="86" y="60" text-anchor="middle" dominant-baseline="central" font-size="9.5" font-weight="500" class="fill-ink-2">{word}</text>
  </svg>
{/if}
