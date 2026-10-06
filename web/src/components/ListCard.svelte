<script lang="ts">
  import Card from "./Card.svelte";
  import { t } from "../lib/i18n.svelte.ts";
  import KeyCountList from "./KeyCountList.svelte";
  import Pager from "./Pager.svelte";

  interface Item {
    key: string | null;
    label?: string;
    calls?: number;
    cost?: number;
  }
  /**
   * A side card of a detail page: a short ranked list, ten rows a page with the table pager under it once there is a
   * second page. Bars keep one scale across the pages, so a later page's bars stay short. The page resets when the
   * entries change (another session opened in the same view).
   */
  let {
    title,
    subtitle,
    items,
    value = "calls",
    paths = false,
    link,
    empty,
    class: cls = "",
  }: {
    title: string;
    subtitle?: string;
    items: Item[];
    value?: "calls" | "cost";
    paths?: boolean;
    link?: (key: string) => string;
    /** What an empty list says, e.g. that a prompt touched no files. */
    empty?: string;
    class?: string;
  } = $props();

  const SIZE = 10;
  let page = $state(1);
  // Back to the first page when the entries change, not when the same ones reload (every minute or so).
  const keys = $derived(items.map((i) => i.key).join("\n"));
  $effect(() => {
    void keys;
    page = 1;
  });
  const max = $derived(Math.max(1e-9, ...items.map((i) => (value === "cost" ? (i.cost ?? 0) : (i.calls ?? 0)))));
</script>

<Card {title} {subtitle} pad={false} class={cls}>
  <div class="px-5 pt-1 pb-3">
    {#if items.length}
      <KeyCountList items={items.slice((page - 1) * SIZE, page * SIZE)} {value} {paths} {link} {max} />
    {:else}
      <p class="py-2 text-sm text-muted">{empty ?? t("empty.noData")}</p>
    {/if}
  </div>
  {#if items.length > SIZE}
    <Pager {page} total={items.length} size={SIZE} onpage={(p) => (page = p)} />
  {/if}
</Card>
