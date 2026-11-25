import { type MatchTree, WORD } from "./query";

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

/** About how many words an excerpt holds, as FTS5's `snippet()` is asked for. */
export const EXCERPT_WORDS = 24;

/** Words before the first match, when the text has them. */
const EXCERPT_LEAD = 3;

/** A word as compared: lower-cased, accents removed. */
function folded(word: string): string {
  return word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** An excerpt of `text` around what `tree` matches, marked as `snippet()` marks it: the window of
 * about `EXCERPT_WORDS` words (more when a phrase crosses its edge) holding the most matched
 * words, each match (a phrase as one)
 * between `MATCH_START` and `MATCH_END`, with `…` where the text goes on. For a backend that
 * returns a matched record's text instead of a snippet; `highlights()` reads its output. */
export function excerpt(text: string, tree: MatchTree): string {
  const clean = text.replaceAll(MATCH_START, " ").replaceAll(MATCH_END, " ");
  const words = [...clean.matchAll(WORD)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    word: folded(m[0]),
  }));
  if (words.length === 0) return clean;
  // Each match as a run of words [from, to).
  const spans: [number, number][] = [];
  for (const item of tree.all.flat()) {
    const tokens = item.tokens.map(folded);
    if (tokens.length === 0) continue;
    for (let i = 0; i + tokens.length <= words.length; i++) {
      const hit = tokens.every((token, k) => {
        const word = (words[i + k] as (typeof words)[number]).word;
        return item.prefix && k === tokens.length - 1 ? word.startsWith(token) : word === token;
      });
      if (hit) spans.push([i, i + tokens.length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const runs: [number, number][] = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else runs.push([span[0], span[1]]);
  }
  const matched = new Array<boolean>(words.length).fill(false);
  for (const [from, to] of runs) for (let i = from; i < to; i++) matched[i] = true;
  const latest = Math.max(0, words.length - EXCERPT_WORDS);
  let start = 0;
  let best = -1;
  for (const [from] of runs) {
    const at = Math.min(Math.max(0, from - EXCERPT_LEAD), latest);
    let count = 0;
    for (let i = at; i < Math.min(words.length, at + EXCERPT_WORDS); i++) if (matched[i]) count++;
    if (count > best) {
      best = count;
      start = at;
    }
  }
  let end = Math.min(words.length, start + EXCERPT_WORDS);
  // A match that crosses an edge of the window is shown whole: the window grows to hold it.
  for (const [from, to] of runs) {
    if (from < start && to > start) start = from;
    if (from < end && to > end) end = to;
  }
  let out = start > 0 ? "…" : "";
  let at = start > 0 ? (words[start] as (typeof words)[number]).start : 0;
  for (const [from, to] of runs) {
    if (from < start || to > end) continue;
    const open = (words[from] as (typeof words)[number]).start;
    const close = (words[to - 1] as (typeof words)[number]).end;
    out += `${clean.slice(at, open)}${MATCH_START}${clean.slice(open, close)}${MATCH_END}`;
    at = close;
  }
  const stop = end < words.length ? (words[end - 1] as (typeof words)[number]).end : clean.length;
  out += clean.slice(at, stop);
  return end < words.length ? `${out}…` : out;
}
