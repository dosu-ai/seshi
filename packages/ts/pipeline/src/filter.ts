import type { NormalizedRecord } from "@seshi/model";

export interface FilterRules {
  /** `false` keeps every session that can be stored. */
  enabled: boolean;
  /** Characters of text, tool arguments and tool results, across everything but the meta
   * record; less is a greeting rather than an investigation. */
  min_chars: number;
  require_user: boolean;
  require_reply: boolean;
}

export const DEFAULT_FILTER: Readonly<FilterRules> = Object.freeze({
  enabled: true,
  min_chars: 2000,
  require_user: true,
  require_reply: true,
});

export type FilterSetting = Readonly<FilterRules> | ((sourceId: string) => Readonly<FilterRules>);

/** The rules `setting` gives `sourceId`; `DEFAULT_FILTER` without a setting. */
export function filterRulesFor(
  setting: FilterSetting | undefined,
  sourceId: string,
): Readonly<FilterRules> {
  if (setting === undefined) return DEFAULT_FILTER;
  return typeof setting === "function" ? setting(sourceId) : setting;
}

/** Filtered when the session cannot be a trace (no user record, or nothing answering it: no
 * assistant or tool record), or, with the filter on, when it has under `min_chars` characters. */
export function isFiltered(
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
