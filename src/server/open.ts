import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenMode } from "../core/config.ts";
import { appDataDir } from "../core/paths.ts";

/** Chromium-based browsers support `--app=<url>`, which gives a chrome-less, app-like window. */
function findAppBrowser(): string | null {
  if (process.platform === "darwin") {
    const apps = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
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
      Bun.spawn(
        [browser, `--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"],
        { stdio: ["ignore", "ignore", "ignore"] },
      ).unref();
      return "app";
    }
  }
  openDefaultBrowser(url);
  return "browser";
}
