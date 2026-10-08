/**
 * Lets a table's columns be resized by dragging the right edge of their header, or with the arrow keys on it, and
 * remembers the widths in this browser under `key` (without one, while the table is on the page). Double-clicking an edge puts
 * its column back. The first column takes what's left, so its edge sets the least it gets: the table grows past the
 * card and scrolls sideways rather than squeeze it.
 *
 * A fixed-layout table keeps its `<colgroup>` widths until a column is resized. A table laid out by its content keeps
 * that layout until then too, and from then on holds the widths its columns had. The edges follow the header: they
 * are set again when its columns or their names change.
 *
 * A table with a key can also hide columns (ColumnsMenu.svelte lists them): any but the first, which names its rows,
 * and those without a name (a row's buttons), nor a column whose header has `data-fixed`. Hidden columns are remembered with the widths.
 */
import type { Action } from "svelte/action";
import { SvelteSet } from "svelte/reactivity";
import { t } from "./i18n.svelte.ts";

const MIN = 48;
const STEP = 16;
const storeKey = (key: string) => `hd.cols.${key}`;
// The widths of a table without a key, kept while it is on the page.
const unsaved = new WeakMap<HTMLTableElement, Record<number, number>>();

function load(table: HTMLTableElement, key: string | undefined): Record<number, number> {
  if (!key) return { ...unsaved.get(table) };
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(key)) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function save(table: HTMLTableElement, key: string | undefined, widths: Record<number, number>) {
  if (!key) return void unsaved.set(table, { ...widths });
  try {
    if (Object.keys(widths).length) localStorage.setItem(storeKey(key), JSON.stringify(widths));
    else localStorage.removeItem(storeKey(key));
  } catch {
    // Without storage the widths last until the page is left.
  }
}

let nextId = 0;

/** The columns of a table with a key, and which of them are hidden. */
export class ColumnSet {
  names = $state<string[]>([]);
  /** The columns whose header says they always show (`data-fixed`). */
  fixed = $state<boolean[]>([]);
  hidden = $state<number[]>([]);
  readonly #id = String(++nextId);
  readonly #style = document.createElement("style");
  // Rows come and go with the data: each new one's spanning cells are fitted to the columns left.
  readonly #rows = new MutationObserver(() => this.#fitSpans());

  constructor(
    readonly table: HTMLTableElement,
    readonly key: string,
    private readonly relayout: () => void,
  ) {
    try {
      const v = JSON.parse(localStorage.getItem(`hd.hide.${key}`) ?? "[]");
      if (Array.isArray(v)) this.hidden = v.filter((i): i is number => Number.isInteger(i) && i > 0);
    } catch {
      // Without storage every column shows.
    }
    table.dataset.cols = this.#id;
    document.head.append(this.#style);
    this.#rows.observe(table, { childList: true, subtree: true });
    this.#write();
  }

  /** Whether a column can be hidden: not the first, not one without a name, and not one marked fixed. */
  hideable(i: number) {
    return i > 0 && !!this.names[i] && !this.fixed[i];
  }

  isHidden(i: number) {
    return this.hidden.includes(i);
  }

  show(i: number, visible: boolean) {
    if (!this.hideable(i) || visible !== this.isHidden(i)) return;
    this.#set(visible ? this.hidden.filter((h) => h !== i) : [...this.hidden, i].sort((a, b) => a - b));
  }

  showAll() {
    this.#set([]);
  }

  dispose() {
    this.#rows.disconnect();
    this.#fitSpans([]);
    this.#style.remove();
    delete this.table.dataset.cols;
  }

  #set(hidden: number[]) {
    this.hidden = hidden;
    try {
      if (hidden.length) localStorage.setItem(`hd.hide.${this.key}`, JSON.stringify(hidden));
      else localStorage.removeItem(`hd.hide.${this.key}`);
    } catch {
      // Without storage they stay hidden until the page is left.
    }
    this.#write();
    this.relayout();
  }

  /**
   * A cell spanning columns (a row across the table) spans only those of them that show: else the hidden columns'
   * slots stay in the table, empty, at the end of every other row. Its own span is kept to come back to.
   */
  #fitSpans(hidden = this.hidden) {
    for (const row of this.table.querySelectorAll<HTMLTableRowElement>(":scope > :is(tbody, tfoot) > tr")) {
      let col = 0;
      for (const cell of row.cells) {
        const own = Number(cell.dataset.span ?? cell.colSpan);
        if (own > 1 || cell.dataset.span) {
          cell.dataset.span = String(own);
          const gone = hidden.filter((h) => h >= col && h < col + own).length;
          const span = Math.max(1, own - gone);
          if (cell.colSpan !== span) cell.colSpan = span;
        }
        col += own;
      }
    }
  }

  // A hidden column's cells and its <col> leave the layout. A cell spanning columns stays, fitted to those left.
  #write() {
    this.#fitSpans();
    const t = `table[data-cols="${this.#id}"]`;
    this.#style.textContent = this.hidden.length
      ? `${this.hidden.map((i) => `${t} > :is(thead, tbody, tfoot) > tr > :nth-child(${i + 1}), ${t} > colgroup > col:nth-child(${i + 1})`).join(",\n")} { display: none; }`
      : "";
  }
}

/** The tables on the page whose columns can be hidden, for the menus of the cards they are in. */
export const columnSets = new SvelteSet<ColumnSet>();

/** A header's name as it shows: a column named only for screen readers (a row's buttons) has none to list. */
function visibleName(th: HTMLTableCellElement): string {
  const copy = th.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(".sr-only, .col-resize")) el.remove();
  return copy.textContent?.trim() ?? "";
}

/** Adds the edges to one layout of the table's header. Returns what undoes it. */
function setup(table: HTMLTableElement, key: string | undefined, set: ColumnSet | null): () => void {
  const ths = [...table.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr:first-child > th")];
  if (set) {
    set.names = ths.map(visibleName);
    set.fixed = ths.map((th) => th.hasAttribute("data-fixed"));
  }
  if (!ths.length) return () => {};
  let group = table.querySelector<HTMLTableColElement>(":scope > colgroup");
  const created = !group;
  if (!group) {
    group = document.createElement("colgroup");
    for (const _ of ths) group.append(document.createElement("col"));
    table.prepend(group);
  }
  const cols = [...group.querySelectorAll<HTMLTableColElement>(":scope > col")];
  // A header cell spanning columns has no one width to drag.
  if (cols.length !== ths.length) {
    if (created) group.remove();
    return () => {};
  }

  const widths = load(table, key);
  // Each column's width as the page lays it out, measured once there is a width to measure, before any is set. The
  // first column's is the least it gets: in a fixed layout what the stylesheet leaves it, else what it has.
  let defaults: number[] | null = null;
  const measure = () => {
    if (defaults) return defaults;
    const own = ths.map((th) => th.getBoundingClientRect().width);
    if (!own.some((w) => w > 0)) return null;
    if (getComputedStyle(table).tableLayout === "fixed") {
      const rest = own.slice(1).reduce((a, b) => a + b, 0);
      own[0] = (parseFloat(getComputedStyle(table).minWidth) || 0) - rest;
    }
    own[0] = Math.max(MIN, own[0]!);
    return (defaults = own);
  };
  const reset = () => {
    for (const c of cols) c.style.width = "";
    table.style.removeProperty("min-width");
    table.style.removeProperty("table-layout");
  };
  const apply = () => {
    const d = Object.keys(widths).length ? measure() : null;
    if (!d) return reset();
    cols.forEach((c, i) => {
      if (i > 0) c.style.width = `${widths[i] ?? d[i]}px`;
    });
    table.style.setProperty("table-layout", "fixed");
    const width = d.reduce((sum, w, i) => sum + (set?.isHidden(i) ? 0 : (widths[i] ?? w)), 0);
    table.style.setProperty("min-width", `${width}px`, "important");
  };
  const resize = (i: number, width: number) => {
    widths[i] = Math.max(MIN, Math.round(width));
    apply();
  };

  const handles = ths.map((th, i) => {
    const h = document.createElement("span");
    h.className = "col-resize";
    h.tabIndex = 0;
    h.setAttribute("role", "separator");
    h.setAttribute("aria-orientation", "vertical");
    h.setAttribute("aria-label", t("table.resizeColumn", { name: th.textContent?.trim() ?? "" }));
    h.addEventListener("click", (e) => e.stopPropagation());
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      measure();
      const x0 = e.clientX;
      const w0 = widths[i] ?? th.getBoundingClientRect().width;
      h.setPointerCapture(e.pointerId);
      document.documentElement.classList.add("col-resizing");
      const move = (ev: PointerEvent) => resize(i, w0 + ev.clientX - x0);
      const up = () => {
        h.removeEventListener("pointermove", move);
        document.documentElement.classList.remove("col-resizing");
        save(table, key, widths);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up, { once: true });
      h.addEventListener("pointercancel", up, { once: true });
    });
    h.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      delete widths[i];
      apply();
      save(table, key, widths);
    });
    h.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      e.stopPropagation();
      measure();
      resize(i, (widths[i] ?? th.getBoundingClientRect().width) + (e.key === "ArrowRight" ? STEP : -STEP));
      save(table, key, widths);
    });
    th.append(h);
    return h;
  });
  apply();

  return () => {
    for (const h of handles) h.remove();
    reset();
    if (created) group.remove();
  };
}

const isHandle = (n: Node) => n instanceof HTMLElement && n.classList.contains("col-resize");

export const resizableColumns: Action<HTMLTableElement, string | undefined> = (table, key) => {
  let set: ColumnSet | null = null;
  const register = () => {
    if (set) {
      columnSets.delete(set);
      set.dispose();
    }
    set = key ? new ColumnSet(table, key, () => again()) : null;
    if (set) columnSets.add(set);
  };
  register();
  let undo = setup(table, key, set);
  // Hiding a column, or a new header, measures the columns afresh.
  const again = () => {
    undo();
    undo = setup(table, key, set);
  };
  // The header changes with the data: other columns, or names in another language. Adding the edges is not a change.
  const header = new MutationObserver((records) => {
    const own = records.every((r) => r.type === "childList" && [...r.addedNodes, ...r.removedNodes].every(isHandle));
    if (!own) again();
  });
  const watch = () => {
    header.disconnect();
    const head = table.querySelector(":scope > thead");
    if (head) header.observe(head, { childList: true, subtree: true, characterData: true });
  };
  watch();
  return {
    update(next) {
      if (next === key) return;
      key = next;
      undo();
      register();
      undo = setup(table, key, set);
      watch();
    },
    destroy() {
      header.disconnect();
      undo();
      if (set) {
        columnSets.delete(set);
        set.dispose();
      }
    },
  };
};
