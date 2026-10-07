<script lang="ts">
  import type { Snippet } from "svelte";
  import { withQuery } from "../lib/state.svelte.ts";

  /**
   * A link to a view of this app (a "#/…" route). It is not an <a href>: Chrome shows the URL of every real link the
   * pointer rests on in a bubble at the bottom corner, which in the app window covers part of the page.
   */
  interface Props {
    to: string;
    class?: string;
    title?: string;
    "aria-label"?: string;
    "aria-current"?: "page";
    onclick?: () => void;
    children: Snippet;
  }
  let { to, class: cls = "", title, "aria-label": ariaLabel, "aria-current": ariaCurrent, onclick, children }: Props = $props();

  function go() {
    onclick?.();
    location.hash = withQuery(to).replace(/^#/, "");
  }
</script>

<span
  role="link"
  tabindex="0"
  class="cursor-pointer {cls}"
  {title}
  aria-label={ariaLabel}
  aria-current={ariaCurrent}
  onclick={go}
  onkeydown={(e) => {
    if (e.key === "Enter") go();
  }}>{@render children()}</span
>
