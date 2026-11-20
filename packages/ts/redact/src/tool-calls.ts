/** `redact_tool_calls` on the server (the org's `[capture] redact_tool_calls`), over normalized
 * records: a session in a listed repository is stored with every tool call's input and result
 * replaced by `[redacted:tool-call]`, as a laptop's pass uploads it. It is the backstop for what
 * reaches the server unredacted (a Cursor Cloud agent the server polls, a laptop older than the
 * list), and changes nothing in records a laptop already redacted.
 *
 * - A call keeps its id and name, and its arguments their keys, numbers and booleans; a result
 *   keeps its call id and whether it failed.
 * - Text put in the conversation for the person (user and observation records) loses what tools
 *   and the person's own commands returned in it, as a laptop's pass takes it out of the raw log:
 *   a background task's result (`<task-notification>`), a command's output (`<bash-stdout>`,
 *   Codex's `<user_shell_command>` result).
 * - A subagent's session is its parent's tool call (its prompt the call's input, its replies the
 *   result): every text in it goes, as a laptop uploads none of it.
 *
 * What is only in a raw log's structure (a compaction's summary) cannot be told apart in the
 * records, and stays as an older laptop sent it. */

import type { NormalizedRecord } from "@seshi/model";
import {
  blankStrings,
  hasToolDetail,
  redactCommandOutput,
  TOOL_CALL_MARKER,
} from "@seshi/model/tool-calls";
import type { RecordRedaction, Redactor } from "./redactor";
import { bump } from "./ruleset";

export { TOOL_CALL_MARKER };

/** The count a redaction summary keeps for it, as a rule's would be. */
export const TOOL_CALL_COUNT = "tool-call";

/** A call's JSON-encoded arguments with their strings replaced; text that is not JSON (or encodes
 * a bare string) is replaced whole. Arguments with nothing left to replace are kept as written,
 * so what a laptop redacted is not written again in another form. */
function blankArgs(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args === "" ? args : TOOL_CALL_MARKER;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return args === "" || parsed === TOOL_CALL_MARKER ? args : TOOL_CALL_MARKER;
  }
  return hasToolDetail(parsed) ? JSON.stringify(blankStrings(parsed)) : args;
}

/** The roles whose text is what was said, which a subagent's session loses too. */
const TEXT_ROLES = new Set(["user", "assistant", "reasoning", "observation", "system"]);

export interface ToolCallRedaction {
  /** The session is a subagent's: all of it is its parent's tool call. */
  subagent?: boolean;
}

/** The records with their tool calls' detail replaced, and how many values were. */
export function redactToolCallRecords(
  records: readonly NormalizedRecord[],
  options: ToolCallRedaction = {},
): { records: NormalizedRecord[]; count: number } {
  let count = 0;
  const withContent = (record: NormalizedRecord, next: string): NormalizedRecord => {
    const content = (record as { content?: unknown }).content;
    if (next === content) return record;
    count++;
    return { ...record, content: next } as NormalizedRecord;
  };
  const out = records.map((record): NormalizedRecord => {
    const content = (record as { content?: unknown }).content;
    if (record.role === "tool") {
      return typeof content === "string" && content !== ""
        ? withContent(record, TOOL_CALL_MARKER)
        : record;
    }
    let next: NormalizedRecord = record;
    if (typeof content === "string" && content !== "") {
      if (options.subagent && TEXT_ROLES.has(record.role)) {
        next = withContent(record, TOOL_CALL_MARKER);
      } else if (record.role === "user" || record.role === "observation") {
        next = withContent(record, redactCommandOutput(content));
      }
    }
    if (next.role === "assistant" && "tool_calls" in next && Array.isArray(next.tool_calls)) {
      let changed = false;
      const calls = next.tool_calls.map((call) => {
        const args = typeof call.args === "string" ? blankArgs(call.args) : call.args;
        if (args === call.args) return call;
        changed = true;
        count++;
        return { ...call, args };
      });
      if (changed) next = { ...next, tool_calls: calls } as NormalizedRecord;
    }
    return next;
  });
  return { records: out, count };
}

/** `inner` with the tool-call pass before it: what a write to a listed repository redacts with.
 * Its rule set is `inner`'s; the summary counts the values it replaced under `tool-call`. */
export function withToolCallsRedacted(inner: Redactor, options: ToolCallRedaction = {}): Redactor {
  return {
    rule_set: inner.rule_set,
    redact(records, carried): RecordRedaction {
      const { records: blanked, count } = redactToolCallRecords(records, options);
      const out = inner.redact(blanked, carried);
      if (count > 0) bump(out.summary.counts, TOOL_CALL_COUNT, count);
      return out;
    },
    ...(inner.redactText ? { redactText: inner.redactText.bind(inner) } : {}),
  };
}
