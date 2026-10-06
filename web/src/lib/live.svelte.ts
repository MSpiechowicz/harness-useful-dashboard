import { loadColorRanking } from "./colors.svelte.ts";
import { getJson, type Status } from "./api.svelte.ts";
import { store } from "./state.svelte.ts";

type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "scan"; result: { usageRows: number; prompts: number } }
  | { type: "scanning"; done: number; total: number }
  | { type: "db-changed" }
  | { type: "pricing-changed" };

// New data from the background scan refreshes the open view at most once a minute, so pages don't keep reloading
// while an agent works. The Live page polls on its own, more often.
const REFRESH_MS = 60_000;

class Live {
  connected = $state(false);
  scanning = $state<{ done: number; total: number } | null>(null);
  status = $state<Status | null>(null);
  /** When a scan last found new usage or prompts: the Live menu item animates for a while after. */
  lastDataAt = $state<number | null>(null);
  private version: string | null = null;
  /** When the open view last reloaded its data: the sidebar shows it as "Updated at". */
  updatedAt = $state<number | null>(null);
  private pending: ReturnType<typeof setTimeout> | null = null;

  /** Reloads the open view's data now. */
  private refresh(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.updatedAt = Date.now();
    store.refreshTick++;
    void loadColorRanking();
  }

  /** Reloads it now, or once a minute has passed since the last reload. */
  private refreshSoon(): void {
    if (this.pending) return;
    const wait = (this.updatedAt ?? 0) + REFRESH_MS - Date.now();
    if (wait <= 0) this.refresh();
    else this.pending = setTimeout(() => this.refresh(), wait);
  }

  start(): void {
    getJson<Status>("/api/status")
      .then((s) => {
        this.status = s;
        this.version = s.version;
        this.updatedAt ??= Date.now();
      })
      .catch(() => {});

    const es = new EventSource("/api/events");
    es.onopen = () => (this.connected = true);
    es.onerror = () => (this.connected = false);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as ServerEvent;
      switch (e.type) {
        case "hello":
          // The server restarted with a different binary (self-update): load the new UI.
          if (this.version && e.version !== this.version) location.reload();
          this.version = e.version;
          break;
        case "scanning":
          this.scanning = e.done < e.total ? { done: e.done, total: e.total } : null;
          break;
        case "scan":
          this.scanning = null;
          if (e.result.usageRows > 0 || e.result.prompts > 0) {
            this.lastDataAt = Date.now();
            this.refreshSoon();
          }
          break;
        case "db-changed":
        case "pricing-changed":
          // A change made in Settings: show it right away.
          this.refresh();
          getJson<Status>("/api/status").then((s) => (this.status = s)).catch(() => {});
          break;
      }
    };
  }
}

export const live = new Live();
