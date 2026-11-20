/** For tests of a capture agent's `redactToolCalls` pass: what a transcript normalizes to, split
 * into what the pass must keep and what it must have replaced. */

import type { FormatAdapter, NormalizedRecord } from "@seshi/model";

export function normalized(adapter: FormatAdapter, transcript: string): NormalizedRecord[] {
  const out = adapter.normalize(transcript);
  return Array.isArray(out) ? out : out.records;
}

type Loose = Record<string, unknown>;

/** The records with each tool call's arguments and each tool result's content taken out: what a
 * transcript and its redacted copy must agree on (who said what, which tools ran, their ids,
 * order and failures). */
export function withoutToolDetail(records: readonly NormalizedRecord[]): Loose[] {
  return records.map((record) => {
    const r = record as unknown as Loose;
    if (r.role === "tool") {
      const { content: _content, ...rest } = r;
      return rest;
    }
    if (Array.isArray(r.tool_calls)) {
      return {
        ...r,
        tool_calls: (r.tool_calls as Loose[]).map(({ args: _args, ...call }) => call),
      };
    }
    return r;
  });
}

function strings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (typeof value === "object" && value !== null) {
    // A block's `type` is its structure, which a redacted result keeps.
    for (const [k, v] of Object.entries(value)) if (k !== "type") strings(v, out);
  }
}

function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Every string in the records' tool call arguments and tool results' content, each read as
 * JSON when it is (so the numbers and booleans a redacted call keeps are not strings here), but
 * a block's `type`. */
export function toolDetail(records: readonly NormalizedRecord[]): string[] {
  const out: string[] = [];
  for (const record of records) {
    const r = record as unknown as Loose;
    if (r.role === "tool") strings(decoded(r.content), out);
    for (const call of Array.isArray(r.tool_calls) ? (r.tool_calls as Loose[]) : []) {
      strings(decoded(call.args), out);
    }
  }
  return out;
}

/** Whether every string is only markers (`marker`) and what the normalizer adds itself (a
 * placeholder for an image, `Error: ` before a failed result's text), with whitespace. */
export function onlyMarkers(texts: readonly string[], marker = "[redacted:tool-call]"): boolean {
  return texts.every(
    (t) =>
      t
        .replace(/^Error: /, "")
        .replaceAll(marker, "")
        .replaceAll("[image]", "")
        .trim() === "",
  );
}
