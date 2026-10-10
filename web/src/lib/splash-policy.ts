/** Whether the launch splash plays: once per tab session, never under reduced motion or in a hidden tab. */
const KEY = "hd.splash";

export function shouldShowSplash(opts: {
  reducedMotion: boolean;
  hidden: boolean;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
}): boolean {
  if (opts.reducedMotion || opts.hidden || !opts.storage) return false;

  try {
    if (opts.storage.getItem(KEY)) return false;
    opts.storage.setItem(KEY, "1");
  } catch {
    return false;
  }

  return true;
}
