/** `redact_tool_calls` on the server (the org's `[capture] redact_tool_calls`), over normalized
 * records: a session in a listed repository is stored with every tool call's input and result
 * replaced by `[redacted:tool-call]`, as a laptop's pass uploads it. It is the backstop for what
 * reaches the server unredacted (a Cursor Cloud agent the server polls, a laptop older than the
 * list), and does nothing to records a laptop already redacted.
 *
 * A call keeps its id and name, and its arguments their keys, numbers and booleans; a result keeps
 * its call id and whether it failed. What a laptop's pass also redacts in the raw log (output of a
 * command the person ran, compaction summaries) is not a tool call in the records, and stays as
 * the records have it. */

import type { NormalizedRecord } from "@seshi/model";
import type { RecordRedaction, Redactor } from "./redactor";
import { bump } from "./ruleset";

export const TOOL_CALL_MARKER = "[redacted:tool-call]";

/** The count a redaction summary keeps for it, as a rule's would be. */
export const TOOL_CALL_COUNT = "tool-call";

function blankStrings(value: unknown): unknown {
  if (typeof value === "string") return value === "" ? value : TOOL_CALL_MARKER;
  if (Array.isArray(value)) return value.map(blankStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, blankStrings(v)]));
  }
  return value;
}

/** A call's JSON-encoded arguments with their strings replaced; text that is not JSON (or encodes
 * a bare string) is replaced whole. */
function blankArgs(args: string): string {
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null) return JSON.stringify(blankStrings(parsed));
  } catch {}
  return args === "" ? args : TOOL_CALL_MARKER;
}

/** The records with their tool calls' detail replaced, and how many inputs and results were. */
export function redactToolCallRecords(records: readonly NormalizedRecord[]): {
  records: NormalizedRecord[];
  count: number;
} {
  let count = 0;
  const out = records.map((record): NormalizedRecord => {
    if (record.role === "tool") {
      const content = (record as { content?: unknown }).content;
      if (typeof content !== "string" || content === "" || content === TOOL_CALL_MARKER) {
        return record;
      }
      count++;
      return { ...record, content: TOOL_CALL_MARKER } as NormalizedRecord;
    }
    if (record.role === "assistant" && "tool_calls" in record && Array.isArray(record.tool_calls)) {
      let changed = false;
      const calls = record.tool_calls.map((call) => {
        const args = typeof call.args === "string" ? blankArgs(call.args) : call.args;
        if (args === call.args) return call;
        changed = true;
        count++;
        return { ...call, args };
      });
      return changed ? ({ ...record, tool_calls: calls } as NormalizedRecord) : record;
    }
    return record;
  });
  return { records: out, count };
}

/** `inner` with the tool-call pass before it: what a write to a listed repository redacts with.
 * Its rule set is `inner`'s; the summary counts the inputs and results it replaced under
 * `tool-call`. */
export function withToolCallsRedacted(inner: Redactor): Redactor {
  return {
    rule_set: inner.rule_set,
    redact(records, carried): RecordRedaction {
      const { records: blanked, count } = redactToolCallRecords(records);
      const out = inner.redact(blanked, carried);
      if (count > 0) bump(out.summary.counts, TOOL_CALL_COUNT, count);
      return out;
    },
    ...(inner.redactText ? { redactText: inner.redactText.bind(inner) } : {}),
  };
}
