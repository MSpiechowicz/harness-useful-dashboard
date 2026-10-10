import "./brand/harness-logo.js";
import { shouldShowSplash } from "./splash-policy.ts";

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

/** The launch animation over the app. It covers the blank moment before the first paint and never delays the mount. */
export function showSplash(): void {
  const play = shouldShowSplash({
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    hidden: document.hidden,
    storage: sessionStorageOrNull(),
  });
  if (!play) return;

  const overlay = document.createElement("div");
  overlay.className = "splash";
  overlay.setAttribute("aria-hidden", "true");

  const logo = document.createElement("harness-logo");
  logo.setAttribute("version", "short");
  logo.setAttribute("autoplay", "");
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
}
