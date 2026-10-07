/**
 * A small Markdown reader for the digest: headings, tables, lists, paragraphs, and **bold**, _italic_ and `code`
 * inside them. It returns plain data for the page to draw as elements, never HTML, so no text in a report can
 * add markup or run anything.
 */
export type Inline = { kind: "text" | "bold" | "em" | "code"; text: string };
export type Block =
  | { kind: "heading"; level: number; inline: Inline[] }
  | { kind: "paragraph"; inline: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "table"; head: Inline[][]; align: ("left" | "right")[]; rows: Inline[][][] };

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w])_([^_]+)_(?![\w])/g;

export function inlines(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: "text", text: s.slice(last, m.index) });
    out.push(m[1] != null ? { kind: "code", text: m[1] } : m[2] != null ? { kind: "bold", text: m[2] } : { kind: "em", text: m[3]! });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ kind: "text", text: s.slice(last) });
  return out;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1]!.length, inline: inlines(h[2]!) });
      i++;
    } else if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? "")) {
      const align = cells(lines[i + 1]!).map((c) => (c.endsWith(":") ? ("right" as const) : ("left" as const)));
      const rows: Inline[][][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(cells(lines[j]!).map(inlines));
      blocks.push({ kind: "table", head: cells(line).map(inlines), align, rows });
      i = j;
    } else if (/^(-|\d+\.)\s/.test(line)) {
      const ordered = /^\d/.test(line);
      const items: Inline[][] = [];
      for (; i < lines.length && (ordered ? /^\d+\.\s/ : /^-\s/).test(lines[i]!); i++) items.push(inlines(lines[i]!.replace(/^(-|\d+\.)\s+/, "")));
      blocks.push({ kind: "list", ordered, items });
    } else if (line.trim()) {
      const text: string[] = [];
      for (; i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\||-\s|\d+\.\s)/.test(lines[i]!); i++) text.push(lines[i]!.trim());
      if (!text.length) i++;
      else blocks.push({ kind: "paragraph", inline: inlines(text.join(" ")) });
    } else i++;
  }
  return blocks;
}
