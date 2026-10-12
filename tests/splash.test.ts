import { describe, expect, test } from "bun:test";
import { INTRO_KEY, INTRO_SOUND_KEY, readIntroPrefs, shouldShowSplash } from "../web/src/lib/splash-policy.ts";

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
    const opts = { enabled: true, reducedMotion: false, hidden: false, storage };

    expect(shouldShowSplash(opts)).toBe(true);
    expect(shouldShowSplash(opts)).toBe(false);
  });

  test("does not play under reduced motion and leaves the session unmarked", () => {
    const storage = memoryStorage();

    expect(shouldShowSplash({ enabled: true, reducedMotion: true, hidden: false, storage })).toBe(false);
    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: false, storage })).toBe(true);
  });

  test("does not play in a hidden tab and leaves the session unmarked", () => {
    const storage = memoryStorage();

    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: true, storage })).toBe(false);
    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: false, storage })).toBe(true);
  });

  test("does not play when storage throws or is missing", () => {
    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: false, storage: throwingStorage })).toBe(false);
    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: false, storage: null })).toBe(false);
  });

  test("does not play when the intro is off and leaves the session unmarked", () => {
    const storage = memoryStorage();

    expect(shouldShowSplash({ enabled: false, reducedMotion: false, hidden: false, storage })).toBe(false);
    expect(shouldShowSplash({ enabled: true, reducedMotion: false, hidden: false, storage })).toBe(true);
  });
});

describe("intro preferences", () => {
  test("the intro is on and silent until chosen otherwise", () => {
    expect(readIntroPrefs(memoryStorage())).toEqual({ enabled: true, sound: false });
    expect(readIntroPrefs(null)).toEqual({ enabled: true, sound: false });
  });

  test("reads what the viewer saved", () => {
    const storage = memoryStorage();
    storage.setItem(INTRO_KEY, "false");
    storage.setItem(INTRO_SOUND_KEY, "true");

    expect(readIntroPrefs(storage)).toEqual({ enabled: false, sound: true });
  });

  test("ignores values it does not know and falls back when storage throws", () => {
    const storage = memoryStorage();
    storage.setItem(INTRO_KEY, "maybe");
    storage.setItem(INTRO_SOUND_KEY, "1");

    expect(readIntroPrefs(storage)).toEqual({ enabled: true, sound: false });
    expect(readIntroPrefs(throwingStorage)).toEqual({ enabled: true, sound: false });
  });
});
