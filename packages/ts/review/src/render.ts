/** What the models are shown of an envelope, and how a long one is split (F3.6, F3.7).
 *
 * Only the text a reviewer judges leaves the server: each record's `content` and each tool
 * call's arguments, with the record's role and, for tool calls and their results, the tool's
 * name. Ids, timestamps, the meta record, LLM call details and everything else stay behind.
 *
 * Each field becomes one entry `{record, role, field, text}`; `record` is the record's index in
 * the envelope's records, which is what findings name. An envelope whose text is longer than the
 * policy's `max_input_chars` is split by turn (a turn starts at each user record): turns are
 * packed into parts that fit, a turn that alone does not fit is packed field by field, and a
 * field that alone does not fit is cut into overlapping windows that share its name and carry a
 * part number. Findings always apply to the whole field, so a window boundary changes nothing
 * about how text is removed; the overlap keeps a value cut at a boundary whole in one window. */

import type { NormalizedRecord } from "@seshi/model";

export interface Entry {
  /** The record's index in the envelope's records. */
  record: number;
  role: string;
  /** `content`, or `tool_calls[N].args`. */
  field: string;
  text: string;
  /** The tool's name, for a call's arguments and for a tool result. */
  tool?: string;
  /** `k/n` when the field was cut into windows. */
  part?: string;
}

/** Bytes of JSON around each entry's text, counted against the budget. */
const ENTRY_OVERHEAD = 120;

/** Every field the models judge, in record order. */
export function entriesOf(records: readonly NormalizedRecord[]): Entry[] {
  const toolNames = new Map<string, string>();
  const out: Entry[] = [];
  records.forEach((record, index) => {
    const r = record as unknown as Record<string, unknown>;
    const role = String(r.role);
    if (role === "meta") return;
    const calls = Array.isArray(r.tool_calls) ? (r.tool_calls as Record<string, unknown>[]) : [];
    for (const call of calls) {
      if (typeof call.id === "string" && typeof call.name === "string") {
        toolNames.set(call.id, call.name);
      }
    }
    if (typeof r.content === "string" && r.content !== "") {
      const tool =
        role === "tool" && typeof r.tool_call_id === "string"
          ? toolNames.get(r.tool_call_id)
          : undefined;
      out.push({
        record: index,
        role,
        field: "content",
        text: r.content,
        ...(tool ? { tool } : {}),
      });
    }
    calls.forEach((call, i) => {
      if (typeof call.args === "string" && call.args !== "") {
        out.push({
          record: index,
          role,
          field: `tool_calls[${i}].args`,
          text: call.args,
          ...(typeof call.name === "string" ? { tool: call.name } : {}),
        });
      }
    });
  });
  return out;
}

function size(entry: Entry): number {
  return entry.text.length + ENTRY_OVERHEAD;
}

/** `entry` cut into windows of at most `budget` (with overhead), overlapping by a little. */
function windows(entry: Entry, budget: number): Entry[] {
  const width = Math.max(1, budget - ENTRY_OVERHEAD);
  if (entry.text.length <= width) return [entry];
  const overlap = Math.min(200, Math.floor(width / 10));
  const step = width - overlap;
  const pieces: string[] = [];
  for (let at = 0; at < entry.text.length; at += step) {
    pieces.push(entry.text.slice(at, at + width));
    if (at + width >= entry.text.length) break;
  }
  return pieces.map((text, i) => ({ ...entry, text, part: `${i + 1}/${pieces.length}` }));
}

/** The entries split into parts of at most `budget` characters each, by turn. */
export function partsOf(records: readonly NormalizedRecord[], budget: number): Entry[][] {
  const entries = entriesOf(records);
  // Turns: a new one starts at each user record.
  const turns: Entry[][] = [];
  let lastRecord = -1;
  for (const entry of entries) {
    const startsTurn =
      entry.record !== lastRecord && (records[entry.record] as { role: string }).role === "user";
    if (turns.length === 0 || startsTurn) turns.push([]);
    (turns.at(-1) as Entry[]).push(...windows(entry, budget));
    lastRecord = entry.record;
  }
  const parts: Entry[][] = [];
  let current: Entry[] = [];
  let used = 0;
  const flush = () => {
    if (current.length > 0) parts.push(current);
    current = [];
    used = 0;
  };
  for (const turn of turns) {
    const turnSize = turn.reduce((n, e) => n + size(e), 0);
    if (turnSize <= budget) {
      if (used + turnSize > budget) flush();
      current.push(...turn);
      used += turnSize;
      continue;
    }
    // A turn that alone does not fit: pack its fields on their own.
    flush();
    for (const entry of turn) {
      if (used + size(entry) > budget) flush();
      current.push(entry);
      used += size(entry);
    }
    flush();
  }
  flush();
  return parts;
}

/** A field's text by record index and name, as the findings name them. */
export function fieldText(record: NormalizedRecord, field: string): string | undefined {
  const r = record as unknown as Record<string, unknown>;
  if (field === "content") return typeof r.content === "string" ? r.content : undefined;
  const m = /^tool_calls\[(\d+)\]\.args$/.exec(field);
  if (!m || !Array.isArray(r.tool_calls)) return undefined;
  const call = (r.tool_calls as Record<string, unknown>[])[Number(m[1])];
  return typeof call?.args === "string" ? call.args : undefined;
}
