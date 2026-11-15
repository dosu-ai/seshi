/** Pure helpers for the page (no DOM): status words and icons, redaction markers, folding. */

import type { ListStatus, RowState, TimelineKind } from "../types";

/** A status as a word and an icon, never colour alone (brand: B1.4). */
export const STATUS: Readonly<Record<ListStatus, { icon: string; word: string }>> = {
  fail: { icon: "✕", word: "fail" },
  warn: { icon: "▲", word: "warn" },
  ok: { icon: "✓", word: "ok" },
  skip: { icon: "–", word: "skip" },
  pending: { icon: "…", word: "checking" },
};

export const ROW_STATE: Readonly<Record<RowState, { icon: string; word: string; tone: string }>> = {
  same: { icon: "=", word: "same", tone: "ok" },
  differs: { icon: "≠", word: "differs", tone: "fail" },
  dropped: { icon: "⌫", word: "review dropped", tone: "skip" },
  missing: { icon: "?", word: "not stored", tone: "fail" },
  unsent: { icon: "↥", word: "not sent yet", tone: "warn" },
  frozen: { icon: "⏸", word: "past the pause", tone: "skip" },
  "stored-only": { icon: "◧", word: "stored only", tone: "warn" },
  local: { icon: "◨", word: "local only", tone: "skip" },
};

export const KIND_WORD: Readonly<Record<TimelineKind, string>> = {
  seen: "seen",
  spool: "spool",
  log: "log",
  upload: "upload",
  error: "error",
  change: "change",
  review: "review",
  toggle: "toggle",
  pause: "pause",
  retraction: "retraction",
  rebuild: "rebuild",
};

/** Text split around redaction markers (`[redacted:<rule>]`), each marker with its rule. */
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

/** The first `max` lines of `text`, and how many there are in all. */
export function fold(text: string, max: number): { head: string; lines: number; folded: boolean } {
  const lines = text.split("\n");
  if (lines.length <= max) return { head: text, lines: lines.length, folded: false };
  return { head: lines.slice(0, max).join("\n"), lines: lines.length, folded: true };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Bytes, briefly. */
export function bytes(n: number | undefined): string {
  if (n === undefined) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A time as the person's local date and time. */
export function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}
