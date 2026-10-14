<script lang="ts">
  import { untrack } from "svelte";

  /**
   * The sections of a long page, as a list to jump between them. Each item scrolls its section into view (the page
   * scrolls in the window, under the sticky header: the sections keep a `scroll-margin-top` for it) and moves focus to
   * the section's heading. It does not touch the hash: that is the app's route. The section being read is marked.
   * Sections are elements with the item's `id`. Place it in a sticky column, see Settings.
   */
  interface Props {
    items: { id: string; label: string }[];
    label: string;
  }
  let { items, label }: Props = $props();

  // The band of the viewport that counts as "being read": below the sticky header, down to a bit above the middle.
  const BAND = "-80px 0px -60% 0px";
  // The scroll a click starts holds the clicked item until it has been still this long, then the scrollspy takes over.
  const IDLE_MS = 300;
  // The list only shows on wide screens: below it nothing is observed.
  const WIDE = "(min-width: 1280px)";

  let active = $state<string | null>(null);
  let wide = $state(matchMedia(WIDE).matches);
  let pinned = false;
  let release: ReturnType<typeof setTimeout> | undefined;

  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  $effect(() => {
    const query = matchMedia(WIDE);
    const update = () => (wide = query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  });

  // Every scroll event while pinned pushes the release back, so a long smooth scroll stays pinned until it ends.
  function hold() {
    pinned = true;
    clearTimeout(release);
    release = setTimeout(() => (pinned = false), IDLE_MS);
  }

  function go(id: string) {
    const section = document.getElementById(id);
    if (!section) return;

    // The last sections may not be able to reach the top of the page: they are marked by the click.
    active = id;
    hold();

    section.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    section.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }

  $effect(() => {
    if (!wide) return;

    const ids = items.map((i) => i.id);
    const sections = ids.flatMap((id) => document.getElementById(id) ?? []);
    const inBand = new Set<string>();

    // Out of the list (a section that is gone), the first one is marked.
    untrack(() => {
      if (!active || !ids.includes(active)) active = ids[0] ?? null;
    });

    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

    function read() {
      if (pinned) return;

      // At the end of the page the last section is the one being read, even if it never reaches the band.
      if (atBottom() && window.scrollY > 0) {
        active = ids[ids.length - 1] ?? null;
        return;
      }

      const first = ids.find((id) => inBand.has(id));
      if (first) active = first;
    }

    function onScroll() {
      if (pinned) hold();
      else read();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) inBand.add(e.target.id);
          else inBand.delete(e.target.id);
        }
        read();
      },
      { rootMargin: BAND },
    );
    for (const s of sections) observer.observe(s);

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  });
</script>

<nav aria-label={label}>
  <ul class="flex flex-col gap-0.5">
    {#each items as item (item.id)}
      <li>
        <button
          type="button"
          class="flex h-7 w-full items-center rounded-lg px-3 text-left text-sm transition-colors {active === item.id ? 'bg-accent-wash font-medium text-accent-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'}"
          aria-current={active === item.id ? "true" : undefined}
          onclick={() => go(item.id)}
        >
          <span class="truncate">{item.label}</span>
        </button>
      </li>
    {/each}
  </ul>
</nav>
