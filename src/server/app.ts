import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type AppConfig, loadConfig, resolveDbPath, saveConfig } from "../core/config.ts";
import { getMeta, openDb } from "../core/db.ts";
import { type ScanResult, scan } from "../core/ingest/index.ts";
import { localIdentity } from "../core/paths.ts";
import { PriceBook } from "../core/pricing.ts";
import { Queries } from "../core/queries.ts";

export type AppEvent =
  | { type: "scan"; result: ScanResult }
  | { type: "scanning"; done: number; total: number }
  | { type: "db-changed"; path: string }
  | { type: "pricing-changed" };

/** Long-lived server state: config, database handle, background scanner and event subscribers. */
export class App {
  cfg: AppConfig;
  db!: Database;
  dbPath!: string;
  queries!: Queries;
  private prices!: PriceBook;
  private listeners = new Set<(e: AppEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<ScanResult> | null = null;
  lastScan: ScanResult | null = null;
  lastScanAt: number | null = null;

  constructor(private cliDbPath?: string) {
    this.cfg = loadConfig();
    this.openDatabase();
  }

  get identity() {
    return { user: this.cfg.userName || localIdentity().user, host: localIdentity().host };
  }

  private openDatabase(): void {
    const { path, isDefault } = resolveDbPath(this.cfg, this.cliDbPath);
    this.db = openDb(path, { journalMode: this.cfg.journalMode, isDefaultPath: isDefault });
    this.dbPath = path;
    this.prices = PriceBook.fromDb(this.db);
    this.queries = new Queries(this.db, () => this.prices);
    const last = getMeta(this.db, `last_scan:${this.identity.host}`);
    this.lastScanAt = last ? Number(last) : null;
  }

  priceBook(): PriceBook {
    return this.prices;
  }

  reloadPrices(): void {
    this.prices = PriceBook.fromDb(this.db);
    this.emit({ type: "pricing-changed" });
  }

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: AppEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken subscriber must not break the scanner */
      }
    }
  }

  /** Runs one incremental scan; concurrent callers share the in-flight scan. */
  scanNow(full = false): Promise<ScanResult> {
    if (this.scanning) return this.scanning;
    let lastEmit = 0;
    this.scanning = scan(this.db, this.cfg, this.identity, {
      full,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - lastEmit > 250 || done === total) {
          lastEmit = now;
          this.emit({ type: "scanning", done, total });
        }
      },
    })
      .then((result) => {
        this.lastScan = result;
        this.lastScanAt = Date.now();
        this.emit({ type: "scan", result });
        return result;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  get isScanning(): boolean {
    return this.scanning !== null;
  }

  startBackgroundScan(): void {
    this.stopBackgroundScan();
    if (this.cfg.scanIntervalSec > 0) {
      this.timer = setInterval(() => {
        this.scanNow().catch((err) => console.error("[scan]", err));
      }, this.cfg.scanIntervalSec * 1000);
    }
  }

  stopBackgroundScan(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Switches to another database file. With `copy`, the current database is copied there first
   * (unless the target already exists, in which case the existing file is used as-is).
   */
  async switchDatabase(newPath: string, copy: boolean): Promise<void> {
    if (this.scanning) await this.scanning.catch(() => {});
    if (copy && newPath && !existsSync(newPath)) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.query("VACUUM INTO ?").run(newPath);
    }
    this.db.close();
    this.cfg = { ...this.cfg, dbPath: newPath };
    saveConfig(this.cfg);
    this.cliDbPath = undefined;
    this.openDatabase();
    this.emit({ type: "db-changed", path: this.dbPath });
  }

  updateConfig(patch: Partial<AppConfig>): AppConfig {
    this.cfg = { ...this.cfg, ...patch, sources: { ...this.cfg.sources, ...(patch.sources ?? {}) } };
    saveConfig(this.cfg);
    this.startBackgroundScan();
    return this.cfg;
  }

  close(): void {
    this.stopBackgroundScan();
    this.db.close();
  }
}
