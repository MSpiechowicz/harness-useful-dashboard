<script lang="ts">
  import { Loader, RefreshCw, X } from "@lucide/svelte";
  import { send, useFetch } from "../lib/api.svelte.ts";
  import { kindName } from "../lib/format.ts";
  import { t } from "../lib/i18n.svelte.ts";
  import { store } from "../lib/state.svelte.ts";
  import Dropdown from "./Dropdown.svelte";

  interface Props {
    /** The session's id. */
    id: string;
    /** Its label: the kind and the AI's title, null when it has none. */
    label: { title: string; kind: string; model: string } | null;
  }
  let { id, label }: Props = $props();

  const KINDS = ["feature", "bugfix", "refactor", "tests", "docs", "research", "ops", "other"];
  const status = useFetch<{ config: { enabled: boolean } }>(() => "/api/labels");
  const enabled = $derived(!!status.data?.config.enabled);

  let kind = $state("");
  $effect(() => {
    kind = label?.kind ?? "";
  });
  let busy = $state(false);
  let failed = $state(false);

  /** Changed data other views show (the kind filter, the lists, the title): they load again. */
  const changed = () => store.refreshTick++;

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    failed = false;
    try {
      await action();
      changed();
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }
  const setKind = (value: string) => run(() => send("/api/session/label", { session: id, kind: value }, "PUT"));
  const again = () => run(() => send<{ run: { labelled: number } }>("/api/session/label", { session: id }).then((r) => (r.run.labelled > 0 ? r : Promise.reject(new Error("not labelled")))));
  const clear = () => run(() => send("/api/session/label", { session: id }, "DELETE"));
</script>

<!-- Only once labels are on, or when the session has one from before. -->
{#if enabled || label}
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <div class="w-52">
      <Dropdown full prefix labelWhenEmpty label={t("label.kind")} value={kind} active={kind !== ""} options={KINDS.map((k) => ({ value: k, label: kindName(k) }))} onchange={setKind} />
    </div>
    {#if enabled}
      <button type="button" class="btn" disabled={busy} onclick={again}>
        {#if busy}<Loader size={14} class="animate-spin" />{t("label.working")}{:else}<RefreshCw size={14} />{t("label.again")}{/if}
      </button>
    {/if}
    {#if label}
      <button type="button" class="btn" disabled={busy} onclick={clear}><X size={14} />{t("label.clear")}</button>
    {/if}
    {#if failed}<span class="text-xs text-bad" role="alert">{t("label.failed")}</span>{/if}
  </div>
{/if}
