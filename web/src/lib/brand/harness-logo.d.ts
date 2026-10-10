/** Types for consumers of the harness logo browser bundle. Plain DOM, no framework augmentation. */

export type PoseId = 'upright' | 'tipped' | 'resting';
export type LogoVersion = 'full' | 'short';
export type LockupTheme = 'dark' | 'light';

export type LogoBox = { x: number; y: number; width: number; height: number };

/** Measured name: the x where the name starts and the cumulative width of its first 0..n characters. */
export type LogoNameMetrics = { prodX: number; sub: number[] };

export type LockupOptions = {
  theme: LockupTheme;
  pose: PoseId;
  name: string;
  metrics: LogoNameMetrics;
  box: LogoBox;
  /** Embedded as an @font-face. Without it the text falls back to the fonts of whoever opens the SVG. */
  fontUrl?: string;
  idPrefix?: string;
};

/**
 * <harness-logo>, the reveal animation of the harness mark.
 *
 * Attributes: `name` (typed by the full version), `version` ("short" or "full"), `pose`, `autoplay`, `loop`,
 * `font-url` (woff2 for the full version). Without `autoplay` it shows the final frame.
 * Colors: --harness-logo-fg, --harness-logo-muted, --harness-logo-dust and --harness-logo-font.
 * Emits a bubbling, composed `finish` event once per play.
 */
export interface HarnessLogoElement extends HTMLElement {
  /** Length of the animation in seconds. */
  readonly duration: number;

  /** Resolves once drawn. The full version first loads its font and measures the name. */
  readonly ready: Promise<void>;

  /** The viewBox in use. Final for the full version once `ready` has resolved. */
  readonly viewBox: LogoBox;

  /** Plays from the start. Shows the final frame under prefers-reduced-motion. */
  play(): void;

  /** Jumps to the final frame and emits `finish`. */
  skip(): void;

  /** Pauses and draws the frame at `t` seconds, synchronously. */
  seek(t: number): void;

  /** The final frame of the full version as a standalone SVG string. Await `ready` first. */
  lockupSvg(theme?: LockupTheme): string;

  addEventListener(
    type: 'finish',
    listener: (this: HarnessLogoElement, ev: CustomEvent<null>) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** Registers a variable-weight woff2 on the document under `family` (default "Harness Inter"). Never rejects. */
export function registerFont(url: string, family?: string): Promise<void>;

/**
 * The lockup as a standalone SVG string, from measurements you already have. Most callers use
 * `lockupSvg()` on the element instead. The bundle also exports the drawing engine, which is not typed here.
 */
export function lockupSvg(opts: LockupOptions): string;

/** Registers <harness-logo>. The bundle already calls this on import. */
export function defineHarnessLogo(): void;

declare global {
  interface HTMLElementTagNameMap {
    'harness-logo': HarnessLogoElement;
  }
}
