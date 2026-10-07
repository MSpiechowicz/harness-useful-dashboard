<script lang="ts">
  /** A sortable column header. The arrow is only drawn: screen readers get the direction from aria-sort. */
  interface Props {
    label: string;
    /** The direction when the table is sorted by this column. */
    sort?: "ascending" | "descending";
    num?: boolean;
    onclick: () => void;
  }
  let { label, sort, num = false, onclick }: Props = $props();
</script>

<th class:num aria-sort={sort}>
  <button type="button" {onclick}>{label}{#if sort}<span aria-hidden="true">{sort === "ascending" ? " ↑" : " ↓"}</span>{/if}</button>
</th>
