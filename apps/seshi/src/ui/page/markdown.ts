/** A small Markdown reader for prompts and answers that builds DOM nodes, never HTML: headings,
 * paragraphs, lists, quotes, fenced code, inline code, bold and italics. Anything else stays as
 * text. Links stay text too (the label, then the address in parentheses): a transcript must
 * not put a link in front of a reader. Every run of text goes through `leaf`, which sets
 * redaction markers apart. */

import { h } from "../../web/dom";

type Leaf = (text: string) => Node[];

/** Past this size the text is shown as it is: parsing a whole pasted file buys nothing. */
const MAX_PARSED = 40_000;

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,4}[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Inline spans: `code`, **bold**, *em* or _em_, [label](address). */
const INLINE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\b_([^_\n]+)_\b|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

function inline(text: string, leaf: Leaf): Node[] {
  const out: Node[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    const start = m.index ?? 0;
    if (start > at) out.push(...leaf(text.slice(at, start)));
    if (m[1] !== undefined) out.push(h("code", null, ...leaf(m[1])));
    else if (m[2] !== undefined || m[3] !== undefined)
      out.push(h("strong", null, ...inline((m[2] ?? m[3]) as string, leaf)));
    else if (m[4] !== undefined || m[5] !== undefined)
      out.push(h("em", null, ...inline((m[4] ?? m[5]) as string, leaf)));
    else if (m[6] !== undefined) out.push(...inline(m[6], leaf), ...leaf(` (${m[7] as string})`));
    at = start + m[0].length;
  }
  if (at < text.length) out.push(...leaf(text.slice(at)));
  return out;
}

function lineBreaks(lines: string[], leaf: Leaf): Node[] {
  const out: Node[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(document.createElement("br"));
    out.push(...inline(line, leaf));
  });
  return out;
}

export function renderMarkdown(text: string, leaf: Leaf): HTMLElement {
  const root = h("div", { class: "md" });
  if (text.length > MAX_PARSED) {
    root.append(h("p", null, ...leaf(text)));
    return root;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++;
      root.append(h("pre", { class: "code" }, h("code", null, ...leaf(body.join("\n")))));
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, (heading[1] as string).length + 2);
      root.append(h(`h${level}` as "h3", { class: "md-h" }, ...inline(heading[2] as string, leaf)));
      i++;
      continue;
    }
    if (RULE.test(line)) {
      root.append(h("hr"));
      i++;
      continue;
    }
    const item = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : undefined;
    if (item) {
      const list = h(item === BULLET ? "ul" : "ol");
      while (i < lines.length) {
        const m = item.exec(lines[i] as string);
        if (!m) break;
        list.append(h("li", null, ...inline(m[1] as string, leaf)));
        i++;
      }
      root.append(list);
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i] as string);
        if (!q) break;
        quoted.push(q[1] as string);
        i++;
      }
      root.append(h("blockquote", null, ...lineBreaks(quoted, leaf)));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const next = lines[i] as string;
      if (
        next.trim() === "" ||
        FENCE.test(next) ||
        HEADING.test(next) ||
        BULLET.test(next) ||
        NUMBERED.test(next) ||
        QUOTE.test(next)
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    if (para.length > 0) root.append(h("p", null, ...lineBreaks(para, leaf)));
  }
  return root;
}
