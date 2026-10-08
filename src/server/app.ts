import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type AppConfig, applyMetrics, loadConfig, resolveDbPath, retentionMonths, saveConfig, scanInterval, type SettingsPatch } from "../core/config.ts";
import { getMeta, NewerSchemaError, openDb, SCHEMA_VERSION, schemaInfo, setMeta } from "../core/db.ts";
import { type ScanResult, scan } from "../core/ingest/index.ts";
import { budgetAlerts, budgetStatus, limitAlerts, takeNew } from "../core/budgets.ts";
import { activePlans, type LimitReport, LimitsCache } from "../core/limits.ts";
import { localIdentity } from "../core/paths.ts";
import { BUILTIN_PRICES_VERSION, PriceBook } from "../core/pricing.ts";
import { DbWriter, recomputeCosts } from "../core/ingest/writer.ts";
import { redactStored } from "../core/redact.ts";
import { Queries } from "../core/queries.ts";
import { compact, type DbSize, dbSize, trimDetail, trimDue } from "../core/retention.ts";
import { rollupDue, rollupOutcomes } from "../core/rollup.ts";
import { buildDigest, type Digest, type DigestContext, type DigestWeek, digestDir, dueSlot, latestSlot, markSlot, notificationText, rememberDigest, writeDigestFile } from "../core/digest.ts";
import { notify } from "./notify.ts";
import { type CursorSyncState, syncCursor, syncState } from "../core/cursorSync.ts";
import { type LabelerDeps, type LabelRun, labelerDir, labelSessions, labelState } from "../core/labeler.ts";
import { tagLabelerSessions } from "../core/labels.ts";

/** How often plan limits are read in the background, for the history on the plans view. */
const LIMIT_POLL_MS = 5 * 60_000;
/** How often the Cursor sync looks whether it's due (every 6 hours, or after a backoff, see cursorSync.ts). */
const CURSOR_CHECK_MS = 10 * 60_000;
/** How often the labeler looks whether it is due (it runs at most every 30 minutes, see labeler.ts). */
const LABEL_CHECK_MS = 5 * 60_000;
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

/**
 * Why the database is open read-only: a newer app migrated it past the schema this one knows, at the start or while
 * this one ran (App.writable). Nothing is written to it then, not by a scan, a background job or a request, until the
 * app is updated.
 */
export type ReadOnlyReason = "newer-schema";

/** What a scan answers while the database is read-only: nothing read, nothing written. */
const NO_SCAN: ScanResult = { filesSeen: 0, filesParsed: 0, usageRows: 0, prompts: 0, tools: 0, errors: [], durationMs: 0 };

/** Long-lived server state: config, database handle, background scanner and event subscribers. */
export class App {
  cfg: AppConfig;
  db!: Database;
  dbPath!: string;
  queries!: Queries;
  /** Set while the database is open read-only (see ReadOnlyReason), null while this app may write it. */
  readOnly: ReadOnlyReason | null = null;
  private prices!: PriceBook;
  private listeners = new Set<(e: AppEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private limitTimer: ReturnType<typeof setInterval> | null = null;
  private cursorTimer: ReturnType<typeof setInterval> | null = null;
  /** Shows the digest's notification. A field so tests can stand in for the desktop. */
  notifier: typeof notify = notify;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private labelTimer: ReturnType<typeof setInterval> | null = null;
  /** The labeling run in flight, shared by the timer, Label now and a regenerate: one CLI at a time. */
  private labeling: Promise<LabelRun> | null = null;
  /** Stands in for the CLI in tests (see labeler.ts). */
  labelerDeps: LabelerDeps = {};
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
  /** The outcome rollup running in the background (rollup.ts), at most one at a time. */
  private rolling: Promise<void> | null = null;
  private closed = false;
  /** Whether the background jobs were asked for: they start again when the database becomes writable. */
  private background = false;
  lastScan: ScanResult | null = null;
  lastScanAt: number | null = null;

  constructor(private cliDbPath?: string) {
    this.cfg = loadConfig();
    this.openDatabase();
  }

  get identity() {
    return { user: this.cfg.userName || localIdentity().user, host: localIdentity().host };
  }

  /**
   * Opens the configured database. One a newer app migrated past this app's schema is opened read-only instead, and
   * one that newer app marked unreadable for older ones throws NewerSchemaError. The connection open until now is
   * closed only once the new one is ready: a database that can't be opened leaves the app on the one it had.
   */
  private openDatabase(): void {
    const { path, isDefault } = resolveDbPath(this.cfg, this.cliDbPath);
    let db: Database;
    let readOnly: ReadOnlyReason | null = null;
    try {
      db = openDb(path, { journalMode: this.cfg.journalMode, isDefaultPath: isDefault });
    } catch (err) {
      if (!(err instanceof NewerSchemaError)) throw err;
      db = openDb(path, { readonly: true });
      readOnly = "newer-schema";
      console.warn(`[db] ${err.message} Opened read-only.`);
    }

    let prices: PriceBook;
    let last: string | null;
    try {
      prices = PriceBook.fromDb(db);
      if (!readOnly) {
        // History priced with an older built-in table is re-priced once. Only upwards, so machines on an older version
        // sharing the database don't undo it.
        if (Number(getMeta(db, "builtin_prices") ?? 0) < BUILTIN_PRICES_VERSION) {
          db.transaction(() => {
            recomputeCosts(db, prices);
            setMeta(db, "builtin_prices", String(BUILTIN_PRICES_VERSION));
          })();
        }
        redactStored(db);
      }
      last = getMeta(db, `last_scan:${this.identity.host}`);
    } catch (err) {
      db.close();
      throw err;
    }

    const previous: Database | undefined = this.db;
    this.db = db;
    this.readOnly = readOnly;
    this.dbPath = path;
    this.dbFile = fileId(path);
    this.prices = prices;
    this.queries = new Queries(db, () => this.prices);
    this.lastScanAt = last ? Number(last) : null;
    previous?.close();
  }

  /** The database's schema version, which is ahead of this app's while it is read-only. 0 when it can't be read. */
  schemaVersion(): number {
    try {
      return schemaInfo(this.db).version;
    } catch {
      return 0;
    }
  }

  /**
   * Whether this app may write the database now. Another machine sharing it can migrate it past this app's schema while
   * this one runs: every write (a scan, a background job, a request) asks first, which reads two meta rows. A newer
   * schema makes the app read-only like one opened that way, and open windows hear of it. The database is opened again
   * read-only when nothing else is using the connection. One the newer app marked unreadable for this one, or one a job
   * is still running on, keeps its connection: only nothing is written to it anymore.
   */
  writable(): boolean {
    if (this.readOnly) return false;

    // A version that can't be read is no permission to write: not this time, though the next check may read it.
    let schema: { version: number; minReader: number };
    try {
      schema = schemaInfo(this.db);
    } catch (err) {
      console.warn("[db] Can't read the schema version, nothing is written:", err);
      return false;
    }
    if (schema.version <= SCHEMA_VERSION) return true;

    console.warn(`[db] ${new NewerSchemaError(schema.version, schema.minReader).message} Nothing is written to it anymore.`);
    const busy = this.scanning || this.trimming || this.rolling || this.labeling || this.cursorSyncing;
    let reopened = false;
    if (!busy) {
      try {
        this.reopen();
        reopened = true;
      } catch {
        // Unreadable for this app: the connection stays, nothing is written to it.
      }
    }
    if (!reopened) {
      this.readOnly = "newer-schema";
      if (this.background) this.startBackgroundScan();
    }

    this.emit({ type: "db-changed", path: this.dbPath });
    return false;
  }

  /**
   * Whether a background job on `db` (a trim, the rollup) stops at its next step: the app closed or moved to another
   * database, or this one went read-only, or a newer app migrated it meanwhile.
   */
  private jobStopped(db: Database): boolean {
    return this.closed || this.db !== db || !this.writable();
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
    if (!this.writable()) return Promise.resolve(NO_SCAN);

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
        this.rollupIfDue();
        // The labeler's own runs leave transcripts that this scan may just have read.
        if (this.writable()) tagLabelerSessions(this.db, this.labelerDir());
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
    this.reopen();
    this.emit({ type: "db-changed", path: this.dbPath });
  }

  /**
   * Opens the database again, and starts or stops the background jobs when it became writable or read-only. One that
   * can't be opened throws, and leaves the connection as it was.
   */
  private reopen(): void {
    const was = this.readOnly;
    this.openDatabase();
    if (this.readOnly !== was && this.background) this.startBackgroundScan();
  }

  get isScanning(): boolean {
    return this.scanning !== null;
  }

  /** Starts the scan and the other background jobs. None of them runs on a read-only database: they all write it. */
  startBackgroundScan(): void {
    this.stopBackgroundScan();
    this.background = true;
    // Only a database known to be read-only has no jobs. A check that fails for a moment (a locked file in a synced
    // folder) must not leave none running: each job asks writable() itself before it writes.
    if (this.readOnly) return;

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
    // Opt-in, and checked against the settings each time: due once a week, caught up when the app was off.
    this.digestTimer = setInterval(() => this.checkDigest(), DIGEST_CHECK_MS);
    // Opt-in: runs only while Settings has it on, and at most every 30 minutes when something is waiting.
    this.labelTimer = setInterval(() => void this.labelSessions().catch((err) => console.error("[labels]", err)), LABEL_CHECK_MS);

    // Run now, once every timer is set: one that finds the database migrated restarts the jobs, which stops them all.
    if (this.cfg.cursorSync) cursor();
    this.checkDigest();
  }

  stopBackgroundScan(): void {
    if (this.labelTimer) clearInterval(this.labelTimer);
    this.labelTimer = null;
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
    if (!this.writable()) return Promise.resolve(syncState(this.db, host));

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

  labelerDir(): string {
    return this.labelerDeps.dir ?? labelerDir();
  }

  /** What Settings shows about the labels: the last run, today's count, and which CLIs are installed. */
  labelStatus() {
    const which = this.labelerDeps.which ?? ((n: string) => Bun.which(n));
    return { config: this.cfg.labels, state: labelState(this.db, this.identity.host), available: { claude: !!which("claude"), codex: !!which("codex") }, textLimit: this.cfg.promptTextLimit };
  }

  /**
   * Labels sessions with the user's CLI: what is waiting up to the day's cap, or just `ids`, and every waiting session
   * with `force` (Label now) regardless of the wait since the last run. Does nothing while labels are off. Open
   * windows hear about new labels like after a scan.
   */
  labelSessions(opts: { force?: boolean; ids?: string[] } = {}): Promise<LabelRun> {
    if (this.labeling) return this.labeling;
    if (!this.writable()) return Promise.resolve({ ...labelState(this.db, this.identity.host), skipped: "disabled" });

    const db = this.db;
    this.labeling = labelSessions(db, this.identity.host, this.cfg, opts, this.labelerDeps)
      .then((run) => {
        if (run.labelled > 0 && run.skipped == null) this.emit({ type: "scan", result: { filesSeen: 0, filesParsed: 1, usageRows: 0, prompts: 0, tools: 0, errors: [], durationMs: 0 } });
        return run;
      })
      .finally(() => {
        this.labeling = null;
      });
    return this.labeling;
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
    // Which week was written is kept in the database: on a read-only one the same week would be written on every check.
    if (!this.writable()) return null;

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
    if (!this.writable()) return;

    const active = activePlans(this.db, Date.now() - LIMIT_ACTIVE_MS);
    if (!active.length) return;
    const { reports } = await this.limits.get(this.db, this.identity.host, this.cfg.limits, false, active, () => this.writable());
    await this.sendAlerts(reports);
  }

  /**
   * Sends the desktop alerts that came due, each once: budgets after a scan brought new usage, plan limits after a
   * reading. Open windows hear about them too.
   */
  async sendAlerts(reports?: LimitReport[]): Promise<void> {
    // Which alerts were sent is kept in the database: on a read-only one none could be marked, so none is sent.
    if (!this.writable()) return;

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
      // VACUUM INTO reads a read-only database as well, only the checkpoint would write it.
      if (!this.readOnly) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.query("VACUUM INTO ?").run(newPath);
    }
    // The config names the new file only once it opened: one that can't be read leaves the app on the old one.
    const previous = { cfg: this.cfg, cliDbPath: this.cliDbPath };
    this.cfg = { ...this.cfg, dbPath: newPath };
    this.cliDbPath = undefined;
    try {
      this.reopen();
    } catch (err) {
      this.cfg = previous.cfg;
      this.cliDbPath = previous.cliDbPath;
      throw err;
    }

    saveConfig(this.cfg);
    this.emit({ type: "db-changed", path: this.dbPath });
  }

  updateConfig(patch: SettingsPatch): AppConfig {
    const { sources, limits, budgets, digest, labels, metrics, ...rest } = patch;
    const was = this.cfg.digest;
    this.cfg = {
      ...this.cfg,
      ...rest,
      sources: { ...this.cfg.sources, ...sources, enabled: { ...this.cfg.sources.enabled, ...sources?.enabled } },
      limits: { ...this.cfg.limits, ...limits },
      budgets: { ...this.cfg.budgets, ...budgets },
      digest: { ...this.cfg.digest, ...digest },
      labels: { ...this.cfg.labels, ...labels },
      metrics: applyMetrics(this.cfg.metrics, metrics),
    };
    // Turned on, or moved to another time, in the middle of a week: that week's slot has passed already, so the first
    // digest is the next one.
    const d = this.cfg.digest;
    if (d.enabled && this.writable() && (!was.enabled || d.day !== was.day || d.hour !== was.hour)) markSlot(this.db, this.identity.host, latestSlot(Date.now(), d.day, d.hour));
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
    if (this.trimming || !this.writable()) return;
    const db = this.db;
    const { host } = this.identity;
    const months = retentionMonths(this.cfg.detailRetentionMonths);
    if (!trimDue(db, host, months)) return;
    this.trimming = trimDetail(db, host, months, { stop: () => this.jobStopped(db) })
      .then((r) => {
        const rows = r.prompts + r.toolCalls + r.outcomes + r.sessions + r.responseMeta + r.gitEvents;
        if (rows || r.freedPages) console.log(`[retention] trimmed ${rows} rows in ${r.batches} batches, freed ${r.freedPages} pages`);
      })
      .catch((err) => console.error("[retention]", err))
      .finally(() => {
        this.trimming = null;
      });
  }

  /**
   * Rolls this host's successful tool calls older than a week into daily counts once a day (rollup.ts). Checked after
   * every scan, after the trim: it waits for a trim in progress, then runs in the background a day per transaction.
   * It stops when the database is switched or closed under it.
   */
  rollupIfDue(): void {
    if (this.rolling || !this.writable()) return;
    const db = this.db;
    const { host } = this.identity;
    if (!rollupDue(db, host)) return;
    const stop = () => this.jobStopped(db);
    this.rolling = (this.trimming ?? Promise.resolve())
      .then(() => (stop() ? null : rollupOutcomes(db, host, { stop })))
      .then((r) => {
        if (r?.deleted || r?.freedPages) console.log(`[rollup] counted ${r.counted} tool results of ${r.days} days in ${r.groups} rows, freed ${r.freedPages} pages`);
      })
      .catch((err) => console.error("[rollup]", err))
      .finally(() => {
        this.rolling = null;
      });
  }

  /** How big the database is and how much of it is free pages. */
  dbSize(): DbSize {
    return dbSize(this.db);
  }

  /**
   * Rewrites the database without its free pages (Settings → Compact). Waits for a scan, trim or rollup in progress. VACUUM
   * holds the connection until done, so no scan runs meanwhile.
   */
  async compactDb(): Promise<DbSize> {
    if (this.scanning) await this.scanning.catch(() => {});
    if (this.trimming) await this.trimming;
    if (this.rolling) await this.rolling;
    // Another machine may have migrated it while this waited: then nothing is rewritten.
    if (!this.writable()) return this.dbSize();
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
