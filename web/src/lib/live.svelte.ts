import { loadColorRanking } from "./colors.svelte.ts";
import { getJson, type Status } from "./api.svelte.ts";
import { store } from "./state.svelte.ts";

type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "scan"; result: { usageRows: number; prompts: number } }
  | { type: "scanning"; done: number; total: number }
  | { type: "db-changed" }
  | { type: "pricing-changed" };

class Live {
  connected = $state(false);
  scanning = $state<{ done: number; total: number } | null>(null);
  lastScanAt = $state<number | null>(null);
  status = $state<Status | null>(null);
  private version: string | null = null;

  start(): void {
    getJson<Status>("/api/status")
      .then((s) => {
        this.status = s;
        this.version = s.version;
        this.lastScanAt = s.lastScanAt;
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
          this.lastScanAt = Date.now();
          if (e.result.usageRows > 0 || e.result.prompts > 0) {
            store.refreshTick++;
            void loadColorRanking();
          }
          break;
        case "db-changed":
        case "pricing-changed":
          store.refreshTick++;
          void loadColorRanking();
          getJson<Status>("/api/status").then((s) => (this.status = s)).catch(() => {});
          break;
      }
    };
  }
}

export const live = new Live();
