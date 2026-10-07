import { describe, expect, test } from "bun:test";
import { fold, highlight, isEditable, matchRanges, modKey, pushRecent, rank, score, shortcutOf, snippet } from "../web/src/lib/palette-search.ts";

describe("fold", () => {
  test("lowercase, without accents", () => {
    expect(fold("Über Źródło")).toBe("uber zrodlo");
    expect(fold("Paramètres")).toBe("parametres");
  });
  test("letters that don't decompose", () => {
    expect(fold("Łódź")).toBe("lodz");
    expect(fold("Straße")).toBe("strasse");
  });
});

describe("score", () => {
  test("exact beats prefix beats word start beats substring beats fuzzy", () => {
    const exact = score("Models", "models");
    const prefix = score("Models", "mod");
    const word = score("Model drift", "drift");
    const inner = score("Overview", "view");
    const fuzzy = score("Model drift", "mdr", { fuzzy: true });
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inner);
    expect(inner).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });
  test("fuzzy matches only when asked", () => {
    expect(score("Model drift", "mdr")).toBe(0);
  });
  test("case and accents don't matter", () => {
    expect(score("Ustawienia źródeł", "ZRODEL")).toBeGreaterThan(0);
    expect(score("Paramètres", "parametres")).toBe(100);
  });
  test("every word must match", () => {
    expect(score("Time range: Last 7 days", "range 7")).toBeGreaterThan(0);
    expect(score("Time range: Last 7 days", "range 9")).toBe(0);
  });
  test("keywords count, less than the name", () => {
    expect(score("Sessions", "activity", { keywords: ["Activity"] })).toBe(50);
    expect(score("Sessions", "activity")).toBe(0);
  });
  test("an empty query matches everything", () => {
    expect(score("Anything", "  ")).toBe(1);
  });
});

describe("rank", () => {
  const items = [
    { id: "overview", label: "Overview" },
    { id: "models", label: "Models" },
    { id: "drift", label: "Model drift" },
    { id: "tools", label: "Tools" },
  ];
  test("best match first, non-matches dropped", () => {
    expect(rank(items, "mod").map((i) => i.id)).toEqual(["models", "drift"]);
  });
  test("recently used first among equals", () => {
    expect(rank(items, "mod", ["drift"]).map((i) => i.id)).toEqual(["drift", "models"]);
    // A better match still wins over a recent one.
    expect(rank(items, "models", ["drift"]).map((i) => i.id)).toEqual(["models"]);
    expect(rank(items, "o", ["tools"]).map((i) => i.id)).toEqual(["overview", "tools", "models", "drift"]);
    const twins = [
      { id: "a", label: "Sessions" },
      { id: "b", label: "Sessions" },
    ];
    expect(rank(twins, "sess", ["b"]).map((i) => i.id)).toEqual(["b", "a"]);
  });
  test("empty query: recent first, then the rest in order", () => {
    expect(rank(items, "", ["tools", "drift"]).map((i) => i.id)).toEqual(["tools", "drift", "overview", "models"]);
  });
  test("fuzzy can be turned off", () => {
    expect(rank(items, "mdr").map((i) => i.id)).toEqual(["drift"]);
    expect(rank(items, "mdr", [], false)).toEqual([]);
  });
});

describe("pushRecent", () => {
  test("moves to the front, no duplicates, capped", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });
});

describe("highlight", () => {
  test("marks the matching part of the original text", () => {
    expect(highlight("Model drift", "drift")).toEqual([
      { text: "Model ", hit: false },
      { text: "drift", hit: true },
    ]);
  });
  test("maps accent-free matches back onto accented text", () => {
    expect(highlight("Źródło danych", "zrodlo")).toEqual([
      { text: "Źródło", hit: true },
      { text: " danych", hit: false },
    ]);
    // ß folds to two letters: the match still covers the one character.
    expect(matchRanges("Straße", "strasse")).toEqual([[0, 6]]);
  });
  test("several words, merged where they touch", () => {
    expect(matchRanges("Last 7 days", "last 7")).toEqual([
      [0, 4],
      [5, 6],
    ]);
    expect(matchRanges("abcdef", "abc bcd")).toEqual([[0, 4]]);
  });
  test("fuzzy matches mark single letters", () => {
    expect(matchRanges("Model drift", "mdr")).toEqual([
      [0, 1],
      [2, 3],
      [7, 8],
    ]);
  });
  test("no query, no highlight", () => {
    expect(highlight("Tools", "")).toEqual([{ text: "Tools", hit: false }]);
  });
});

describe("shortcuts", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  test("Ctrl+K and Cmd+K open the palette, also while typing", () => {
    expect(shortcutOf(key("k", { ctrlKey: true }), false)).toBe("palette");
    expect(shortcutOf(key("K", { metaKey: true }), true)).toBe("palette");
    expect(shortcutOf(key("k", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(shortcutOf(key("k"), false)).toBeNull();
  });
  test("/ and ? only when not typing", () => {
    expect(shortcutOf(key("/"), false)).toBe("search");
    expect(shortcutOf(key("?"), false)).toBe("help");
    expect(shortcutOf(key("/"), true)).toBeNull();
    expect(shortcutOf(key("?"), true)).toBeNull();
    expect(shortcutOf(key("/", { ctrlKey: true }), false)).toBeNull();
  });
  test("what counts as typing", () => {
    expect(isEditable({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isEditable({ tagName: "input" })).toBe(true);
    expect(isEditable({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isEditable({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditable({ tagName: "SELECT" })).toBe(true);
    expect(isEditable({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditable({ tagName: "BUTTON" })).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe("snippet", () => {
  test("short or early matches stay whole", () => {
    expect(snippet("Fix the  login\nbug", "login")).toBe("Fix the login bug");
  });
  test("a late match is brought into view, cut at a word", () => {
    const text = "Please look at the whole configuration of the service and then find the retention setting";
    const s = snippet(text, "retention");
    expect(s.startsWith("…")).toBe(true);
    expect(s).toContain("retention setting");
    expect(s.length).toBeLessThan(text.length);
    expect(s.slice(1, 2)).not.toBe(" ");
  });
});

describe("modKey", () => {
  test("Apple systems get ⌘", () => {
    expect(modKey("MacIntel")).toBe("⌘");
    expect(modKey("iPhone")).toBe("⌘");
    expect(modKey("Linux x86_64")).toBe("Ctrl");
    expect(modKey("Win32")).toBe("Ctrl");
  });
});

describe("fuzzy limits", () => {
  test("starts at a word and stays close together", () => {
    expect(score("Model drift", "mdr", { fuzzy: true })).toBeGreaterThan(0);
    expect(score("Language: Deutsch", "auth", { fuzzy: true })).toBe(0);
    expect(score("Overview", "ovw", { fuzzy: true })).toBeGreaterThan(0);
  });
});
