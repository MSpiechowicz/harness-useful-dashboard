<script lang="ts">
  import { Bell, Check, Cloud, Copy, Download, ExternalLink, FileText, FileUp, Info, Loader, Plus, Power, RefreshCw, Shrink, Tags, Trash2, TriangleAlert, Users } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import FolderField from "../components/FolderField.svelte";
  import LangPicker from "../components/LangPicker.svelte";
  import MarkdownView from "../components/MarkdownView.svelte";
  import NumberField from "../components/NumberField.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import PathList from "../components/PathList.svelte";
  import SettingRow from "../components/SettingRow.svelte";
  import TagRules from "../components/TagRules.svelte";
  import Switch from "../components/Switch.svelte";
  import ThemeToggle from "../components/ThemeToggle.svelte";
  import { getJson, send } from "../lib/api.svelte.ts";
  import { decimal, relative } from "../lib/format.ts";
  import { i18n, t } from "../lib/i18n.svelte.ts";
  import { live } from "../lib/live.svelte.ts";
  import { checkUpdate, installUpdate, updater } from "../lib/update.svelte.ts";

  type SourceKey = "claude" | "codex" | "omp" | "pi" | "opencode" | "zed" | "cline" | "roo" | "kilo" | "gemini" | "copilot";
  type DirsKey = "claudeDirs" | "codexDirs" | "ompDirs" | "piDirs" | "opencodeDirs" | "zedDirs" | "clineDirs" | "rooDirs" | "kiloDirs" | "geminiDirs" | "copilotDirs";
  type LimitKey = "claude" | "codex" | "omp" | "pi" | "opencode" | "copilot";
  interface Config {
    dbPath: string;
    journalMode: "auto" | "wal" | "delete";
    userName: string;
    openMode: "app" | "browser" | "none";
    scanIntervalSec: number;
    promptTextLimit: number;
    detailRetentionMonths?: number;
    checkUpdates: boolean;
    sources: Record<DirsKey, string[]> & { enabled: Record<SourceKey, boolean> };
    limits: Record<LimitKey, boolean>;
    budgets?: { daily: number | null; monthly: number | null; projects: Record<string, number>; notify: boolean; limitAlerts: boolean };
    cursorSync?: boolean;
    digest?: { enabled: boolean; day: number; hour: number; dir: string };
    labels?: { enabled: boolean; cli: "claude" | "codex"; model: string; dailyCap: number };
    metrics?: { enabled: boolean; token: string; projectLabels: boolean };
  }
  interface Settings {
    config: Config;
    dbPath: string;
    defaultDbPath: string;
    syncFolders: { name: string; path: string }[];
    sharedFolder: string;
  }
  type DbState = "default" | "current" | "existing" | "new" | "missing" | "invalid";
  interface Rule {
    pattern: string;
    input: number;
    output: number;
    cacheRead?: number | null;
    cacheWrite5m?: number | null;
    cacheWrite1h?: number | null;
    source?: "builtin" | "user";
  }

  const SOURCES: { key: SourceKey; dirs: DirsKey }[] = [
    { key: "claude", dirs: "claudeDirs" },
    { key: "codex", dirs: "codexDirs" },
    { key: "opencode", dirs: "opencodeDirs" },
    { key: "pi", dirs: "piDirs" },
    { key: "omp", dirs: "ompDirs" },
    { key: "zed", dirs: "zedDirs" },
    { key: "cline", dirs: "clineDirs" },
    { key: "roo", dirs: "rooDirs" },
    { key: "kilo", dirs: "kiloDirs" },
    { key: "gemini", dirs: "geminiDirs" },
    { key: "copilot", dirs: "copilotDirs" },
  ];
  /** Where plan limits can be read from (see Live). */
  const LIMIT_SOURCES: LimitKey[] = ["claude", "codex", "copilot", "opencode", "pi", "omp"];

  let cfg = $state<Config | null>(null);
  let currentDb = $state("");
  let defaultDb = $state("");
  let syncFolders = $state<Settings["syncFolders"]>([]);
  let sharedFolder = $state("");
  let dbInput = $state("");
  let target = $state<{ file: string; state: DbState } | null>(null);
  let copyDb = $state(true);
  let dirs = $state<Record<SourceKey, string[]>>({ claude: [""], codex: [""], omp: [""], pi: [""], opencode: [""], zed: [""], cline: [""], roo: [""], kilo: [""], gemini: [""], copilot: [""] });
  let saved = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);
  let userRules = $state<Rule[]>([]);
  let builtinRules = $state<Rule[]>([]);
  let showBuiltin = $state(false);
  let importMsg = $state<string | null>(null);
  // The Cursor sync's last outcome, as the server keeps it. Codes only, never cursor.com's own words.
  type CursorCode = "not-signed-in" | "expired" | "unauthorized" | "rate-limited" | "unreachable" | "failed";
  interface CursorSync {
    enabled: boolean;
    syncedAt: number | null;
    added: number;
    code: CursorCode | null;
    nextAt: number | null;
  }
  let cursorSync = $state<CursorSync | null>(null);
  let cursorSyncing = $state(false);
  const CURSOR_CODE: Record<CursorCode, string> = {
    "not-signed-in": "settings.cursorSync.notSignedIn",
    expired: "settings.cursorSync.expired",
    unauthorized: "settings.cursorSync.unauthorized",
    "rate-limited": "settings.cursorSync.rateLimited",
    unreachable: "settings.cursorSync.unreachable",
    failed: "settings.cursorSync.failed",
  };
  const cursorStatus = $derived.by(() => {
    const s = cursorSync;
    if (!s?.enabled) return null;
    if (s.code) return { bad: true, text: t(CURSOR_CODE[s.code] as "settings.cursorSync.failed", { when: relative(s.nextAt) }) };
    if (s.syncedAt) return { bad: false, text: t("settings.cursorSync.ok", { when: relative(s.syncedAt), n: s.added }) };
    return { bad: false, text: t("settings.cursorSync.never") };
  });
  // Budgets: 0 in a field means no cap. Project rows are edited here and saved together.
  let budgetDaily = $state(0);
  let budgetMonthly = $state(0);
  let projectBudgets = $state<{ project: string; cap: number }[]>([]);
  let projectOptions = $state<{ value: string; label: string }[]>([]);
  let testMsg = $state<string | null>(null);
  // Detail retention in months ("0" keeps everything), and the database's size with what Compact would give back.
  let retention = $state("0");
  let dbSize = $state<{ bytes: number; freeBytes: number; incremental: boolean } | null>(null);
  let compacting = $state(false);
  let compactMsg = $state<string | null>(null);
  /** At least a megabyte unused: below that, compacting isn't worth rewriting the file. */
  const reclaimable = $derived(!!dbSize && dbSize.freeBytes >= 1024 * 1024);
  const RETENTION = [0, 3, 6, 12, 24];
  const retentionOptions = $derived(
    [...new Set([...RETENTION, Number(retention)])]
      .sort((a, b) => a - b)
      .map((n) => ({ value: String(n), label: n === 0 ? t("settings.retention.all") : RETENTION.includes(n) ? t(`settings.retention.m${n as 3 | 6 | 12 | 24}`) : t("settings.retention.months", { n }) })),
  );
  const megabytes = (b: number) => (b >= 1e9 ? `${decimal(b / 1e9, 2)} GB` : `${decimal(b / 1e6, 1)} MB`);

  /** Join a folder and a name with the separator the folder already uses. */
  const joinPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${name}`;
  /** The database setting as the folder it's in, unless the file has a name of its own. */
  const asFolder = (file: string) => file.replace(/[\\/]usage\.db$/, "");
  const example = $derived.by(() => {
    if (syncFolders[0]) return joinPath(syncFolders[0].path, sharedFolder);
    const os = live.status?.platform ?? "";
    if (os.startsWith("darwin")) return `~/Library/Mobile Documents/com~apple~CloudDocs/${sharedFolder}`;
    if (os.startsWith("win")) return `C:\\Users\\you\\Dropbox\\${sharedFolder}`;
    return `~/Dropbox/${sharedFolder}`;
  });

  /** Folder lists the server reported: one it doesn't know (an older version still running) isn't saved empty. */
  let knownDirs = new Set<DirsKey>();

  function apply(s: Settings) {
    knownDirs = new Set(SOURCES.map((src) => src.dirs).filter((k) => Array.isArray(s.config.sources[k])));
    // A source the server doesn't know yet (an older version still running) shows as on, as it is by default,
    // rather than leaving its switch without a value.
    const enabled = Object.fromEntries(SOURCES.map((src) => [src.key, s.config.sources.enabled?.[src.key] ?? true])) as Record<SourceKey, boolean>;
    const limits = Object.fromEntries(LIMIT_SOURCES.map((k) => [k, s.config.limits?.[k] ?? true])) as Record<LimitKey, boolean>;
    cfg = { ...s.config, sources: { ...s.config.sources, enabled: { ...s.config.sources.enabled, ...enabled } }, limits: { ...s.config.limits, ...limits } };
    currentDb = s.dbPath;
    defaultDb = s.defaultDbPath;
    syncFolders = s.syncFolders;
    sharedFolder = s.sharedFolder;
    dbInput = asFolder(s.config.dbPath);
    for (const src of SOURCES) dirs[src.key] = s.config.sources[src.dirs]?.length ? [...s.config.sources[src.dirs]] : [""];
    const b = s.config.budgets;
    retention = String(s.config.detailRetentionMonths ?? 0);
    budgetDaily = b?.daily ?? 0;
    budgetMonthly = b?.monthly ?? 0;
    projectBudgets = Object.entries(b?.projects ?? {}).map(([project, cap]) => ({ project, cap }));
    const g = s.config.digest;
    digestDay = String(g?.day ?? 1);
    digestHour = String(g?.hour ?? 9);
    digestDir = g?.dir ?? "";
  }

  // The Prometheus endpoint: a change saves at once. The token is made by the server, a new one is only asked for.
  const metricsUrl = `http://127.0.0.1:${location.port || 80}/metrics`;
  const METRICS_DOCS = "https://github.com/MSpiechowicz/harness-useful-dashboard#prometheus-metrics";
  let tokenCopied = $state(false);
  async function saveMetrics(change: { enabled?: boolean; projectLabels?: boolean; regenerateToken?: boolean }) {
    busy = true;
    errorMsg = null;
    try {
      apply(await send<Settings>("/api/settings", { metrics: change }));
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function copyToken() {
    try {
      await navigator.clipboard.writeText(cfg?.metrics?.token ?? "");
      tokenCopied = true;
      setTimeout(() => (tokenCopied = false), 2000);
    } catch {
      /* the field's text can still be selected by hand */
    }
  }

  // AI session labels: switch and program save at once, the model and the cap with Save. The status is the server's.
  type LabelCode = "not-installed" | "not-signed-in" | "timeout" | "bad-output" | "failed";
  interface LabelStatus {
    available: { claude: boolean; codex: boolean };
    textLimit: number;
    state: { ranAt: number | null; labelled: number; failed: number; code: LabelCode | null; nextAt: number | null; sent: number };
  }
  let labelStatus = $state<LabelStatus | null>(null);
  let labelsRunning = $state(false);
  const CLI_NAMES = { claude: "Claude Code", codex: "Codex" } as const;
  const labelClis = $derived.by(() => {
    const have = labelStatus?.available;
    return (["claude", "codex"] as const).map((v) => ({ value: v, label: have && !have[v] ? t("settings.labelsCliMissing", { name: CLI_NAMES[v] }) : CLI_NAMES[v] }));
  });
  // The chosen CLI isn't on this machine: nothing to run, so Label now is off and says why.
  const labelCliMissing = $derived(!!cfg?.labels && !!labelStatus && !labelStatus.available[cfg.labels.cli]);
  const labelLine = $derived.by(() => {
    const s = labelStatus;
    const l = cfg?.labels;
    if (!s || !l?.enabled) return null;
    if (s.textLimit <= 0) return { bad: true, text: t("settings.labelsStatus.noPrompts") };
    if (!s.available.claude && !s.available.codex) return { bad: true, text: t("settings.labelsNoCli") };
    if (s.state.code) return { bad: true, text: t(`settings.labelsCode.${s.state.code}`, { when: relative(s.state.nextAt) }) };
    if (s.state.sent >= l.dailyCap) return { bad: false, text: t("settings.labelsStatus.cap") };
    if (s.state.ranAt) return { bad: false, text: t("settings.labelsStatus.ok", { when: relative(s.state.ranAt), n: s.state.labelled, failed: s.state.failed, sent: s.state.sent, cap: l.dailyCap }) };
    return { bad: false, text: t("settings.labelsStatus.never") };
  });
  async function saveLabels() {
    if (!cfg?.labels) return;
    busy = true;
    errorMsg = null;
    try {
      const { enabled, cli, model, dailyCap } = cfg.labels;
      apply(await send<Settings>("/api/settings", { labels: { enabled, cli, model: model.trim(), dailyCap: Math.round(Number(dailyCap)) } }));
      labelStatus = await getJson<LabelStatus>("/api/labels");
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function labelNow() {
    labelsRunning = true;
    errorMsg = null;
    try {
      labelStatus = await send<LabelStatus>("/api/labels/run");
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      labelsRunning = false;
    }
  }

  async function saveBudgets() {
    if (!cfg?.budgets) return;
    busy = true;
    errorMsg = null;
    try {
      const projects = Object.fromEntries(projectBudgets.filter((r) => r.project && Number(r.cap) > 0).map((r) => [r.project, Number(r.cap)]));
      const r = await send<Settings>("/api/settings", {
        budgets: { daily: Number(budgetDaily) || null, monthly: Number(budgetMonthly) || null, projects, notify: cfg.budgets.notify, limitAlerts: cfg.budgets.limitAlerts },
      });
      apply(r);
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  // The weekly digest: the settings save as they change, the folder with its Save button. The last one is read on demand.
  const DIGEST_DAYS = [1, 2, 3, 4, 5, 6, 0];
  const digestDays = $derived(DIGEST_DAYS.map((d) => ({ value: String(d), label: new Intl.DateTimeFormat(i18n.locale, { weekday: "long" }).format(new Date(2024, 0, 7 + d)) })));
  const digestHours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }));
  let digestDay = $state("1");
  let digestHour = $state("9");
  let digestDir = $state("");
  let digestDefaultDir = $state("");
  let digestLast = $state<{ path: string; markdown: string } | null>(null);
  let digestShown = $state(false);
  let digestMsg = $state<string | null>(null);

  async function saveDigest() {
    if (!cfg?.digest) return;
    busy = true;
    errorMsg = null;
    try {
      const r = await send<Settings>("/api/settings", { digest: { enabled: cfg.digest.enabled, day: Number(digestDay), hour: Number(digestHour), dir: digestDir.trim() } });
      apply(r);
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function writeDigest() {
    digestMsg = null;
    try {
      const r = await send<{ path: string; markdown: string }>("/api/digest");
      digestLast = r;
      digestShown = true;
      digestMsg = t("settings.digestWritten", { path: r.path });
    } catch (e) {
      digestMsg = (e as Error).message;
    }
  }

  async function loadDigest() {
    const r = await getJson<{ last: { path: string; markdown: string } | null; dir: string }>("/api/digest");
    digestLast = r.last;
    digestDefaultDir = r.dir;
  }

  async function testNotification() {
    testMsg = null;
    try {
      const r = await send<{ shown: boolean }>("/api/notify/test");
      testMsg = t(r.shown ? "settings.testNotificationShown" : "settings.testNotificationFailed");
    } catch (e) {
      testMsg = (e as Error).message;
    }
  }

  async function load() {
    apply(await getJson<Settings>("/api/settings"));
    // Every project ever seen, for the project budgets.
    getJson<{ project: { value: string; label: string }[] }>("/api/filters")
      .then((f) => (projectOptions = f.project.map((o) => ({ value: o.value, label: o.label }))))
      .catch(() => {});
    loadDigest().catch(() => {});
    getJson<LabelStatus>("/api/labels")
      .then((s) => (labelStatus = s))
      .catch(() => {});
    getJson<CursorSync>("/api/cursor/sync")
      .then((s) => (cursorSync = s))
      .catch(() => {});
    const rules = await getJson<Rule[]>("/api/pricing");
    userRules = rules.filter((r) => r.source === "user");
    builtinRules = rules.filter((r) => r.source === "builtin");
  }
  $effect(() => {
    load().catch((e) => (errorMsg = e.message));
  });

  function flash(msg: string) {
    saved = msg;
    setTimeout(() => (saved = null), 2500);
  }

  async function save(extra: Record<string, unknown> = {}) {
    if (!cfg) return;
    busy = true;
    errorMsg = null;
    try {
      const clean = (a: string[]) => a.map((x) => x.trim()).filter(Boolean);
      const r = await send<Settings>("/api/settings", {
        userName: cfg.userName,
        openMode: cfg.openMode,
        scanIntervalSec: Number(cfg.scanIntervalSec),
        promptTextLimit: Number(cfg.promptTextLimit),
        checkUpdates: cfg.checkUpdates,
        journalMode: cfg.journalMode,
        detailRetentionMonths: Number(retention),
        sources: { ...Object.fromEntries(SOURCES.filter((src) => knownDirs.has(src.dirs)).map((src) => [src.dirs, clean(dirs[src.key])])), enabled: cfg.sources.enabled },
        limits: cfg.limits,
        cursorSync: !!cfg.cursorSync,
        ...extra,
      });
      apply(r);
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function saveDb() {
    await save({ dbPath: dbInput, copyDb });
  }

  // What saving the database folder would do, checked as it's typed. Only the latest answer counts.
  let asked = 0;
  $effect(() => {
    const path = dbInput;
    void currentDb;
    const n = ++asked;
    const timer = setTimeout(() => {
      getJson<{ file: string; state: DbState }>(`/api/settings/db-target?path=${encodeURIComponent(path)}`)
        .then((r) => n === asked && (target = r))
        .catch(() => {});
    }, 200);
    return () => clearTimeout(timer);
  });
  const canSaveDb = $derived(!!target && (target.state === "default" || target.state === "existing" || target.state === "new"));
  // The line under the folder. Left empty it shows an example path, never one that could pass for the folder in use.
  const status = $derived.by(() => {
    if (!dbInput.trim() && (!target || target.state === "current")) return { icon: Info, tone: "muted", text: t("settings.dbExample", { example }) };
    if (!target) return null;
    const text = t(`settings.dbTarget.${target.state}`, { file: target.file, example });
    if (target.state === "current") return { icon: Check, tone: "good", text };
    if (target.state === "missing" || target.state === "invalid") return { icon: TriangleAlert, tone: "bad", text };
    return { icon: target.state === "existing" ? Users : Info, tone: "muted", text };
  });
  // Shared with the sidebar banner: a check here shows there too, and both can install.
  const update = $derived(updater.status);
  let checked = $state(false);
  const updateText = $derived(
    updater.message ??
      (!update || (!checked && !update.available)
        ? ""
        : update.error
          ? t("update.failed", { error: update.error })
          : update.available
            ? t("update.available", { v: update.latest })
            : t("settings.upToDate")),
  );

  async function rescan(full: boolean) {
    busy = true;
    try {
      await send(`/api/scan${full ? "?full=1" : ""}`);
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  /** Syncs right away. Turning the sync on runs one too, so the status shows whether Cursor's login works. */
  async function syncCursor() {
    cursorSyncing = true;
    try {
      cursorSync = await send<CursorSync>("/api/cursor/sync");
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      cursorSyncing = false;
    }
  }

  async function toggleCursorSync() {
    await save();
    if (cfg?.cursorSync) await syncCursor();
    else cursorSync = await getJson<CursorSync>("/api/cursor/sync").catch(() => cursorSync);
  }

  async function importCursor(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    importMsg = null;
    try {
      const r = await send<{ imported: number }>("/api/import/cursor", await file.text(), "POST", "text/csv");
      importMsg = t("settings.imported", { n: r.imported });
    } catch (err) {
      importMsg = (err as Error).message;
    }
    (e.currentTarget as HTMLInputElement).value = "";
  }

  async function savePricing() {
    busy = true;
    try {
      const clean = userRules
        .filter((r) => r.pattern.trim())
        .map((r) => ({
          pattern: r.pattern.trim(),
          input: Number(r.input),
          output: Number(r.output),
          cacheRead: r.cacheRead === null || r.cacheRead === undefined || (r.cacheRead as unknown) === "" ? null : Number(r.cacheRead),
          cacheWrite5m: r.cacheWrite5m === null || r.cacheWrite5m === undefined || (r.cacheWrite5m as unknown) === "" ? null : Number(r.cacheWrite5m),
          cacheWrite1h: r.cacheWrite1h === null || r.cacheWrite1h === undefined || (r.cacheWrite1h as unknown) === "" ? null : Number(r.cacheWrite1h),
        }));
      await send("/api/pricing", clean);
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function override(r: Rule) {
    userRules = [...userRules, { ...r, source: "user" }];
  }

  let stopped = $state(false);
  async function quit() {
    await send("/api/shutdown").catch(() => {});
    stopped = true;
  }

  async function loadSize() {
    dbSize = await getJson<NonNullable<typeof dbSize>>("/api/db/size").catch(() => null);
  }
  $effect(() => {
    void currentDb;
    loadSize();
  });

  async function compactDb() {
    compacting = true;
    compactMsg = null;
    try {
      dbSize = await send<NonNullable<typeof dbSize>>("/api/db/compact");
      compactMsg = t("settings.compacted", { size: megabytes(dbSize.bytes) });
    } catch (e) {
      compactMsg = (e as Error).message;
    } finally {
      compacting = false;
    }
  }

  async function checkNow() {
    await checkUpdate(true);
    checked = true;
  }
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("settings.title")} subtitle={t("settings.subtitle")}>
    {#if saved}<span class="inline-flex items-center gap-1 text-xs text-good"><Check size={14} />{saved}</span>{/if}
  </PageHeader>
  {#if errorMsg}<div class="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-bad">{errorMsg}</div>{/if}

  {#if cfg}
    <Card title={t("settings.general")} subtitle={t("settings.generalHint")} divided>
      <SettingRow label={t("settings.language")} hint={t("settings.languageHint")}><LangPicker wide /></SettingRow>
      <SettingRow label={t("settings.theme")} hint={t("settings.themeHint")}><ThemeToggle wide /></SettingRow>
      <SettingRow label={t("settings.userName")} hint={t("settings.userNameHint")}>
        <input class="input w-full" bind:value={cfg.userName} aria-label={t("settings.userName")} />
      </SettingRow>
      <SettingRow label={t("settings.openMode")} hint={t("settings.openModeHint")}>
        <Dropdown
          full
          label={t("settings.openMode")}
          bind:value={cfg.openMode}
          options={(["app", "browser", "none"] as const).map((v) => ({ value: v, label: t(`settings.openMode.${v}`) }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.scanInterval")} hint={t("settings.scanIntervalHint")}>
        <NumberField bind:value={cfg.scanIntervalSec} unit={t("settings.unit.seconds")} label={t("settings.scanInterval")} />
      </SettingRow>
      <SettingRow label={t("settings.promptLimit")} hint={t("settings.promptLimitHint")}>
        <NumberField bind:value={cfg.promptTextLimit} unit={t("settings.unit.characters")} label={t("settings.promptLimit")} />
      </SettingRow>
      {#snippet footer()}
        <button class="btn btn-primary" onclick={() => save()} disabled={busy}>{t("settings.save")}</button>
      {/snippet}
    </Card>

    <Card title={t("settings.database")} subtitle={t("settings.dbHint")} divided>
      <SettingRow label={t("settings.dbInUse")} hint={currentDb}>
        <span class="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-2">
          {currentDb === defaultDb ? t("settings.dbDefault") : t("settings.dbCustom")}
        </span>
      </SettingRow>

      <div class="mb-4 rounded-lg bg-surface-2 px-4 py-3.5">
        <div class="text-xs font-medium text-ink-2">{t("settings.share")}</div>
        <!-- A timeline: the steps side by side joined by a line, or one under the other on a narrow screen. -->
        <ol class="mt-4 grid sm:grid-cols-3">
          {#each [1, 2, 3] as const as n (n)}
            <li class="relative flex gap-3 pb-5 last:pb-0 sm:block sm:pb-0">
              {#if n < 3}
                <span
                  class="absolute top-9 bottom-2 left-[11px] w-0.5 rounded-full bg-linear-to-b from-accent/70 to-accent/15 sm:top-[11px] sm:right-4 sm:bottom-auto sm:left-11 sm:h-0.5 sm:w-auto sm:bg-linear-to-r"
                  aria-hidden="true"
                ></span>
              {/if}
              <span class="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-fill text-[11px] font-semibold text-white shadow-sm ring-4 ring-accent-wash tabular">{n}</span>
              <div class="min-w-0 sm:mt-3 sm:pr-8">
                <div class="text-[13px] font-medium text-ink">{t(`settings.share.step${n}Title`)}</div>
                <div class="mt-0.5 text-xs leading-relaxed text-muted">{t(`settings.share.step${n}`)}</div>
              </div>
            </li>
          {/each}
        </ol>
      </div>

      <SettingRow label={t("settings.dbFolder")} hint={t("settings.share.why")} wide>
        <div class="flex w-full min-w-0 flex-col gap-2">
          {#if syncFolders.length}
            <div class="flex flex-wrap gap-2">
              {#each syncFolders as f (f.path)}
                {@const value = joinPath(f.path, sharedFolder)}
                <button class="btn !h-7 !text-xs" class:pick-on={dbInput === value} title={f.path} onclick={() => (dbInput = value)}><Cloud size={13} />{f.name}</button>
              {/each}
            </div>
          {/if}
          <FolderField class="font-mono text-xs placeholder:font-sans" bind:value={dbInput} placeholder={t("settings.dbFolderPlaceholder")} label={t("settings.dbFolder")} />
          <span
            class="flex min-h-4 items-start gap-1.5 text-[11px]"
            class:text-good={status?.tone === "good"}
            class:text-bad={status?.tone === "bad"}
            class:text-muted={status?.tone === "muted"}
          >
            {#if status}
              <status.icon size={12} class="mt-px shrink-0" />
              <span class="min-w-0 break-all">{status.text}</span>
            {/if}
          </span>
        </div>
      </SettingRow>
      <SettingRow label={t("settings.dbCopy")} hint={t("settings.dbCopyHint")}>
        <Switch bind:checked={copyDb} label={t("settings.dbCopy")} disabled={target?.state !== "new"} />
      </SettingRow>
      <SettingRow label={t("settings.journal")} hint={t("settings.journalHint")}>
        <Dropdown
          full
          label={t("settings.journal")}
          bind:value={cfg.journalMode}
          options={(["auto", "delete", "wal"] as const).map((v) => ({ value: v, label: t(`settings.journal.${v}`) }))}
        />
      </SettingRow>
      <SettingRow label={t("settings.retention")} hint={t("settings.retentionHint")}>
        <Dropdown full label={t("settings.retention")} bind:value={retention} options={retentionOptions} onchange={() => save()} />
      </SettingRow>
      <SettingRow label={t("settings.dbSize")} hint={compactMsg ?? `${t("settings.dbSizeHint")}${dbSize && !dbSize.incremental ? ` ${t("settings.dbSizeOnce")}` : ""}`}>
        <!-- The file's size, and how much of it Compact can give back. Nothing to gain: the button rests, unless the file
             still needs its one-time switch to giving freed space back by itself. -->
        {#if dbSize}
          <span class="flex flex-col items-end leading-tight">
            <span class="text-sm font-medium text-ink tabular">{megabytes(dbSize.bytes)}</span>
            <span class="text-[11px] text-muted">{reclaimable ? t("settings.dbSizeValue", { free: megabytes(dbSize.freeBytes) }) : t("settings.dbNothingFree")}</span>
          </span>
        {/if}
        <button class="btn" onclick={compactDb} disabled={compacting || busy || (!!dbSize && !reclaimable && dbSize.incremental)}>
          {#if compacting}<Loader size={14} class="animate-spin" />{t("settings.compacting")}{:else}<Shrink size={14} />{t("settings.compact")}{/if}
        </button>
      </SettingRow>
      {#snippet footer()}
        {#if currentDb !== defaultDb}
          <button class="btn" onclick={() => (dbInput = "")} disabled={busy}>{t("settings.dbUseDefault")}</button>
        {/if}
        <button class="btn btn-primary" onclick={saveDb} disabled={busy || !canSaveDb}>{t("settings.save")}</button>
      {/snippet}
    </Card>

    <Card title={t("settings.sources")} subtitle={t("settings.sourcesHint")} divided>
      {#each SOURCES as src (src.key)}
        <SettingRow label={t(`settings.source.${src.key}`)} hint={t(`settings.source.${src.key}Hint`)} wide>
          {#snippet lead()}<Switch bind:checked={cfg!.sources.enabled[src.key]} label={t(`settings.source.${src.key}`)} />{/snippet}
          <PathList bind:paths={dirs[src.key]} disabled={!cfg!.sources.enabled[src.key]} />
        </SettingRow>
      {/each}
      <!-- Cursor keeps its usage on cursor.com: one row with both ways in, syncing (the switch) and a CSV import. -->
      <SettingRow label={t("settings.cursor")} hint={t("settings.cursorHint")} wide>
        {#snippet lead()}<Switch bind:checked={cfg!.cursorSync} label={t("settings.cursorSync")} onchange={toggleCursorSync} />{/snippet}
        <div class="flex w-full flex-col items-end gap-2">
          <div class="flex flex-wrap justify-end gap-2">
            <button class="btn" onclick={syncCursor} disabled={!cfg.cursorSync || cursorSyncing || busy}>
              {#if cursorSyncing}<Loader size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}{t("settings.cursorSyncNow")}
            </button>
            <label class="btn cursor-pointer">
              <FileUp size={14} />{t("settings.cursorImport")}
              <input type="file" accept=".csv,text/csv" class="hidden" onchange={importCursor} />
            </label>
          </div>
          {#if importMsg}<span class="text-right text-xs text-ink-2">{importMsg}</span>
          {:else if cfg.cursorSync && cursorStatus}<span class="text-right text-xs" class:text-bad={cursorStatus.bad} class:text-ink-2={!cursorStatus.bad}>{cursorStatus.text}</span>{/if}
        </div>
      </SettingRow>
      {#snippet footer()}
        <button class="btn" onclick={() => rescan(false)} disabled={busy} title={t("settings.rescanHint")}><RefreshCw size={14} />{t("settings.rescan")}</button>
        <button class="btn" onclick={() => rescan(true)} disabled={busy} title={t("settings.fullRescanHint")}>{t("settings.fullRescan")}</button>
        <button class="btn btn-primary" onclick={() => save()} disabled={busy}>{t("settings.save")}</button>
      {/snippet}
    </Card>

    <Card title={t("settings.limits")} subtitle={t("settings.limitsHint")} divided>
      {#each LIMIT_SOURCES as key (key)}
        <SettingRow label={t(`settings.limits.${key}`)} hint={t(`settings.limits.${key}Hint`)}>
          <Switch bind:checked={cfg!.limits[key]} label={t(`settings.limits.${key}`)} onchange={() => save()} />
        </SettingRow>
      {/each}
    </Card>

    {#if cfg.budgets}
      <Card title={t("settings.budgets")} subtitle={t("settings.budgetsHint")} divided>
        <SettingRow label={t("settings.budgetDaily")} hint={t("settings.budgetDailyHint")}>
          <NumberField bind:value={budgetDaily} unit="USD" label={t("settings.budgetDaily")} />
        </SettingRow>
        <SettingRow label={t("settings.budgetMonthly")} hint={t("settings.budgetMonthlyHint")}>
          <NumberField bind:value={budgetMonthly} unit="USD" label={t("settings.budgetMonthly")} />
        </SettingRow>
        <SettingRow label={t("settings.budgetProjects")} hint={t("settings.budgetProjectsHint")} wide={projectBudgets.length > 0}>
          <div class="flex w-full flex-col items-end gap-2">
            {#each projectBudgets as row, i (i)}
              <div class="flex w-full items-center gap-2">
                <div class="min-w-0 flex-1">
                  <Dropdown
                    full
                    label={t("settings.budgetProject")}
                    bind:value={row.project}
                    options={[...projectOptions, ...(row.project && !projectOptions.some((o) => o.value === row.project) ? [{ value: row.project, label: row.project }] : [])]}
                  />
                </div>
                <div class="w-40 shrink-0"><NumberField bind:value={row.cap} unit="USD" label={t("settings.budgetMonthly")} /></div>
                <button class="btn !w-8 shrink-0 justify-center !px-0" aria-label={t("common.remove")} onclick={() => (projectBudgets = projectBudgets.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
              </div>
            {/each}
            <button class="btn" onclick={() => (projectBudgets = [...projectBudgets, { project: "", cap: 0 }])}><Plus size={14} />{t("settings.budgetAddProject")}</button>
          </div>
        </SettingRow>
        <SettingRow label={t("settings.budgetAlerts")} hint={t("settings.budgetAlertsHint")}>
          <Switch bind:checked={cfg.budgets.notify} label={t("settings.budgetAlerts")} onchange={() => saveBudgets()} />
        </SettingRow>
        <SettingRow label={t("settings.limitAlerts")} hint={t("settings.limitAlertsHint")}>
          <Switch bind:checked={cfg.budgets.limitAlerts} label={t("settings.limitAlerts")} onchange={() => saveBudgets()} />
        </SettingRow>
        <SettingRow label={t("settings.testNotification")} hint={testMsg ?? t("settings.testNotificationHint")}>
          <button class="btn" onclick={testNotification}><Bell size={14} />{t("settings.testNotificationSend")}</button>
        </SettingRow>
        {#snippet footer()}
          <button class="btn btn-primary" onclick={saveBudgets} disabled={busy}>{t("settings.save")}</button>
        {/snippet}
      </Card>
    {/if}

    {#if cfg.digest}
      <Card title={t("settings.digest")} subtitle={t("settings.digestHint")} divided>
        <SettingRow label={t("settings.digestEnable")} hint={t("settings.digestEnableHint")}>
          <Switch bind:checked={cfg.digest.enabled} label={t("settings.digestEnable")} onchange={() => saveDigest()} />
        </SettingRow>
        <SettingRow label={t("settings.digestWhen")} hint={t("settings.digestWhenHint")}>
          <div class="min-w-0 flex-1"><Dropdown full label={t("settings.digestDay")} bind:value={digestDay} options={digestDays} onchange={() => saveDigest()} /></div>
          <div class="w-28 shrink-0"><Dropdown full label={t("settings.digestHour")} bind:value={digestHour} options={digestHours} onchange={() => saveDigest()} /></div>
        </SettingRow>
        <SettingRow label={t("settings.digestDir")} hint={t("settings.digestDirHint", { path: digestDefaultDir })} wide>
          <FolderField class="font-mono text-xs placeholder:font-sans" bind:value={digestDir} placeholder={t("settings.digestDirDefault")} label={t("settings.digestDirLabel")} />
        </SettingRow>
        <SettingRow label={t("settings.digestNow")} hint={digestMsg ?? t("settings.digestNowHint")}>
          <button class="btn" onclick={writeDigest}><FileText size={14} />{t("settings.digestNowButton")}</button>
        </SettingRow>
        <SettingRow label={t("settings.digestLast")} hint={digestLast ? digestLast.path : t("settings.digestNone")}>
          {#if digestLast}
            <button class="btn" onclick={() => (digestShown = !digestShown)} aria-expanded={digestShown}>{digestShown ? t("settings.digestHide") : t("settings.digestView")}</button>
          {/if}
        </SettingRow>
        {#if digestShown && digestLast}
          <div class="border-t border-line py-4"><MarkdownView source={digestLast.markdown} /></div>
        {/if}
        {#snippet footer()}
          <button class="btn btn-primary" onclick={saveDigest} disabled={busy}>{t("settings.save")}</button>
        {/snippet}
      </Card>
    {/if}

    {#if cfg.metrics}
      <Card title={t("settings.metrics")} subtitle={t("settings.metricsHint")} divided>
        <SettingRow label={t("settings.metricsEnable")} hint={t("settings.metricsEnableHint")}>
          <Switch bind:checked={cfg.metrics.enabled} label={t("settings.metricsEnable")} onchange={() => saveMetrics({ enabled: cfg!.metrics!.enabled })} />
        </SettingRow>
        {#if cfg.metrics.enabled}
          <SettingRow label={t("settings.metricsUrl")} hint={t("settings.metricsUrlHint")} wide>
            <input class="input w-full font-mono text-xs" readonly value={metricsUrl} aria-label={t("settings.metricsUrl")} onfocus={(e) => e.currentTarget.select()} />
          </SettingRow>
          <SettingRow label={t("settings.metricsToken")} hint={t("settings.metricsTokenHint")} wide>
            <!-- The server makes the token as metrics are turned on: until its answer arrives the field says so. -->
            <input class="input min-w-0 flex-1 font-mono text-xs" readonly value={cfg.metrics.token} placeholder={t("common.loading")} aria-label={t("settings.metricsToken")} aria-busy={!cfg.metrics.token} onfocus={(e) => e.currentTarget.select()} />
            <button class="btn shrink-0" onclick={copyToken}>
              {#if tokenCopied}<Check size={14} />{t("settings.metricsCopied")}{:else}<Copy size={14} />{t("settings.metricsCopy")}{/if}
            </button>
            <button class="btn shrink-0" onclick={() => saveMetrics({ regenerateToken: true })} disabled={busy}><RefreshCw size={14} />{t("settings.metricsRegenerate")}</button>
          </SettingRow>
          <SettingRow label={t("settings.metricsProjects")} hint={t("settings.metricsProjectsHint")}>
            <Switch bind:checked={cfg.metrics.projectLabels} label={t("settings.metricsProjects")} onchange={() => saveMetrics({ projectLabels: cfg!.metrics!.projectLabels })} />
          </SettingRow>
          <SettingRow label={t("settings.metricsExample")} hint={t("settings.metricsExampleHint")}>
            <a class="btn" href={METRICS_DOCS} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t("settings.metricsExampleButton")}</a>
          </SettingRow>
        {/if}
      </Card>
    {/if}

    {#if cfg.labels}
      <Card title={t("settings.labels")} subtitle={t("settings.labelsHint")} divided>
        <SettingRow label={t("settings.labelsEnable")} hint={t("settings.labelsEnableHint")}>
          <Switch bind:checked={cfg.labels.enabled} label={t("settings.labelsEnable")} onchange={() => saveLabels()} />
        </SettingRow>
        {#if cfg.labels.enabled}
          <SettingRow label={t("settings.labelsCli")} hint={t("settings.labelsCliHint")}>
            <Dropdown full label={t("settings.labelsCli")} bind:value={cfg.labels.cli} options={labelClis} onchange={() => saveLabels()} />
          </SettingRow>
          <SettingRow label={t("settings.labelsModel")} hint={t("settings.labelsModelHint")}>
            <input class="input w-full font-mono text-xs" bind:value={cfg.labels.model} maxlength="64" autocomplete="off" spellcheck="false" aria-label={t("settings.labelsModel")} />
          </SettingRow>
          <SettingRow label={t("settings.labelsCap")} hint={t("settings.labelsCapHint")}>
            <NumberField bind:value={cfg.labels.dailyCap} unit={t("settings.unit.sessions")} label={t("settings.labelsCap")} min={1} />
          </SettingRow>
          <SettingRow label={t("settings.labelsNow")} hint={labelCliMissing ? t("settings.labelsNowMissing", { name: CLI_NAMES[cfg.labels.cli] }) : labelLine?.text}>
            <button class="btn" onclick={labelNow} disabled={labelsRunning || busy || labelCliMissing || (labelStatus?.textLimit ?? 1) <= 0}>
              {#if labelsRunning}<Loader size={14} class="animate-spin" />{t("settings.labelsNowRunning")}{:else}<Tags size={14} />{t("settings.labelsNowButton")}{/if}
            </button>
          </SettingRow>
        {/if}
        {#snippet footer()}
          <button class="btn btn-primary" onclick={saveLabels} disabled={busy}>{t("settings.save")}</button>
        {/snippet}
      </Card>
    {/if}

    <TagRules />

    <Card title={t("settings.pricing")} subtitle={t("settings.pricingHint")} divided>
      <div class="card-flush -mx-5 overflow-x-auto">
        <table class="data">
          <thead>
            <tr>
              <th>{t("settings.pattern")}</th><th class="num">{t("tok.input")}</th><th class="num">{t("tok.output")}</th>
              <th class="num">{t("tok.cacheRead")}</th><th class="num">{t("tok.cacheWrite")} 5m</th><th class="num">{t("tok.cacheWrite")} 1h</th><th></th>
            </tr>
          </thead>
          <tbody>
            {#each userRules as r, i (i)}
              <tr>
                <td><input class="input w-48 font-mono" bind:value={r.pattern} placeholder="gpt-5.6*" /></td>
                <td class="num"><input class="input w-20 text-right" type="number" step="0.01" bind:value={r.input} /></td>
                <td class="num"><input class="input w-20 text-right" type="number" step="0.01" bind:value={r.output} /></td>
                <td class="num"><input class="input w-20 text-right" type="number" step="0.001" bind:value={r.cacheRead} placeholder="auto" /></td>
                <td class="num"><input class="input w-20 text-right" type="number" step="0.01" bind:value={r.cacheWrite5m} placeholder="auto" /></td>
                <td class="num"><input class="input w-20 text-right" type="number" step="0.01" bind:value={r.cacheWrite1h} placeholder="auto" /></td>
                <td><button class="btn !w-8 justify-center !px-0" aria-label={t("common.remove")} onclick={() => (userRules = userRules.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
              </tr>
            {:else}
              <tr><td colspan="7" class="!py-5 text-center text-xs text-muted">{t("settings.noRules")}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if showBuiltin}
        <div class="mb-4 max-h-80 overflow-auto rounded-lg border border-line">
          <table class="data">
            <tbody>
              {#each builtinRules as r (r.pattern)}
                <tr>
                  <td class="font-mono text-xs">{r.pattern}</td>
                  <td class="num">${r.input}</td>
                  <td class="num">${r.output}</td>
                  <td class="num text-muted">{r.cacheRead != null ? `$${r.cacheRead}` : "auto"}</td>
                  <td><button class="text-xs text-accent-ink hover:underline" onclick={() => override(r)}>+ {t("settings.addRule")}</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#snippet footer()}
        <button class="btn mr-auto" onclick={() => (showBuiltin = !showBuiltin)}>{t("settings.builtin")} ({builtinRules.length})</button>
        <button class="btn" onclick={() => (userRules = [...userRules, { pattern: "", input: 0, output: 0 }])}><Plus size={14} />{t("settings.addRule")}</button>
        <button class="btn btn-primary" onclick={savePricing} disabled={busy}>{t("settings.save")}</button>
      {/snippet}
    </Card>

    <Card title={t("settings.app")} subtitle={t("settings.appHint")} divided>
      <SettingRow label={t("settings.version", { v: live.status?.version ?? "" })} hint={updateText || live.status?.platform}>
        {#if update?.available && update.canSelfUpdate && !updater.message}
          <button class="btn btn-primary" onclick={installUpdate} disabled={updater.installing}>
            {#if updater.installing}<Loader size={14} class="animate-spin" />{t("update.installing")}{:else}<Download size={14} />{t("update.install")}{/if}
          </button>
        {:else if update?.available && update.releaseUrl && !update.canSelfUpdate}
          <a class="btn" href={update.releaseUrl} target="_blank" rel="noreferrer"><Download size={14} />{t("update.manual")}</a>
        {/if}
        <button class="btn" onclick={checkNow}><RefreshCw size={14} />{t("settings.checkNow")}</button>
      </SettingRow>
      <SettingRow label={t("settings.checkUpdates")} hint={t("settings.checkUpdatesHint")}>
        <Switch bind:checked={cfg.checkUpdates} label={t("settings.checkUpdates")} onchange={() => save()} />
      </SettingRow>
      <SettingRow label={t("settings.quit")} hint={stopped ? t("settings.stopped") : t("settings.quitHint")}>
        <button class="btn" onclick={quit} disabled={stopped}><Power size={14} />{t("settings.quit")}</button>
      </SettingRow>
    </Card>
  {/if}
</div>

<style>
  .pick-on {
    border-color: var(--accent);
    background: var(--accent-wash);
  }
</style>
