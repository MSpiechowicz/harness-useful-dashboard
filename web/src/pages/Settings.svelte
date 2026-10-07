<script lang="ts">
  import { Check, Cloud, Download, FileUp, Info, Loader, Plus, Power, RefreshCw, Trash2, TriangleAlert, Users } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import Dropdown from "../components/Dropdown.svelte";
  import LangPicker from "../components/LangPicker.svelte";
  import NumberField from "../components/NumberField.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import PathList from "../components/PathList.svelte";
  import SettingRow from "../components/SettingRow.svelte";
  import Switch from "../components/Switch.svelte";
  import ThemeToggle from "../components/ThemeToggle.svelte";
  import { getJson, send } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { live } from "../lib/live.svelte.ts";
  import { checkUpdate, installUpdate, updater } from "../lib/update.svelte.ts";

  type SourceKey = "claude" | "codex" | "omp" | "pi" | "opencode" | "zed" | "cline" | "roo" | "kilo";
  type DirsKey = "claudeDirs" | "codexDirs" | "ompDirs" | "piDirs" | "opencodeDirs" | "zedDirs" | "clineDirs" | "rooDirs" | "kiloDirs";
  type LimitKey = "claude" | "codex" | "omp" | "pi" | "opencode";
  interface Config {
    dbPath: string;
    journalMode: "auto" | "wal" | "delete";
    userName: string;
    openMode: "app" | "browser" | "none";
    scanIntervalSec: number;
    promptTextLimit: number;
    checkUpdates: boolean;
    sources: Record<DirsKey, string[]> & { enabled: Record<SourceKey, boolean> };
    limits: Record<LimitKey, boolean>;
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
  ];
  /** Where plan limits can be read from (see Live). */
  const LIMIT_SOURCES: LimitKey[] = ["claude", "codex", "opencode", "pi", "omp"];

  let cfg = $state<Config | null>(null);
  let currentDb = $state("");
  let defaultDb = $state("");
  let syncFolders = $state<Settings["syncFolders"]>([]);
  let sharedFolder = $state("");
  let dbInput = $state("");
  let target = $state<{ file: string; state: DbState } | null>(null);
  let copyDb = $state(true);
  let dirs = $state<Record<SourceKey, string[]>>({ claude: [""], codex: [""], omp: [""], pi: [""], opencode: [""], zed: [""], cline: [""], roo: [""], kilo: [""] });
  let saved = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);
  let userRules = $state<Rule[]>([]);
  let builtinRules = $state<Rule[]>([]);
  let showBuiltin = $state(false);
  let importMsg = $state<string | null>(null);

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
  }

  async function load() {
    apply(await getJson<Settings>("/api/settings"));
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
        sources: { ...Object.fromEntries(SOURCES.filter((src) => knownDirs.has(src.dirs)).map((src) => [src.dirs, clean(dirs[src.key])])), enabled: cfg.sources.enabled },
        limits: cfg.limits,
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
          <input class="input w-full font-mono text-xs placeholder:font-sans" bind:value={dbInput} placeholder={t("settings.dbFolderPlaceholder")} aria-label={t("settings.dbFolder")} spellcheck="false" autocomplete="off" />
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
      <SettingRow label={t("settings.cursor")} hint={t("settings.cursorHint")} wide>
        {#snippet lead()}<span class="block w-7"></span>{/snippet}
        <div class="flex w-full flex-wrap items-center gap-3">
          <label class="btn w-fit">
            <FileUp size={14} />{t("settings.cursorImport")}
            <input type="file" accept=".csv,text/csv" class="hidden" onchange={importCursor} />
          </label>
          {#if importMsg}<span class="text-xs text-ink-2">{importMsg}</span>{/if}
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
