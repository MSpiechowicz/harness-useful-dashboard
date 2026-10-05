<script lang="ts">
  let { size = 16, label }: { size?: number; label?: string } = $props();
</script>

<!-- A quarter arc rotating over a faint full ring; currentColor so it follows the surrounding text. -->
<svg class="shrink-0 animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
  <circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-opacity="0.2" stroke-width="2.5" />
  <path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
</svg>
