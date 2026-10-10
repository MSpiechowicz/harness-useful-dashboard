import { describe, expect, test } from "bun:test";
import { shouldShowSplash } from "../web/src/lib/splash-policy.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

describe("launch splash policy", () => {
  test("shows once per session", () => {
    const storage = memoryStorage();
    const opts = { reducedMotion: false, hidden: false, storage };

    expect(shouldShowSplash(opts)).toBe(true);
    expect(shouldShowSplash(opts)).toBe(false);
  });

  test("does not play under reduced motion and leaves the session unmarked", () => {
    const storage = memoryStorage();

    expect(shouldShowSplash({ reducedMotion: true, hidden: false, storage })).toBe(false);
    expect(shouldShowSplash({ reducedMotion: false, hidden: false, storage })).toBe(true);
  });

  test("does not play in a hidden tab and leaves the session unmarked", () => {
    const storage = memoryStorage();

    expect(shouldShowSplash({ reducedMotion: false, hidden: true, storage })).toBe(false);
    expect(shouldShowSplash({ reducedMotion: false, hidden: false, storage })).toBe(true);
  });

  test("does not play when storage throws or is missing", () => {
    expect(shouldShowSplash({ reducedMotion: false, hidden: false, storage: throwingStorage })).toBe(false);
    expect(shouldShowSplash({ reducedMotion: false, hidden: false, storage: null })).toBe(false);
  });
});
