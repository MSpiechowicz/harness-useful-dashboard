/** How often a window waiting for the updated server asks whether it is back. */
export const RESTART_POLL_MS = 1000;

/**
 * How long it waits at most. The first start of a new version can update a large database before it listens, but
 * after this long the page is loaded again anyway, so it never stays on "Restarting…".
 */
export const RESTART_GIVE_UP_MS = 120_000;

/** One answer from `/api/status` while waiting: null when nothing listened or the request failed. */
export type RestartProbe = { status: number; version?: string } | null;

/**
 * Whether a window waiting for the server to restart after an update should load the page again now. Yes once the
 * new version answers, or a server answers that doesn't know this window (401: the page then says it isn't signed
 * in), or the wait is over. The old server keeps answering for a moment after it said it restarts.
 */
export function restartDone(probe: RestartProbe, from: string, waitedMs: number): boolean {
  if (waitedMs >= RESTART_GIVE_UP_MS) return true;
  if (!probe) return false;
  if (probe.status === 401) return true;
  return probe.status === 200 && !!from && !!probe.version && probe.version !== from;
}
