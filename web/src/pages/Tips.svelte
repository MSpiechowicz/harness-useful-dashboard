<script lang="ts">
  import ViewGate from "../components/ViewGate.svelte";
  import Empty from "../components/Empty.svelte";
  import PageHeader from "../components/PageHeader.svelte";
  import TipCard from "../components/TipCard.svelte";
  import { apiUrl, settled, useFetch, type Tip } from "../lib/api.svelte.ts";
  import { t } from "../lib/i18n.svelte.ts";

  const tips = useFetch<Tip[]>(() => apiUrl("/api/tips"));
</script>

<div class="flex flex-col gap-5">
  <PageHeader title={t("tips.title")} subtitle={t("tips.subtitle")} />
  <ViewGate ready={settled(tips)}>
    {#if tips.data && tips.data.length === 0}
      <div class="card"><Empty title={t("tips.none")} compact /></div>
    {:else if tips.data}
      <div class="grid gap-3 lg:grid-cols-2" class:loading-dim={tips.loading}>
        {#each tips.data as tip (tip.id)}<TipCard {tip} />{/each}
      </div>
    {/if}
  </ViewGate>
</div>
