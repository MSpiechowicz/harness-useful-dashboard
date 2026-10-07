import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, posix } from "node:path";
import type { OpenMode } from "../core/config.ts";
import { appDataDir } from "../core/paths.ts";

/** Chromium-based browsers support `--app=<url>`, which gives a chrome-less, app-like window. */
function findAppBrowser(): string | null {
  if (process.platform === "darwin") {
    // App bundles, started through LaunchServices (see appWindowCommand).
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

/** The app ID a Chromium browser gives an `--app` window on Linux: "<browser>-<host>__-<profile>". */
export function appWindowId(browser: string, url: string): string {
  const name = basename(browser);
  const prefix = name.startsWith("google-chrome")
    ? "chrome"
    : name.startsWith("microsoft-edge")
      ? "msedge"
      : name.startsWith("brave")
        ? "brave"
        : name.startsWith("vivaldi")
          ? "vivaldi"
          : "chromium";
  return `${prefix}-${new URL(url).hostname}__-Default`;
}

/**
 * Wayland desktops find a window's icon through the launcher named after its app ID. The app window's ID is the
 * browser's (see appWindowId), which no launcher claims, so it would get a generic icon. A hidden launcher under that
 * name, pointing at the app's icon, fixes the window's title bar and taskbar entry. Only when the installer added the
 * app to the applications menu.
 */
export function linkWindowToLauncher(browser: string, url: string, dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")): boolean {
  if (process.platform !== "linux") return false;
  const apps = join(dataHome, "applications");
  const main = join(apps, "harness-dashboard.desktop");
  if (!existsSync(main)) return false;
  const exec = /^Exec=(.*)$/m.exec(readFileSync(main, "utf8"))?.[1] ?? "harness-dashboard";
  const alias = join(apps, `${appWindowId(browser, url)}.desktop`);
  const entry = `[Desktop Entry]\nType=Application\nName=Harness Dashboard\nExec=${exec}\nIcon=harness-dashboard\nNoDisplay=true\n`;
  try {
    if (existsSync(alias) && readFileSync(alias, "utf8") === entry) return false;
    writeFileSync(alias, entry);
    // KDE reads launchers from its own cache: rebuild it before the window opens, so even the first one has the icon.
    for (const tool of ["kbuildsycoca6", "kbuildsycoca5", "update-desktop-database"]) {
      const bin = Bun.which(tool);
      if (bin) Bun.spawnSync(tool.startsWith("update") ? [bin, apps] : [bin], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
    }
    return true;
  } catch {
    return false;
  }
}

function openDefaultBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

/** The command that opens `url` in an app window of `browser` on `profile`. */
export function appWindowCommand(browser: string, url: string, profile: string, platform = process.platform): string[] {
  const flags = [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"];
  if (platform !== "darwin") return [browser, ...flags];
  // On macOS the browser binary is started directly, never through LaunchServices (`open -a`): a launch through it
  // sends the browser an open or reopen event, which it answers with an ordinary, empty browser window next to the app
  // window, on a cold start and when its instance is already running alike. Started directly it opens the app window
  // only, or hands the flags to the running instance and quits. arch picks the native build: run as our child under
  // Rosetta (started from the app bundle), a universal browser would otherwise run translated and crash or hang.
  // A macOS path, built the same way wherever the command is built (tests run on Windows too).
  return ["arch", "-arm64", "-x86_64", posix.join(browser, "Contents", "MacOS", posix.basename(browser, ".app")), ...flags];
}

export function openUi(url: string, mode: OpenMode): "app" | "browser" | "none" {
  if (mode === "none") return "none";
  if (mode === "app") {
    const browser = findAppBrowser();
    if (browser) {
      const profile = join(appDataDir(), "window-profile");
      mkdirSync(profile, { recursive: true });
      linkWindowToLauncher(browser, url);
      // Detached: the browser outlives this process, which exits after opening it when the dashboard already runs.
      Bun.spawn(appWindowCommand(browser, url, profile), { stdio: ["ignore", "ignore", "ignore"], detached: true }).unref();
      return "app";
    }
  }
  openDefaultBrowser(url);
  return "browser";
}
