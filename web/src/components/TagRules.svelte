<script lang="ts">
  import { Check, Plus, Trash2 } from "@lucide/svelte";
  import { getJson, send } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import Card from "./Card.svelte";
  import Dropdown from "./Dropdown.svelte";
  import SettingRow from "./SettingRow.svelte";

  /** Settings: the default tag of a project. Stored in the database, so every machine sharing it has the same. */
  let rows = $state<{ project: string; tag: string }[]>([]);
  let projects = $state<{ value: string; label: string }[]>([]);
  let busy = $state(false);
  let saved = $state(false);
  let failed = $state(false);

  $effect(() => {
    getJson<{ project: string; tag: string }[]>("/api/tags/rules").then((r) => (rows = r)).catch(() => {});
    getJson<{ project: { value: string; label: string }[] }>("/api/filters")
      .then((f) => (projects = f.project.filter((p) => p.value !== "(none)").map((p) => ({ value: p.value, label: p.label }))))
      .catch(() => {});
  });

  async function save() {
    busy = true;
    saved = failed = false;
    try {
      rows = await send<typeof rows>("/api/tags/rules", { rules: rows.filter((r) => r.project && r.tag.trim()) }, "PUT");
      saved = true;
      store.refreshTick++;
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
</script>

<Card title={t("settings.tags")} subtitle={t("settings.tagsHint")} divided>
  <SettingRow label={t("settings.tagRules")} hint={t("settings.tagRulesHint")} wide>
    <div class="flex w-full flex-col items-end gap-2">
      {#each rows as row, i (i)}
        <div class="flex w-full items-center gap-2">
          <div class="min-w-0 flex-1">
            <Dropdown
              full
              label={t("settings.tagRuleProject")}
              bind:value={row.project}
              options={[...projects, ...(row.project && !projects.some((o) => o.value === row.project) ? [{ value: row.project, label: row.project }] : [])]}
            />
          </div>
          <input class="input w-40 shrink-0" bind:value={row.tag} maxlength="32" autocomplete="off" aria-label={t("settings.tagRuleTag")} placeholder={t("settings.tagRuleTag")} />
          <button class="btn !w-8 shrink-0 justify-center !px-0" aria-label={t("common.remove")} onclick={() => (rows = rows.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
        </div>
      {/each}
      <button class="btn" onclick={() => (rows = [...rows, { project: "", tag: "" }])}><Plus size={14} />{t("settings.tagRuleAdd")}</button>
    </div>
  </SettingRow>
  {#snippet footer()}
    {#if failed}<span class="mr-auto text-xs text-bad" role="alert">{t("tags.failed")}</span>{:else if saved}<span class="mr-auto inline-flex items-center gap-1 text-xs text-good"><Check size={14} />{t("settings.saved")}</span>{/if}
    <button class="btn btn-primary" onclick={save} disabled={busy}>{t("settings.save")}</button>
  {/snippet}
</Card>
