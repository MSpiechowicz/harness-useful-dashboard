import { getJson, type UpdateStatus } from "./api.svelte.ts";
import { t } from "./i18n.svelte.ts";
import { checkShellUpdate, installShellUpdate, isShell, relaunch, type UpdateProgress } from "./shell.ts";
import { everyWhileVisible } from "./visibility.ts";

/** How often the app asks whether a newer release is out (the server asks GitHub at most every 5 minutes too). */
const RECHECK_MS = 5 * 60_000;
const RELEASE_URL = "https://github.com/MSpiechowicz/harness-useful-dashboard/releases/tag/v";

/**
 * Update state shared by the sidebar banner and Settings, so a check from either one (and the regular one) shows
 * in both, and both offer the install. In the app the updater installs and restarts it; in a browser a newer
 * release is only announced, with a link to download it.
 */
export const updater = $state<{ status: UpdateStatus | null; installing: boolean; message: string | null; progress: UpdateProgress | null }>({
  status: null,
  installing: false,
  message: null,
  progress: null,
});

/** The version whose banner was sent away with "Later". The next release brings the banner back. */
export const snooze = $state<{ version: string | null }>({ version: null });

let watching = false;

/** Checks now and then every 5 minutes, once per page. A hidden tab checks once it is shown again. */
export function watchUpdates(): void {
  if (watching) return;
  watching = true;
  void checkUpdate();
  everyWhileVisible(RECHECK_MS, () => void checkUpdate());
}

/** `force` skips the server's cache and asks GitHub, even when automatic checks are off (Settings → Check now). */
export async function checkUpdate(force = false): Promise<void> {
  if (isShell()) return checkShell(force);

  try {
    updater.status = await getJson<UpdateStatus>(`/api/update${force ? "?force=1" : ""}`);
  } catch {
    /* offline: keep what we knew */
  }
}

/** The app's updater asks for itself, so the server's setting is read here: automatic checks honor it, a forced one doesn't. */
async function checkShell(force: boolean): Promise<void> {
  if (updater.installing) return;
  if (!force && !(await automaticChecks())) return;

  const current = updater.status?.current ?? "";
  try {
    const info = await checkShellUpdate();
    updater.status = info
      ? { current: info.currentVersion, latest: info.version, available: true, releaseUrl: RELEASE_URL + info.version, notes: info.notes }
      : { current, latest: null, available: false, releaseUrl: null, notes: null };
  } catch (e) {
    // A quiet check that fails (offline) says nothing. One the user asked for says why.
    if (force) updater.status = { current, latest: null, available: false, releaseUrl: null, notes: null, error: errorText(e) };
  }
}

async function automaticChecks(): Promise<boolean> {
  try {
    return (await getJson<{ checkUpdates: boolean }>("/api/settings")).checkUpdates;
  } catch {
    return false;
  }
}

/** Downloads and installs the update in the app, then restarts it. */
export async function installUpdate(): Promise<void> {
  if (!isShell()) return;

  updater.installing = true;
  updater.message = null;
  updater.progress = null;
  try {
    await installShellUpdate((p) => (updater.progress = p));
    updater.message = t("update.restarting");
    await relaunch();
  } catch (e) {
    updater.message = t("update.failed", { error: errorText(e) });
    updater.installing = false;
    updater.progress = null;
  }
}

/** What the install is doing now, for the banner and Settings. */
export function installText(): string {
  if (updater.progress?.phase !== "downloading") return t("update.installing");

  const fraction = downloadFraction();
  if (fraction === null) return t("update.downloading");
  return t("update.downloadingPercent", { percent: Math.round(fraction * 100) });
}

/** How much of the download is done (0 to 1), or null while the size is unknown. */
export function downloadFraction(): number | null {
  const p = updater.progress;
  if (p?.phase !== "downloading" || !p.total) return null;
  return Math.min(1, p.downloaded / p.total);
}

/** A failed command rejects with a plain string or an error object. */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : t("update.unknownError");
}
