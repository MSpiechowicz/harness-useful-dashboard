import "./brand/harness-logo.js";
import { isShell, launchSound } from "./shell.ts";
import { readIntroPrefs, shouldShowSplash } from "./splash-policy.ts";

const SETTLE_MS = 150;
const FADE_MS = 250;
const MAX_MS = 3500;

function sessionStorageOrNull(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function localStorageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The launch animation over the app. It covers the blank moment before the first paint and never delays the mount. */
export function showSplash(): void {
  const prefs = readIntroPrefs(localStorageOrNull());
  const play = shouldShowSplash({
    enabled: prefs.enabled,
    reducedMotion: prefersReducedMotion(),
    hidden: document.hidden,
    storage: sessionStorageOrNull(),
  });
  if (!play) return;

  playSplash(prefs.sound);
}

/** Plays the intro now, whatever the intro setting and whether it already played this session. Not under reduced motion. */
export function replaySplash(): void {
  if (prefersReducedMotion() || document.querySelector(".splash")) return;

  playSplash(readIntroPrefs(localStorageOrNull()).sound);
}

function playSplash(withSound: boolean): void {
  const overlay = document.createElement("div");
  overlay.className = "splash";
  overlay.setAttribute("aria-hidden", "true");

  const logo = document.createElement("harness-logo");
  logo.setAttribute("version", "short");
  logo.setAttribute("autoplay", "");
  // In a browser the logo fetches its sound itself and stays silent when it is blocked or fails, so the app never
  // waits for it. The app's webview blocks web audio before a gesture, so the app plays the sound natively instead.
  const native = isShell();
  if (withSound && !native) {
    logo.setAttribute("sound", "");
    logo.setAttribute("sound-url", "/brand/sound.wav");
  }
  logo.style.width = "160px";
  overlay.append(logo);
  document.body.append(overlay);

  const timers: ReturnType<typeof setTimeout>[] = [];
  const remove = () => {
    timers.forEach(clearTimeout);
    logo.removeEventListener("finish", onFinish);
    overlay.removeEventListener("click", skip);
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const skip = () => {
    if (native && withSound) void launchSound(false);
    const player = logo as { skip?: unknown };
    if (typeof player.skip === "function") player.skip();
    else remove();
  };
  // Capture phase, so Escape closes the splash without also reaching app handlers underneath.
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !overlay.isConnected) return;
    event.stopPropagation();
    skip();
  };

  function onFinish() {
    timers.push(
      setTimeout(() => {
        overlay.classList.add("is-leaving");
        timers.push(setTimeout(remove, FADE_MS));
      }, SETTLE_MS),
    );
  }

  logo.addEventListener("finish", onFinish, { once: true });
  overlay.addEventListener("click", skip);
  window.addEventListener("keydown", onKey, true);
  timers.push(setTimeout(remove, MAX_MS));
  if (native && withSound) void launchSound(true);
}
