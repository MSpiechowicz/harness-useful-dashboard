import { describe, expect, test } from "bun:test";
import { ariaShortcut, formatShortcut, isMacPlatform, matchesShortcut, pageCombos, shortcutOf, shortcutText, type KeyPress } from "../web/src/lib/shortcuts.ts";

const key = (k: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

// The menu's pages in its order, as App.svelte lists them.
const MENU = [
  "overview", "live", "trends", "projects", "branches", "models", "drift", "providers", "users", "hosts", "skills", "agents", "tags",
  "sessions", "prompts", "time", "tools", "files", "plans", "friction", "cache", "tips", "settings",
];

describe("isMacPlatform", () => {
  test("Apple systems", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("iPhone")).toBe(true);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
    expect(isMacPlatform("Win32")).toBe(false);
  });
});

describe("matchesShortcut", () => {
  test("mod is Ctrl on a PC and ⌘ on a Mac", () => {
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", false)).toBe(true);
    expect(matchesShortcut(key("K", { ctrlKey: true }), "mod+k", false)).toBe(true);
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { metaKey: true }), "mod+k", true)).toBe(true);
    expect(matchesShortcut(key("k", { ctrlKey: true }), "mod+k", true)).toBe(false);
  });
  test("a modifier the combo doesn't name must be up", () => {
    expect(matchesShortcut(key("k"), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true, altKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true, shiftKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { ctrlKey: true, metaKey: true }), "mod+k", false)).toBe(false);
    expect(matchesShortcut(key("k", { metaKey: true, ctrlKey: true }), "mod+k", true)).toBe(false);
  });
  test("? is typed with Shift, / with or without it", () => {
    expect(matchesShortcut(key("?", { shiftKey: true }), "?", false)).toBe(true);
    expect(matchesShortcut(key("?"), "?", false)).toBe(true);
    expect(matchesShortcut(key("/"), "/", false)).toBe(true);
    // A layout where the slash needs Shift (German).
    expect(matchesShortcut(key("/", { shiftKey: true }), "/", false)).toBe(true);
    expect(matchesShortcut(key("?", { ctrlKey: true }), "?", false)).toBe(false);
    expect(matchesShortcut(key("/", { ctrlKey: true }), "/", false)).toBe(false);
    expect(matchesShortcut(key("/", { ctrlKey: true }), "mod+/", false)).toBe(true);
  });
  test("digits, comma and arrows", () => {
    expect(matchesShortcut(key("1", { ctrlKey: true }), "mod+1", false)).toBe(true);
    expect(matchesShortcut(key("1", { ctrlKey: true, shiftKey: true }), "mod+1", false)).toBe(false);
    expect(matchesShortcut(key("2", { ctrlKey: true }), "mod+1", false)).toBe(false);
    expect(matchesShortcut(key(",", { metaKey: true }), "mod+,", true)).toBe(true);
    expect(matchesShortcut(key(","), "mod+,", false)).toBe(false);
    expect(matchesShortcut(key("ArrowLeft", { altKey: true }), "alt+arrowleft", false)).toBe(true);
    expect(matchesShortcut(key("ArrowLeft"), "alt+arrowleft", false)).toBe(false);
    expect(matchesShortcut(key("ArrowRight", { altKey: true }), "alt+arrowleft", false)).toBe(false);
  });
});

describe("formatShortcut", () => {
  test("a PC spells the modifiers, a Mac uses symbols", () => {
    expect(formatShortcut("mod+k", false)).toEqual(["Ctrl", "K"]);
    expect(formatShortcut("mod+k", true)).toEqual(["⌘", "K"]);
    expect(formatShortcut("alt+arrowleft", false)).toEqual(["Alt", "←"]);
    expect(formatShortcut("alt+arrowright", true)).toEqual(["⌥", "→"]);
    expect(formatShortcut("shift+?", false)).toEqual(["Shift", "?"]);
    expect(formatShortcut("shift+?", true)).toEqual(["⇧", "?"]);
  });
  test("single keys", () => {
    expect(formatShortcut("?", false)).toEqual(["?"]);
    expect(formatShortcut("mod+,", false)).toEqual(["Ctrl", ","]);
    expect(formatShortcut("mod+1", true)).toEqual(["⌘", "1"]);
    expect(formatShortcut("escape", false)).toEqual(["Esc"]);
    expect(formatShortcut("enter", false)).toEqual(["↵"]);
  });
  test("text for a tooltip and for aria-keyshortcuts", () => {
    expect(shortcutText("mod+1", false)).toBe("Ctrl+1");
    expect(shortcutText("mod+1", true)).toBe("⌘1");
    expect(ariaShortcut("mod+k", false)).toBe("Control+K");
    expect(ariaShortcut("mod+k", true)).toBe("Meta+K");
    expect(ariaShortcut("alt+arrowleft", false)).toBe("Alt+ArrowLeft");
    expect(ariaShortcut("?", false)).toBe("?");
  });
});

describe("pageCombos", () => {
  test("the first nine pages of the menu take mod+1 to mod+9, in its order", () => {
    const combos = pageCombos(MENU);
    expect([...combos.entries()].slice(0, 9)).toEqual([
      ["overview", "mod+1"],
      ["live", "mod+2"],
      ["trends", "mod+3"],
      ["projects", "mod+4"],
      ["branches", "mod+5"],
      ["models", "mod+6"],
      ["drift", "mod+7"],
      ["providers", "mod+8"],
      ["users", "mod+9"],
    ]);
    expect(combos.has("hosts")).toBe(false);
    expect(combos.has("tips")).toBe(false);
  });
  test("settings takes the comma and no digit", () => {
    expect(pageCombos(MENU).get("settings")).toBe("mod+,");
    expect(pageCombos(["settings", "overview"]).get("overview")).toBe("mod+1");
  });
  test("a shorter menu gets fewer", () => {
    expect([...pageCombos(["live", "tips"]).values()]).toEqual(["mod+1", "mod+2"]);
  });
});

describe("shortcutOf", () => {
  const of = (e: KeyPress, typing = false, mac = false) => shortcutOf(e, typing, MENU, mac);

  test("Ctrl+K opens the palette, also while typing", () => {
    expect(of(key("k", { ctrlKey: true }))).toBe("palette");
    expect(of(key("k", { ctrlKey: true }), true)).toBe("palette");
    expect(of(key("K", { metaKey: true }), true, true)).toBe("palette");
    expect(of(key("k", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(of(key("k"))).toBeNull();
  });
  test("? and / only when not typing, mod+/ also while typing", () => {
    expect(of(key("/"))).toBe("search");
    expect(of(key("?", { shiftKey: true }))).toBe("shortcuts");
    expect(of(key("/"), true)).toBeNull();
    expect(of(key("?", { shiftKey: true }), true)).toBeNull();
    expect(of(key("/", { ctrlKey: true }))).toBe("shortcuts");
    expect(of(key("/", { ctrlKey: true }), true)).toBe("shortcuts");
    expect(of(key("/", { metaKey: true }), true, true)).toBe("shortcuts");
  });
  test("the sidebar, back and forward", () => {
    expect(of(key("b", { ctrlKey: true }))).toBe("sidebar");
    expect(of(key("b", { ctrlKey: true }), true)).toBe("sidebar");
    expect(of(key("b", { metaKey: true }))).toBeNull();
    expect(of(key("ArrowLeft", { altKey: true }))).toBe("back");
    expect(of(key("ArrowRight", { altKey: true }))).toBe("forward");
    expect(of(key("ArrowLeft", { altKey: true }), true)).toBeNull();
  });
  test("pages follow the menu, also while typing", () => {
    expect(of(key("1", { ctrlKey: true }))).toBe("go:overview");
    expect(of(key("9", { ctrlKey: true }), true)).toBe("go:users");
    expect(of(key("3", { metaKey: true }), false, true)).toBe("go:trends");
    expect(of(key(",", { ctrlKey: true }))).toBe("go:settings");
    expect(of(key("1"))).toBeNull();
    expect(of(key("1", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(shortcutOf(key("2", { ctrlKey: true }), false, ["tips", "cache"], false)).toBe("go:cache");
    expect(shortcutOf(key("3", { ctrlKey: true }), false, ["tips", "cache"], false)).toBeNull();
  });
});
