import { getJson, send, type UpdateStatus } from "./api.svelte.ts";
import { t } from "./i18n.svelte.ts";

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

/** Checks now and then every hour, once per page. */
export function watchUpdates(): void {
  if (watching) return;
  watching = true;
  void checkUpdate();
  setInterval(() => void checkUpdate(), RECHECK_MS);
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
    if (r.restarting) updater.message = t("update.restarting");
  } catch (e) {
    updater.message = t("update.failed", { error: (e as Error).message });
    updater.installing = false;
  }
}
