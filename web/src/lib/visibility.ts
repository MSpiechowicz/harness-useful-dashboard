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

/** Resolves after `ms`, or as soon as a hidden tab is shown again (browsers slow down timers in hidden tabs). */
export function waitOrVisible(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(h);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => {
      if (!document.hidden) done();
    };
    const h = setTimeout(done, ms);
    document.addEventListener("visibilitychange", onVisible);
  });
}
