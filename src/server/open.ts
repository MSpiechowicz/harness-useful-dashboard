import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

/**
 * Whether a browser already runs on the window profile. Chromium marks its profile with a `SingletonLock` link to
 * "<host>-<pid>", which it removes when it quits. A crash leaves it behind, so the process must still be alive.
 */
export function profileInUse(profile: string): boolean {
  let lock: string;
  try {
    lock = readlinkSync(join(profile, "SingletonLock"));
  } catch {
    return false;
  }
  const pid = Number(lock.slice(lock.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The command that opens `url` in an app window of `browser` on `profile`. */
export function appWindowCommand(browser: string, url: string, profile: string, running: boolean, platform = process.platform): string[] {
  const flags = [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1440,920"];
  if (platform !== "darwin") return [browser, ...flags];
  // A browser that starts here is started by LaunchServices, as a Dock launch would: run as our child it inherits our
  // launch context, which runs a universal browser under Rosetta when we were started from the app bundle, and makes
  // it crash and hang. -n starts a new instance, so the flags apply even while the browser is open on another profile.
  if (!running) return ["open", "-n", "-a", browser, "--args", ...flags];
  // Already running on the window profile: the browser binary only hands the flags to that instance and quits, and
  // the instance opens the window. Through LaunchServices the instance can also get a reopen event, which a browser
  // whose only windows are app windows answers with an extra, empty browser window. arch picks the native build even
  // under Rosetta.
  return ["arch", "-arm64", "-x86_64", join(browser, "Contents", "MacOS", basename(browser, ".app")), ...flags];
}

export function openUi(url: string, mode: OpenMode): "app" | "browser" | "none" {
  if (mode === "none") return "none";
  if (mode === "app") {
    const browser = findAppBrowser();
    if (browser) {
      const profile = join(appDataDir(), "window-profile");
      mkdirSync(profile, { recursive: true });
      linkWindowToLauncher(browser, url);
      const cmd = appWindowCommand(browser, url, profile, process.platform === "darwin" && profileInUse(profile));
      Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] }).unref();
      return "app";
    }
  }
  openDefaultBrowser(url);
  return "browser";
}
