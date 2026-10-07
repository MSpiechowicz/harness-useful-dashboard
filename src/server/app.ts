import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type AppConfig, loadConfig, resolveDbPath, saveConfig, scanInterval, type SettingsPatch } from "../core/config.ts";
import { getMeta, openDb, setMeta } from "../core/db.ts";
import { type ScanResult, scan } from "../core/ingest/index.ts";
import { activePlans, LimitsCache } from "../core/limits.ts";
import { localIdentity } from "../core/paths.ts";
import { BUILTIN_PRICES_VERSION, PriceBook } from "../core/pricing.ts";
import { recomputeCosts } from "../core/ingest/writer.ts";
import { Queries } from "../core/queries.ts";

/** How often plan limits are read in the background, for the history on the plans view. */
const LIMIT_POLL_MS = 5 * 60_000;
/** Only the plans used this recently are asked about: a quiet machine asks nobody. */
const LIMIT_ACTIVE_MS = 30 * 60_000;

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
  private limitTimer: ReturnType<typeof setInterval> | null = null;
  /** Plan-limit readings, shared by the API and the background poll so providers are asked sparingly. */
  readonly limits = new LimitsCache();
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
    // History priced with an older built-in table is re-priced once. Only upwards, so machines on an older version
    // sharing the database don't undo it.
    if (Number(getMeta(this.db, "builtin_prices") ?? 0) < BUILTIN_PRICES_VERSION) {
      this.db.transaction(() => {
        recomputeCosts(this.db, this.prices);
        setMeta(this.db, "builtin_prices", String(BUILTIN_PRICES_VERSION));
      })();
    }
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
    // Kept in range here too: the config file can be edited by hand.
    const sec = scanInterval(this.cfg.scanIntervalSec);
    if (sec > 0) {
      this.timer = setInterval(() => {
        this.scanNow().catch((err) => console.error("[scan]", err));
      }, sec * 1000);
    }
    this.limitTimer = setInterval(() => {
      this.pollLimits().catch((err) => console.error("[limits]", err));
    }, LIMIT_POLL_MS);
  }

  stopBackgroundScan(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.timer = null;
    this.limitTimer = null;
  }

  /** Reads the limits of the plans in use, which keeps them in the history. */
  private async pollLimits(): Promise<void> {
    const active = activePlans(this.db, Date.now() - LIMIT_ACTIVE_MS);
    if (active.length) await this.limits.get(this.db, this.identity.host, this.cfg.limits, false, active);
  }

  /**
   * Switches to another database file. With `copy`, the current database is copied there first
   * (unless the target already exists, in which case the existing file is used as-is).
   */
  async switchDatabase(newPath: string, copy: boolean): Promise<void> {
    if (this.scanning) await this.scanning.catch(() => {});
    if (copy && newPath && !existsSync(newPath)) {
      mkdirSync(dirname(newPath), { recursive: true });
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

  updateConfig(patch: SettingsPatch): AppConfig {
    const { sources, limits, ...rest } = patch;
    this.cfg = {
      ...this.cfg,
      ...rest,
      sources: { ...this.cfg.sources, ...sources, enabled: { ...this.cfg.sources.enabled, ...sources?.enabled } },
      limits: { ...this.cfg.limits, ...limits },
    };
    saveConfig(this.cfg);
    this.startBackgroundScan();
    return this.cfg;
  }

  /** Saves which tips are read or hidden, without restarting the background scan like a settings change does. */
  saveTipState(tips: AppConfig["tips"]): void {
    this.cfg = { ...this.cfg, tips };
    saveConfig(this.cfg);
  }

  close(): void {
    this.stopBackgroundScan();
    this.db.close();
  }
}
