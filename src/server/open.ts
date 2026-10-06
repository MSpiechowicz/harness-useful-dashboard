import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenMode } from "../core/config.ts";
import { appDataDir } from "../core/paths.ts";

/** Chromium-based browsers support `--app=<url>`, which gives a chrome-less, app-like window. */
function findAppBrowser(): string | null {
  if (process.platform === "darwin") {
    // App bundles, started through LaunchServices (see openUi).
    const apps = [
      "/Applications/Google Chrome.app",
      "/Applications/Chromium.app",
      "/Applications/Microsoft Edge.app",
      "/Applications/Brave Browser.app",
      "/Applications/Vivaldi.app",
    ];
    return apps.find((p) => existsSync(p)) ?? null;
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean) as string[];
    const rel = [
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Google\\Chrome\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    for (const r of rel) for (const root of roots) if (existsSync(join(root, r))) return join(root, r);
    return null;
  }
  const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge-stable", "microsoft-edge", "brave-browser", "brave", "vivaldi-stable"];
  for (const n of names) {
    const p = Bun.which(n);
    if (p) return p;
  }
  return null;
}

function openDefaultBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

export function openUi(url: string, mode: OpenMode): "app" | "browser" | "none" {
  if (mode === "none") return "none";
  if (mode === "app") {
    const browser = findAppBrowser();
    if (browser) {
      const profile = join(appDataDir(), "window-profile");
      mkdirSync(profile, { recursive: true });
      const flags = [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"];
      // On macOS the browser is started by LaunchServices, as a Dock launch would: run as our child it inherits our
      // launch context, which runs a universal browser under Rosetta when we were started from the app bundle, and
      // makes it crash and hang. -n starts a new instance, so the flags apply even while the browser is already open.
      const cmd = process.platform === "darwin" ? ["open", "-n", "-a", browser, "--args", ...flags] : [browser, ...flags];
      Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
      return "app";
    }
  }
  openDefaultBrowser(url);
  return "browser";
}
