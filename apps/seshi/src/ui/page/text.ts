/** Text helpers with no DOM, so the tests can run them. */

export { splitMarkers } from "../../web/markers";

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** How long ago `iso` was, in the largest unit that fits: `just now`, `5 min ago`, `3 h ago`,
 * `2 days ago`; a date past a month. */
export function ago(iso: string | undefined, now: Date): string {
  if (!iso) return "";
  const at = new Date(iso);
  const ms = now.getTime() - at.getTime();
  if (Number.isNaN(ms)) return iso;
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 31) return days === 1 ? "yesterday" : `${days} days ago`;
  return at.toLocaleDateString();
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** How long from `start` to `end`: `40 s`, `12 min`, `2 h 5 min`. */
export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** `github.com/acme/app` as `acme/app`: the host says little in a list. */
export function shortRepo(repo: string): string {
  const parts = repo.split("/");
  return parts.length > 2 ? parts.slice(1).join("/") : repo;
}

/** The start of `text` to show folded: at most `maxLines` lines and about `maxChars`
 * characters (cut at a space when there is one near the end). */
export function fold(
  text: string,
  maxLines: number,
  maxChars = 1200,
): { head: string; lines: number; folded: boolean } {
  const lines = text.split("\n");
  let head = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
  if (head.length > maxChars) {
    const space = head.lastIndexOf(" ", maxChars);
    head = `${head.slice(0, space > maxChars * 0.8 ? space : maxChars)}…`;
  }
  return { head, lines: lines.length, folded: head !== text };
}

/** A snippet cut at its highlights (`[start, end)` offsets in UTF-16 code units), so each
 * matched stretch can be shown apart. Offsets out of order or out of range are dropped. */
export function highlightParts(
  snippet: string,
  highlights: readonly (readonly [number, number])[],
): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of highlights) {
    if (start < at || end <= start || end > snippet.length) continue;
    if (start > at) parts.push({ text: snippet.slice(at, start), hit: false });
    parts.push({ text: snippet.slice(start, end), hit: true });
    at = end;
  }
  if (at < snippet.length) parts.push({ text: snippet.slice(at), hit: false });
  return parts;
}

/** A tool call's arguments, pretty-printed when they are JSON. */
export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
