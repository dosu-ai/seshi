/** Whether a session is worth storing, judged on what would actually ship: its normalized,
 * redacted trajectory. Size rather than turn counts, so a terse agent run whose substance is
 * tool traffic counts as much as a chatty one. The rules are config's `[filter]` (X4.10), with
 * today's values as defaults; the names match the config's.
 *
 * Only a session's first trace is judged: a chunk that continues a stored head is never
 * filtered, so agent-only tails are not lost. */

import type { NormalizedRecord } from "@seshi/model";

export interface FilterRules {
  /** `false` keeps every session that can be stored. */
  enabled: boolean;
  /** Characters of text, tool arguments and tool results, across everything but the meta
   * record; less is a greeting rather than an investigation. */
  min_chars: number;
  /** At least one user record. Turning it off has no effect yet: the trace format needs one
   * (`parseTrace`), so such a session cannot be stored either way. */
  require_user: boolean;
  /** At least one assistant or tool record answering it. Turning it off has no effect yet, for
   * the same reason. */
  require_reply: boolean;
}

export const DEFAULT_FILTER: Readonly<FilterRules> = Object.freeze({
  enabled: true,
  min_chars: 2000,
  require_user: true,
  require_reply: true,
});

/** Trivial when the session cannot be a trace (no user record, or nothing answering it: no
 * assistant or tool record), or, with the filter on, when it has under `min_chars`
 * characters. The first part holds whatever the rules say: today's trace format refuses such a
 * session as invalid, and a quiet "not stored" is what an uploader expects for a session that
 * has only started. */
export function isTrivialTrajectory(
  records: readonly NormalizedRecord[],
  rules: Readonly<FilterRules> = DEFAULT_FILTER,
): boolean {
  let asked = false;
  let answered = false;
  let chars = 0;
  for (const record of records) {
    if (record.role === "meta") continue;
    if (record.role === "user") asked = true;
    if (record.role === "assistant" || record.role === "tool") answered = true;
    if (typeof record.content === "string") chars += record.content.length;
    if ("tool_calls" in record) {
      for (const call of record.tool_calls) chars += call.args.length;
    }
  }
  if (!asked || !answered) return true;
  return rules.enabled && chars < rules.min_chars;
}
