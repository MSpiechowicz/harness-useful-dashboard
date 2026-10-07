<script lang="ts">
  /** A session's tags as small pills, the first few and a count for the rest (the full list is its tooltip). */
  let { tags, max = 2 }: { tags: string[]; max?: number } = $props();
</script>

{#each tags.slice(0, max) as tag (tag)}
  <span class="max-w-24 shrink-0 truncate rounded bg-surface-2 px-1.5 text-[10px] text-accent-ink" title={tag}>{tag}</span>
{/each}
{#if tags.length > max}<span class="shrink-0 text-[10px] text-muted" title={tags.slice(max).join(", ")}>+{tags.length - max}</span>{/if}
