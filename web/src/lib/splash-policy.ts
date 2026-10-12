/**
 * Whether the launch splash plays: only when the viewer has the intro on, once per tab session, never under
 * reduced motion or in a hidden tab. The viewer's choices live in the browser, like the theme.
 */
const KEY = "hd.splash";

export const INTRO_KEY = "hd.intro";
export const INTRO_SOUND_KEY = "hd.introSound";

export interface IntroPrefs {
  /** Whether the intro plays when the dashboard opens. On by default. */
  enabled: boolean;
  /** Whether the logo's sound plays with the intro. Off by default. */
  sound: boolean;
}

/** The saved intro choices, with the defaults for anything unset, unreadable or in a blocked storage. */
export function readIntroPrefs(storage: Pick<Storage, "getItem"> | null): IntroPrefs {
  const prefs: IntroPrefs = { enabled: true, sound: false };
  if (!storage) return prefs;

  try {
    prefs.enabled = storage.getItem(INTRO_KEY) !== "false";
    prefs.sound = storage.getItem(INTRO_SOUND_KEY) === "true";
  } catch {
    return { enabled: true, sound: false };
  }

  return prefs;
}

export function shouldShowSplash(opts: {
  enabled: boolean;
  reducedMotion: boolean;
  hidden: boolean;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): boolean {
  if (!opts.enabled || opts.reducedMotion || opts.hidden || !opts.storage) return false;

  try {
    if (opts.storage.getItem(KEY)) return false;
    opts.storage.setItem(KEY, "1");
  } catch {
    return false;
  }

  return true;
}
