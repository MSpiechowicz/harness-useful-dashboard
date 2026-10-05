<script lang="ts">
  let { checked, label, hint, onchange }: { checked: boolean; label: string; hint?: string; onchange: (checked: boolean) => void } = $props();
</script>

<!-- A switch inside a regular button, so it reads like the other header controls rather than a stray checkbox. -->
<button type="button" class="btn toggle" class:on={checked} role="switch" aria-checked={checked} title={hint} onclick={() => onchange(!checked)}>
  <span class="switch" class:on={checked}></span>
  {label}
</button>

<style>
  .toggle.on {
    border-color: var(--accent);
    background: var(--accent-wash);
  }
</style>
