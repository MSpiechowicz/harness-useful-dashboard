<script lang="ts">
  import { type Inline, parseMarkdown } from "../lib/markdown.ts";

  /** A report's Markdown drawn as elements, from the reader of lib/markdown.ts. Nothing here becomes HTML. */
  let { source }: { source: string } = $props();
  const blocks = $derived(parseMarkdown(source));
</script>

{#snippet inline(parts: Inline[])}
  {#each parts as p, i (i)}
    {#if p.kind === "bold"}<strong class="font-semibold text-ink">{p.text}</strong>
    {:else if p.kind === "em"}<em class="text-muted">{p.text}</em>
    {:else if p.kind === "code"}<code class="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px]">{p.text}</code>
    {:else}{p.text}{/if}
  {/each}
{/snippet}

<div class="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-2">
  {#each blocks as b, i (i)}
    {#if b.kind === "heading"}
      <h3 class="text-ink {b.level === 1 ? 'text-base font-semibold' : 'mt-2 border-t border-line pt-3 text-sm font-semibold'}">{@render inline(b.inline)}</h3>
    {:else if b.kind === "paragraph"}
      <p>{@render inline(b.inline)}</p>
    {:else if b.kind === "list"}
      <svelte:element this={b.ordered ? "ol" : "ul"} class="flex flex-col gap-1 pl-5 {b.ordered ? 'list-decimal' : 'list-disc'}">
        {#each b.items as item, j (j)}<li>{@render inline(item)}</li>{/each}
      </svelte:element>
    {:else}
      <div class="overflow-x-auto">
        <table class="data">
          <thead>
            <tr>{#each b.head as cell, j (j)}<th class={b.align[j] === "right" ? "num" : ""}>{@render inline(cell)}</th>{/each}</tr>
          </thead>
          <tbody>
            {#each b.rows as row, r (r)}
              <tr>{#each row as cell, j (j)}<td class={b.align[j] === "right" ? "num" : ""}>{@render inline(cell)}</td>{/each}</tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/each}
</div>
