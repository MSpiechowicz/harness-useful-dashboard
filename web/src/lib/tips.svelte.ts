import { getJson, send, type Tip } from "./api.svelte.ts";

export type TipStatus = "active" | "read" | "hidden";

interface TipState {
  hidden: string[];
  read: string[];
}

/**
 * Which tips the user put away, kept in the app's config so it survives restarts and browsers. Hiding works on the
 * rule (a tip id), marking read on what the tip is about (its key): a new spike day or another prompt shows as new.
 * Changes apply at once and are saved in the background.
 */
class TipStore {
  hidden = $state<Set<string>>(new Set());
  read = $state<Set<string>>(new Set());
  loaded = $state(false);

  constructor() {
    if (typeof window === "undefined") return;
    getJson<TipState>("/api/tips/state")
      .then((s) => this.set(s))
      .catch(() => {})
      .finally(() => (this.loaded = true));
  }

  private set(s: TipState): void {
    this.hidden = new Set(s.hidden);
    this.read = new Set(s.read);
  }

  status(tip: Tip): TipStatus {
    return this.hidden.has(tip.id) ? "hidden" : this.read.has(tip.key) ? "read" : "active";
  }

  private update(change: { hide?: string[]; unhide?: string[]; read?: string[]; unread?: string[] }): void {
    const hidden = new Set(this.hidden);
    const read = new Set(this.read);
    change.hide?.forEach((v) => hidden.add(v));
    change.unhide?.forEach((v) => hidden.delete(v));
    change.read?.forEach((v) => read.add(v));
    change.unread?.forEach((v) => read.delete(v));
    this.hidden = hidden;
    this.read = read;
    send<TipState>("/api/tips/state", change).then((s) => this.set(s)).catch(() => {});
  }

  setRead(tips: Tip[], read: boolean): void {
    const keys = tips.map((t) => t.key);
    this.update(read ? { read: keys } : { unread: keys });
  }

  setHidden(tip: Tip, hidden: boolean): void {
    this.update(hidden ? { hide: [tip.id] } : { unhide: [tip.id] });
  }
}

export const tipStore = new TipStore();
