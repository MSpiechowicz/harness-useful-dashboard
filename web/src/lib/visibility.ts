/**
 * Runs `fn` every `ms` while the tab is visible. A hidden tab skips its turns and makes no requests: once shown
 * again it runs `fn` right away, if a turn was skipped. Returns the function that stops it (an `$effect` cleanup).
 */
export function everyWhileVisible(ms: number, fn: () => void): () => void {
  let missed = false;
  const h = setInterval(() => {
    if (document.hidden) missed = true;
    else fn();
  }, ms);
  const onVisible = () => {
    if (document.hidden || !missed) return;
    missed = false;
    fn();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(h);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * Like `everyWhileVisible`, but each turn comes `lagMs` after a clock minute starts, so a per-minute count asked for
 * then has the minute before it complete. Returns the function that stops it.
 */
export function everyMinuteWhileVisible(fn: () => void, lagMs = 3_000): () => void {
  let missed = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = () => {
    const now = Date.now();
    timer = setTimeout(turn, 60_000 - ((now - lagMs) % 60_000));
  };
  const turn = () => {
    try {
      if (document.hidden) missed = true;
      else fn();
    } finally {
      schedule();
    }
  };
  const onVisible = () => {
    if (document.hidden || !missed) return;
    missed = false;
    fn();
  };
  schedule();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
