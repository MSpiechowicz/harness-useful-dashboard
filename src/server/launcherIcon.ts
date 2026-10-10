import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import icns from "../../assets/icons/harness-dashboard.icns" with { type: "file" };
import ico from "../../assets/icons/harness-dashboard.ico" with { type: "file" };
import svg from "../../assets/icons/harness-dashboard.svg" with { type: "file" };
import { BIN_NAME } from "../version.ts";

export interface LauncherIconEnv {
  platform: NodeJS.Platform;
  home: string;
  dataHome: string;
  /** Folder of the installed binary, where the Windows installer puts the Start menu shortcut's icon. */
  binDir: string;
}

/** Where the installer put the launcher's icon on this OS, and the icon this binary carries for it. */
export function launcherIconTarget(env: LauncherIconEnv): { path: string; source: string } | null {
  if (env.platform === "linux") return { path: join(env.dataHome, "icons", "hicolor", "scalable", "apps", `${BIN_NAME}.svg`), source: svg };
  if (env.platform === "darwin") return { path: join(env.home, "Applications", "Harness Dashboard.app", "Contents", "Resources", "AppIcon.icns"), source: icns };
  if (env.platform === "win32") return { path: join(env.binDir, `${BIN_NAME}.ico`), source: ico };
  return null;
}

/**
 * The installer copies the app icon next to the launcher once, and an update replaces only the binary, so the
 * applications menu and taskbar kept the icon of the first install. On start the icon is replaced with the one this
 * binary carries when they differ. Only an icon the installer added is touched. Returns true when it was replaced.
 */
export function refreshLauncherIcon(env: LauncherIconEnv = {
  platform: process.platform,
  home: homedir(),
  dataHome: process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  binDir: dirname(process.execPath.replace(/ \(deleted\)$/, "")),
}): boolean {
  const target = launcherIconTarget(env);
  if (!target || !existsSync(target.path)) return false;
  try {
    const icon = readFileSync(target.source);
    if (readFileSync(target.path).equals(icon)) return false;
    writeFileSync(target.path, icon);
    if (env.platform === "linux") refreshLinuxIconCaches(dirname(dirname(dirname(target.path))));
    // Finder and the Dock read an app's icon again once its bundle is newer.
    if (env.platform === "darwin") utimesSync(dirname(dirname(dirname(target.path))), new Date(), new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Desktops cache icons by name. KDE drops its cache when an icon folder is newer than it. As in install.sh, an existing
 * GTK cache is rebuilt but never created, since a cache nothing else keeps up to date would hide icons other apps add.
 */
function refreshLinuxIconCaches(theme: string): void {
  const now = new Date();
  for (const dir of [theme, dirname(theme)]) utimesSync(dir, now, now);
  const gtk = Bun.which("gtk-update-icon-cache");
  if (gtk && existsSync(join(theme, "icon-theme.cache"))) Bun.spawnSync([gtk, "-q", "-t", theme], { stdio: ["ignore", "ignore", "ignore"], timeout: 10_000 });
}
