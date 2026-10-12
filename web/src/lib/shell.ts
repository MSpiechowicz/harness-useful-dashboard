import { Channel, invoke } from "@tauri-apps/api/core";

/** A newer release the app's updater found. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
}

/** One step of an update being installed. `total` is null while the download size is unknown. */
export interface UpdateProgress {
  phase: "downloading" | "installing" | "done";
  downloaded: number;
  total: number | null;
}

/** Whether the page runs inside the Harness Dashboard app (its Tauri window) rather than in a browser. */
export function isShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The newer release the app's updater found, or null when this one is the latest. */
export function checkShellUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("update_check");
}

/** Downloads and installs the update found by the last check, reporting each step. Resolves once it is installed. */
export function installShellUpdate(onProgress: (progress: UpdateProgress) => void): Promise<void> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke<void>("update_install", { onProgress: channel });
}

/** Restarts the app, which stops the dashboard server first. */
export function relaunch(): Promise<void> {
  return invoke<void>("app_relaunch");
}

/**
 * Starts or stops the launch sound in the app, which plays it natively: the webview blocks web audio until a gesture.
 * It never fails the caller, the sound is a nicety.
 */
export async function launchSound(play: boolean): Promise<void> {
  try {
    await invoke<void>("launch_sound", { play });
  } catch {
    /* no sound is fine */
  }
}
