/**
 * Keyboard shortcuts: which key press asks for what, and how a key is shown. A combo is a lowercase string such as
 * `mod+k`, `mod+,` or `alt+arrowleft`. `mod` is ⌘ on Apple systems and Ctrl elsewhere. Pure functions, no DOM: App.svelte
 * runs what these decide and the shortcuts dialog shows the same list.
 */

/** The parts of a key press the shortcuts look at. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Whether the system is an Apple one, where ⌘ is the main modifier. */
export function isMacPlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1]!;
  const modifiers = new Set(parts.slice(0, -1));
  return { key, mod: modifiers.has("mod"), alt: modifiers.has("alt"), shift: modifiers.has("shift") };
}

/** A key that is neither a letter nor a digit (/ ? ,): the layout decides whether it needs Shift, so Shift says nothing. */
const isSymbol = (key: string) => key.length === 1 && !/[\p{L}\p{N}]/u.test(key);

/** Whether the key press is the combo. Any modifier the combo doesn't name must be up, and ⌘ on a PC or Ctrl on a Mac is one. */
export function matchesShortcut(e: KeyPress, combo: string, mac: boolean): boolean {
  const want = parseCombo(combo);
  const modPressed = mac ? e.metaKey : e.ctrlKey;
  const strayModifier = mac ? e.ctrlKey : e.metaKey;
  if (strayModifier || modPressed !== want.mod || e.altKey !== want.alt) return false;

  const shiftIgnored = isSymbol(want.key) && !want.shift;
  if (!shiftIgnored && e.shiftKey !== want.shift) return false;

  return e.key.toLowerCase() === want.key;
}

const SYMBOLS_MAC: Record<string, string> = { mod: "⌘", alt: "⌥", shift: "⇧" };
const SYMBOLS_OTHER: Record<string, string> = { mod: "Ctrl", alt: "Alt", shift: "Shift" };
const KEY_LABELS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  enter: "↵",
  escape: "Esc",
  home: "Home",
  end: "End",
};

/** The caps a combo is shown with, one per key: ["Ctrl", "K"] or ["⌘", "K"]. */
export function formatShortcut(combo: string, mac: boolean): string[] {
  const symbols = mac ? SYMBOLS_MAC : SYMBOLS_OTHER;
  const want = parseCombo(combo);
  const caps = (["mod", "alt", "shift"] as const).filter((name) => want[name]).map((name) => symbols[name]);
  return [...caps, KEY_LABELS[want.key] ?? want.key.toUpperCase()];
}

/** A combo as one line of text, for a tooltip: "Ctrl+K", or "⌘K" on a Mac. */
export function shortcutText(combo: string, mac: boolean): string {
  return formatShortcut(combo, mac).join(mac ? "" : "+");
}

const ARIA_KEYS: Record<string, string> = { arrowleft: "ArrowLeft", arrowright: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", escape: "Escape", enter: "Enter" };

/** A combo for `aria-keyshortcuts`: "Control+K", or "Meta+K" on a Mac. */
export function ariaShortcut(combo: string, mac: boolean): string {
  const want = parseCombo(combo);
  const parts = [want.mod ? (mac ? "Meta" : "Control") : "", want.alt ? "Alt" : "", want.shift ? "Shift" : ""].filter(Boolean);
  return [...parts, ARIA_KEYS[want.key] ?? (want.key.length === 1 ? want.key.toUpperCase() : want.key)].join("+");
}

/** What a global shortcut does. Going to a page is `go:` and its name. */
export type ShortcutAction = "palette" | "shortcuts" | "search" | "sidebar" | "back" | "forward" | `go:${string}`;

/**
 * Whether a shortcut acts while a text field has focus: `always`, `modified` (only the combos with Ctrl or ⌘, so typing
 * is never taken) or `never`.
 */
type WhileTyping = "always" | "modified" | "never";

/** The shortcuts that are always the same. The ones for pages follow the menu: see `pageCombos`. */
export const GLOBAL_SHORTCUTS: { action: Exclude<ShortcutAction, `go:${string}`>; combos: string[]; typing: WhileTyping }[] = [
  { action: "palette", combos: ["mod+k"], typing: "always" },
  { action: "shortcuts", combos: ["?", "mod+/"], typing: "modified" },
  { action: "search", combos: ["/"], typing: "never" },
  { action: "sidebar", combos: ["mod+b"], typing: "always" },
  { action: "back", combos: ["alt+arrowleft"], typing: "never" },
  { action: "forward", combos: ["alt+arrowright"], typing: "never" },
];

/** The settings page has its own key, the others take the digits in the menu's order. */
export const SETTINGS_COMBO = "mod+,";
const SETTINGS_PAGE = "settings";
const DIGITS = 9;

/** The combo of each page that has one: the first nine pages of the menu take mod+1 to mod+9, settings takes mod+comma. */
export function pageCombos(pages: string[]): Map<string, string> {
  const combos = new Map<string, string>();
  let digit = 0;
  for (const page of pages) {
    if (page === SETTINGS_PAGE) combos.set(page, SETTINGS_COMBO);
    else if (digit < DIGITS) combos.set(page, `mod+${++digit}`);
  }
  return combos;
}

/** What a key press asks for, or null. `typing` is whether focus is in a text field. `pages` are the menu's, in order. */
export function shortcutOf(e: KeyPress, typing: boolean, pages: string[], mac: boolean): ShortcutAction | null {
  const allowed = (combo: string, when: WhileTyping) => !typing || when === "always" || (when === "modified" && combo.startsWith("mod+"));

  for (const { action, combos, typing: when } of GLOBAL_SHORTCUTS) {
    const combo = combos.find((c) => matchesShortcut(e, c, mac));
    if (combo && allowed(combo, when)) return action;
  }
  for (const [page, combo] of pageCombos(pages)) {
    if (matchesShortcut(e, combo, mac) && allowed(combo, "always")) return `go:${page}`;
  }
  return null;
}
