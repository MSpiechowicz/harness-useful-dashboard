import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type AppConfig, loadConfig, resolveDbPath, retentionMonths, saveConfig, scanInterval, type SettingsPatch } from "../core/config.ts";
import { getMeta, openDb, setMeta } from "../core/db.ts";
import { type ScanResult, scan } from "../core/ingest/index.ts";
import { budgetAlerts, budgetStatus, limitAlerts, takeNew } from "../core/budgets.ts";
import { activePlans, type LimitReport, LimitsCache } from "../core/limits.ts";
import { localIdentity } from "../core/paths.ts";
import { BUILTIN_PRICES_VERSION, PriceBook } from "../core/pricing.ts";
import { DbWriter, recomputeCosts } from "../core/ingest/writer.ts";
import { redactStored } from "../core/redact.ts";
import { Queries } from "../core/queries.ts";
import { compact, type DbSize, dbSize, trimDetail, trimDue } from "../core/retention.ts";
import { buildDigest, type Digest, type DigestContext, type DigestWeek, digestDir, dueSlot, latestSlot, markSlot, notificationText, rememberDigest, writeDigestFile } from "../core/digest.ts";
import { notify } from "./notify.ts";
import { type CursorSyncState, syncCursor, syncState } from "../core/cursorSync.ts";

/** How often plan limits are read in the background, for the history on the plans view. */
const LIMIT_POLL_MS = 5 * 60_000;
/** How often the Cursor sync looks whether it's due (every 6 hours, or after a backoff, see cursorSync.ts). */
const CURSOR_CHECK_MS = 10 * 60_000;
/** How often the weekly digest looks whether it is due. */
const DIGEST_CHECK_MS = 10 * 60_000;
/** Only the plans used this recently are asked about: a quiet machine asks nobody. */
const LIMIT_ACTIVE_MS = 30 * 60_000;

export type AppEvent =
  | { type: "scan"; result: ScanResult }
  | { type: "scanning"; done: number; total: number }
  | { type: "db-changed"; path: string }
  | { type: "pricing-changed" }
  | { type: "alert"; title: string; body: string };

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
  private cursorTimer: ReturnType<typeof setInterval> | null = null;
  /** Shows the digest's notification. A field so tests can stand in for the desktop. */
  notifier: typeof notify = notify;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  /** The digest slot that failed to write: not tried again until the next start, so a bad folder doesn't repeat every check. */
  private digestFailed: number | null = null;
  /** The Cursor sync in flight, shared by the timer and Sync now. */
  private cursorSyncing: Promise<CursorSyncState> | null = null;
  /** Plan-limit readings, shared by the API and the background poll so providers are asked sparingly. */
  readonly limits = new LimitsCache();
  /** The database file's identity on disk when it was opened, to notice a sync client replacing it. */
  private dbFile: string | null = null;
  private scanning: Promise<ScanResult> | null = null;
  private scanningFull = false;
  /** A full rescan asked for while an incremental scan was running: it runs right after that one. */
  private queuedFull: Promise<ScanResult> | null = null;
  /** The detail trim running in the background (retention.ts), at most one at a time. */
  private trimming: Promise<void> | null = null;
  private closed = false;
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
    this.dbFile = fileId(path);
    this.prices = PriceBook.fromDb(this.db);
    // History priced with an older built-in table is re-priced once. Only upwards, so machines on an older version
    // sharing the database don't undo it.
    if (Number(getMeta(this.db, "builtin_prices") ?? 0) < BUILTIN_PRICES_VERSION) {
      this.db.transaction(() => {
        recomputeCosts(this.db, this.prices);
        setMeta(this.db, "builtin_prices", String(BUILTIN_PRICES_VERSION));
      })();
    }
    redactStored(this.db);
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

  /**
   * Runs one incremental scan; concurrent callers share the in-flight scan. A full rescan asked for during an
   * incremental one is queued behind it rather than answered by it, or Settings → Full rescan would do nothing.
   */
  scanNow(full = false): Promise<ScanResult> {
    if (this.scanning) {
      if (!full || this.scanningFull) return this.scanning;
      this.queuedFull ??= this.scanning
        .catch(() => {})
        .then(() => {
          this.queuedFull = null;
          return this.scanNow(true);
        });
      return this.queuedFull;
    }
    this.reopenIfReplaced();
    this.scanningFull = full;
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
        if (result.filesParsed > 0) this.sendAlerts().catch((err) => console.error("[alerts]", err));
        this.trimIfDue();
        return result;
      })
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  /**
   * Some sync clients update a file by writing a new copy and renaming it over the old one. The open connection would
   * go on reading and writing the old, unlinked file: open the one now at the path instead. Checked before each scan,
   * when nothing else is using the connection.
   */
  private reopenIfReplaced(): void {
    if (this.dbFile == null || fileId(this.dbPath) === this.dbFile || !existsSync(this.dbPath)) return;
    this.db.close();
    this.openDatabase();
    this.emit({ type: "db-changed", path: this.dbPath });
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
    // Only with the user's opt-in: the sync itself checks the setting, and asks cursor.com only when due.
    const cursor = () => void this.syncCursor().catch((err) => console.error("[cursor]", err));
    this.cursorTimer = setInterval(cursor, CURSOR_CHECK_MS);
    if (this.cfg.cursorSync) cursor();
    // Opt-in, and checked against the settings each time: due once a week, caught up when the app was off.
    this.digestTimer = setInterval(() => this.checkDigest(), DIGEST_CHECK_MS);
    this.checkDigest();
  }

  stopBackgroundScan(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.limitTimer) clearInterval(this.limitTimer);
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.cursorTimer = null;
    this.digestTimer = null;
    this.timer = null;
    this.limitTimer = null;
  }

  /**
   * Syncs Cursor usage from cursor.com when it's due, or right away with `force` (Settings → Sync now). Does nothing
   * while the sync is off. Open windows hear about new rows like after a scan.
   */
  syncCursor(force = false): Promise<CursorSyncState> {
    if (this.cursorSyncing) return this.cursorSyncing;
    const { host } = this.identity;
    const last = syncState(this.db, host).syncedAt;
    this.cursorSyncing = syncCursor(this.db, host, () => new DbWriter(this.db, this.prices, this.identity), { enabled: this.cfg.cursorSync, force })
      .then((state) => {
        if (state.syncedAt !== last && state.added > 0)
          this.emit({ type: "scan", result: { filesSeen: 0, filesParsed: 1, usageRows: state.added, prompts: 0, tools: 0, errors: [], durationMs: 0 } });
        return state;
      })
      .finally(() => {
        this.cursorSyncing = null;
      });
    return this.cursorSyncing;
  }

  /**
   * Builds the digest of a week and writes it into the digest folder. Open windows aren't told: the caller shows it.
   * `ref` is the moment the week counts back from (see buildDigest).
   */
  writeDigest(week: DigestWeek, ref?: number): { digest: Digest; path: string } {
    const { user, host } = this.identity;
    const c: DigestContext = {
      db: this.db, queries: this.queries, budgets: this.cfg.budgets, user, host, now: Date.now(), prices: this.prices, lang: this.cfg.language, hiddenTips: this.cfg.tips.hidden,
    };
    const digest = buildDigest(c, week, ref);
    const path = writeDigestFile(digestDir(this.cfg.digest), digest);
    rememberDigest(this.db, host, path);
    return { digest, path };
  }

  /** Writes last week's digest and shows the notification when its slot has come and none was written for it. */
  checkDigest(now = Date.now()): { digest: Digest; path: string } | null {
    const { host } = this.identity;
    const slot = dueSlot(this.db, host, this.cfg.digest, now);
    if (slot == null || slot === this.digestFailed) return null;
    try {
      const done = this.writeDigest("last", slot);
      markSlot(this.db, host, slot);
      const { title, body } = notificationText(done.digest, this.cfg.language);
      this.notifier(title, body).catch(() => {});
      return done;
    } catch (err) {
      this.digestFailed = slot;
      console.error("[digest]", err);
      return null;
    }
  }

  /** Reads the limits of the plans in use, which keeps them in the history. */
  private async pollLimits(): Promise<void> {
    const active = activePlans(this.db, Date.now() - LIMIT_ACTIVE_MS);
    if (!active.length) return;
    const { reports } = await this.limits.get(this.db, this.identity.host, this.cfg.limits, false, active);
    await this.sendAlerts(reports);
  }

  /**
   * Sends the desktop alerts that came due, each once: budgets after a scan brought new usage, plan limits after a
   * reading. Open windows hear about them too.
   */
  async sendAlerts(reports?: LimitReport[]): Promise<void> {
    const b = this.cfg.budgets;
    const { user, host } = this.identity;
    const lang = this.cfg.language;
    const due = [
      ...(b.notify ? budgetAlerts(budgetStatus(this.db, b, user), host, lang) : []),
      ...(b.limitAlerts && reports ? limitAlerts(reports, host, lang) : []),
    ];
    for (const a of takeNew(this.db, due)) {
      this.emit({ type: "alert", title: a.title, body: a.body });
      await notify(a.title, a.body);
    }
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
    const { sources, limits, budgets, digest, ...rest } = patch;
    const was = this.cfg.digest;
    this.cfg = {
      ...this.cfg,
      ...rest,
      sources: { ...this.cfg.sources, ...sources, enabled: { ...this.cfg.sources.enabled, ...sources?.enabled } },
      limits: { ...this.cfg.limits, ...limits },
      budgets: { ...this.cfg.budgets, ...budgets },
      digest: { ...this.cfg.digest, ...digest },
    };
    // Turned on, or moved to another time, in the middle of a week: that week's slot has passed already, so the first
    // digest is the next one.
    const d = this.cfg.digest;
    if (d.enabled && (!was.enabled || d.day !== was.day || d.hour !== was.hour)) markSlot(this.db, this.identity.host, latestSlot(Date.now(), d.day, d.hour));
    this.digestFailed = null;
    saveConfig(this.cfg);
    this.startBackgroundScan();
    if (patch.detailRetentionMonths !== undefined) this.trimIfDue();
    return this.cfg;
  }

  /**
   * Trims old detail when retention is on and the last trim is a day old or ran with another setting (retention.ts).
   * Checked after every scan: it reads one meta row, and writes only when a trim is due. Runs in the background, in
   * batches the server answers requests between. It stops when the database is switched or closed under it.
   */
  trimIfDue(): void {
    if (this.trimming) return;
    const db = this.db;
    const { host } = this.identity;
    const months = retentionMonths(this.cfg.detailRetentionMonths);
    if (!trimDue(db, host, months)) return;
    this.trimming = trimDetail(db, host, months, { stop: () => this.closed || this.db !== db })
      .then((r) => {
        const rows = r.prompts + r.toolCalls + r.outcomes + r.sessions + r.responseMeta;
        if (rows || r.freedPages) console.log(`[retention] trimmed ${rows} rows in ${r.batches} batches, freed ${r.freedPages} pages`);
      })
      .catch((err) => console.error("[retention]", err))
      .finally(() => {
        this.trimming = null;
      });
  }

  /** How big the database is and how much of it is free pages. */
  dbSize(): DbSize {
    return dbSize(this.db);
  }

  /**
   * Rewrites the database without its free pages (Settings → Compact). Waits for a scan or trim in progress. VACUUM
   * holds the connection until done, so no scan runs meanwhile.
   */
  async compactDb(): Promise<DbSize> {
    if (this.scanning) await this.scanning.catch(() => {});
    if (this.trimming) await this.trimming;
    return compact(this.db);
  }

  saveLanguage(language: AppConfig["language"]): void {
    this.cfg = { ...this.cfg, language };
    saveConfig(this.cfg);
  }

  /** Saves which tips are read or hidden, without restarting the background scan like a settings change does. */
  saveTipState(tips: AppConfig["tips"]): void {
    this.cfg = { ...this.cfg, tips };
    saveConfig(this.cfg);
  }

  close(): void {
    this.closed = true;
    this.stopBackgroundScan();
    this.db.close();
  }
}

/** Device and inode of a file, or null when it has none (an in-memory database, a missing file). */
function fileId(path: string): string | null {
  try {
    const st = statSync(path);
    return st.ino ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}
