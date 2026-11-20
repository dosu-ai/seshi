/** Split text at the markers redaction leaves (`[redacted:<rule>]`), so a page can show each
 * one apart from the text around it. */
export function splitMarkers(text: string): { text: string; rule?: string }[] {
  const parts: { text: string; rule?: string }[] = [];
  const re = /\[redacted:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: m[0], rule: m[1] as string });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
