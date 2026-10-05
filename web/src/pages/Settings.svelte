<script lang="ts">
  import { Check, FileUp, Plus, Power, RefreshCw, Trash2 } from "@lucide/svelte";
  import Card from "../components/Card.svelte";
  import LangPicker from "../components/LangPicker.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import ThemeToggle from "../components/ThemeToggle.svelte";
  import { getJson, send, type UpdateStatus } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { live } from "../lib/live.svelte.ts";

  interface Config {
    dbPath: string;
    journalMode: "auto" | "wal" | "delete";
    userName: string;
    openMode: "app" | "browser" | "none";
    scanIntervalSec: number;
    promptTextLimit: number;
    checkUpdates: boolean;
    sources: { claudeDirs: string[]; codexDirs: string[]; enabled: { claude: boolean; codex: boolean } };
  }
  interface Rule {
    pattern: string;
    input: number;
    output: number;
    cacheRead?: number | null;
    cacheWrite5m?: number | null;
    cacheWrite1h?: number | null;
    source?: "builtin" | "user";
  }

  let cfg = $state<Config | null>(null);
  let currentDb = $state("");
  let dbPath = $state("");
  let copyDb = $state(true);
  let claudeDirs = $state("");
  let codexDirs = $state("");
  let saved = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let busy = $state(false);
  let userRules = $state<Rule[]>([]);
  let builtinRules = $state<Rule[]>([]);
  let showBuiltin = $state(false);
  let update = $state<UpdateStatus | null>(null);
  let importMsg = $state<string | null>(null);

  async function load() {
    const s = await getJson<{ config: Config; dbPath: string }>("/api/settings");
    cfg = s.config;
    currentDb = s.dbPath;
    dbPath = s.config.dbPath;
    claudeDirs = s.config.sources.claudeDirs.join("\n");
    codexDirs = s.config.sources.codexDirs.join("\n");
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
      const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
      const r = await send<{ config: Config; dbPath: string }>("/api/settings", {
        userName: cfg.userName,
        openMode: cfg.openMode,
        scanIntervalSec: Number(cfg.scanIntervalSec),
        promptTextLimit: Number(cfg.promptTextLimit),
        checkUpdates: cfg.checkUpdates,
        journalMode: cfg.journalMode,
        sources: { claudeDirs: lines(claudeDirs), codexDirs: lines(codexDirs), enabled: cfg.sources.enabled },
        ...extra,
      });
      cfg = r.config;
      currentDb = r.dbPath;
      flash(t("settings.saved"));
    } catch (e) {
      errorMsg = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  async function saveDb() {
    await save({ dbPath, copyDb });
  }

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

  async function checkUpdate() {
    update = await getJson<UpdateStatus>("/api/update?force=1");
  }
</script>

<div class="flex max-w-4xl flex-col gap-5">
  <PageHeader title={t("settings.title")}>
    {#if saved}<span class="inline-flex items-center gap-1 text-xs text-good"><Check size={14} />{saved}</span>{/if}
  </PageHeader>
  {#if errorMsg}<div class="rounded-lg border border-line bg-surface px-4 py-3 text-sm text-bad">{errorMsg}</div>{/if}

  {#if cfg}
    <Card title={t("settings.general")}>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.language")}</span>
          <LangPicker />
        </div>
        <div class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.theme")}</span>
          <div><ThemeToggle /></div>
        </div>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.userName")}</span>
          <input class="input" bind:value={cfg.userName} />
          <span class="text-[11px] text-muted">{t("settings.userNameHint")}</span>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.openMode")}</span>
          <select class="input" bind:value={cfg.openMode}>
            <option value="app">{t("settings.openMode.app")}</option>
            <option value="browser">{t("settings.openMode.browser")}</option>
            <option value="none">{t("settings.openMode.none")}</option>
          </select>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.scanInterval")}</span>
          <input class="input" type="number" min="0" bind:value={cfg.scanIntervalSec} />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.promptLimit")}</span>
          <input class="input" type="number" min="0" bind:value={cfg.promptTextLimit} />
        </label>
      </div>
      <div class="mt-4"><button class="btn btn-primary" onclick={() => save()} disabled={busy}>{t("settings.save")}</button></div>
    </Card>

    <Card title={t("settings.database")} subtitle={t("settings.dbPathHint")}>
      <div class="flex flex-col gap-3">
        <div class="text-xs text-muted">{t("settings.dbCurrent")}: <span class="font-mono text-ink-2">{currentDb}</span></div>
        <label class="flex flex-col gap-1.5">
          <span class="text-xs font-medium text-ink-2">{t("settings.dbPath")}</span>
          <input class="input font-mono" placeholder="~/Library/Mobile Documents/com~apple~CloudDocs/harness/usage.db" bind:value={dbPath} />
        </label>
        <label class="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" bind:checked={copyDb} />{t("settings.dbCopy")}</label>
        <label class="flex flex-col gap-1.5 sm:max-w-xs">
          <span class="text-xs font-medium text-ink-2">{t("settings.journal")}</span>
          <select class="input" bind:value={cfg.journalMode}>
            <option value="auto">{t("settings.journal.auto")}</option>
            <option value="delete">{t("settings.journal.delete")}</option>
            <option value="wal">{t("settings.journal.wal")}</option>
          </select>
          <span class="text-[11px] text-muted">{t("settings.journalHint")}</span>
        </label>
        <div><button class="btn btn-primary" onclick={saveDb} disabled={busy}>{t("settings.save")}</button></div>
      </div>
    </Card>

    <Card title={t("settings.sources")}>
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="flex flex-col gap-1.5">
          <span class="flex items-center gap-2 text-xs font-medium text-ink-2"><input type="checkbox" bind:checked={cfg.sources.enabled.claude} />{t("settings.claudeDirs")}</span>
          <textarea class="input !h-20 py-1.5 font-mono text-xs" bind:value={claudeDirs}></textarea>
          <span class="text-[11px] text-muted">{t("settings.onePerLine")}</span>
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="flex items-center gap-2 text-xs font-medium text-ink-2"><input type="checkbox" bind:checked={cfg.sources.enabled.codex} />{t("settings.codexDirs")}</span>
          <textarea class="input !h-20 py-1.5 font-mono text-xs" bind:value={codexDirs}></textarea>
          <span class="text-[11px] text-muted">{t("settings.onePerLine")}</span>
        </label>
      </div>
      <div class="mt-4 flex flex-wrap gap-2">
        <button class="btn btn-primary" onclick={() => save()} disabled={busy}>{t("settings.save")}</button>
        <button class="btn" onclick={() => rescan(false)} disabled={busy}><RefreshCw size={14} />{t("settings.rescan")}</button>
        <button class="btn" onclick={() => rescan(true)} disabled={busy}>{t("settings.fullRescan")}</button>
      </div>
      <div class="mt-5 border-t border-line pt-4">
        <div class="text-sm font-medium">{t("settings.cursor")}</div>
        <p class="mt-1 text-xs text-muted">{t("settings.cursorHint")}</p>
        <label class="btn mt-3 w-fit">
          <FileUp size={14} />{t("settings.cursorImport")}
          <input type="file" accept=".csv,text/csv" class="hidden" onchange={importCursor} />
        </label>
        {#if importMsg}<span class="ml-2 text-xs text-ink-2">{importMsg}</span>{/if}
      </div>
    </Card>

    <Card title={t("settings.pricing")} subtitle={t("settings.pricingHint")}>
      <div class="overflow-x-auto">
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
                <td><button class="btn !px-2" aria-label={t("common.remove")} onclick={() => (userRules = userRules.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <button class="btn" onclick={() => (userRules = [...userRules, { pattern: "", input: 0, output: 0 }])}><Plus size={14} />{t("settings.addRule")}</button>
        <button class="btn btn-primary" onclick={savePricing} disabled={busy}>{t("settings.save")}</button>
        <button class="btn ml-auto" onclick={() => (showBuiltin = !showBuiltin)}>{t("settings.builtin")} ({builtinRules.length})</button>
      </div>
      {#if showBuiltin}
        <div class="mt-3 max-h-80 overflow-auto rounded-lg border border-line">
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
    </Card>

    <Card title={t("settings.updates")}>
      <div class="flex flex-col gap-3">
        <div class="text-sm">{t("settings.version", { v: live.status?.version ?? "" })} <span class="text-xs text-muted">({live.status?.platform})</span></div>
        <label class="flex items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" bind:checked={cfg.checkUpdates} onchange={() => save()} />{t("settings.checkUpdates")}
        </label>
        <div class="flex items-center gap-3">
          <button class="btn" onclick={checkUpdate}><RefreshCw size={14} />{t("settings.checkNow")}</button>
          {#if update}
            <span class="text-xs text-ink-2">
              {#if update.error}{t("update.failed", { error: update.error })}{:else if update.available}{t("update.available", { v: update.latest })}{:else}{t("settings.upToDate")}{/if}
            </span>
          {/if}
        </div>
      </div>
    </Card>

    <Card title={t("settings.quit")} subtitle={t("settings.quitHint")}>
      {#if stopped}
        <p class="text-sm text-ink-2">{t("settings.stopped")}</p>
      {:else}
        <button class="btn" onclick={quit}><Power size={14} />{t("settings.quit")}</button>
      {/if}
    </Card>
  {/if}
</div>
