import { getJson, send, type UpdateStatus } from "./api.svelte.ts";
import { t } from "./i18n.svelte.ts";
import { RESTART_POLL_MS, restartDone, type RestartProbe } from "./restart.ts";
import { everyWhileVisible, waitOrVisible } from "./visibility.ts";

/** How often the app asks whether a newer release is out (the server answers from its cache within the hour). */
const RECHECK_MS = 3600_000;

/**
 * Update state shared by the sidebar banner and Settings, so a check from either one (and the hourly one) shows
 * in both, and both offer the install.
 */
export const updater = $state<{ status: UpdateStatus | null; installing: boolean; message: string | null }>({
  status: null,
  installing: false,
  message: null,
});

let watching = false;

/** Checks now and then every hour, once per page. A hidden tab checks once it is shown again. */
export function watchUpdates(): void {
  if (watching) return;
  watching = true;
  void checkUpdate();
  everyWhileVisible(RECHECK_MS, () => void checkUpdate());
}

/** `force` skips the server's cache and asks GitHub, even when automatic checks are off (Settings → Check now). */
export async function checkUpdate(force = false): Promise<void> {
  try {
    updater.status = await getJson<UpdateStatus>(`/api/update${force ? "?force=1" : ""}`);
  } catch {
    /* offline: keep what we knew */
  }
}

export async function installUpdate(): Promise<void> {
  updater.installing = true;
  updater.message = null;
  try {
    const r = await send<{ restarting: boolean }>("/api/update");
    if (r.restarting) {
      updater.message = t("update.restarting");
      void reloadWhenRestarted(updater.status?.current ?? "");
    }
  } catch (e) {
    updater.message = t("update.failed", { error: (e as Error).message });
    updater.installing = false;
  }
}

/**
 * Loads the page again once the updated server is up. The live stream does that too when it reconnects, but not when
 * the new server refuses it, so this doesn't depend on it. It keeps asking in a hidden tab too, and asks right away
 * when the tab is shown again.
 */
async function reloadWhenRestarted(from: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    await waitOrVisible(RESTART_POLL_MS);
    let probe: RestartProbe = null;
    try {
      const res = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(RESTART_POLL_MS * 3) });
      const body = (await res.json().catch(() => ({}))) as { version?: string };
      probe = { status: res.status, version: body.version };
    } catch {
      /* nothing listens yet */
    }
    if (restartDone(probe, from, Date.now() - started)) return location.reload();
  }
}
