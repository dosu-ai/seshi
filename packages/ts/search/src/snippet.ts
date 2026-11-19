export const MATCH_START = "\u0001";
export const MATCH_END = "\u0002";

/** The most characters of one event that are indexed: a tool call that writes a whole file
 * holds the file, and matches past this point are not found. */
export const MAX_INDEXED_CHARS = 32 * 1024;

export function indexText(text: string): string {
  const clean = text.replaceAll(MATCH_START, " ").replaceAll(MATCH_END, " ");
  return clean.length > MAX_INDEXED_CHARS ? clean.slice(0, MAX_INDEXED_CHARS) : clean;
}

/** Plain text and the matched ranges of a marked snippet. An unclosed match ends with the
 * text; adjacent ranges are merged. */
export function highlights(marked: string): { snippet: string; highlights: [number, number][] } {
  let snippet = "";
  const ranges: [number, number][] = [];
  let open: number | undefined;
  for (const ch of marked) {
    if (ch === MATCH_START) {
      if (open === undefined) open = snippet.length;
    } else if (ch === MATCH_END) {
      if (open !== undefined) {
        if (snippet.length > open) ranges.push([open, snippet.length]);
        open = undefined;
      }
    } else {
      snippet += ch;
    }
  }
  if (open !== undefined && snippet.length > open) ranges.push([open, snippet.length]);
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && last[1] >= range[0]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return { snippet, highlights: merged };
}
