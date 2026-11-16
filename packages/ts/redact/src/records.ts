import type { NormalizedRecord } from "@seshi/model";
import { redactSecrets } from "./secrets";

const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "tool_call_id",
  "role",
  "timestamp",
  "source",
  "name",
  "git_branch",
]);

function redactValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : redactSecrets(value).text;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

export function redactRecords(records: readonly NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) => redactValue(record) as NormalizedRecord);
}
