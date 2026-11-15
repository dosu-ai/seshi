/** Regex redaction of a session's normalized records: the pipeline's redaction stage (X4.3,
 * F2). With no raw stored (X6.3), the rules run on the records, where tool calls, file paths and
 * outputs are already separate fields, so each rule reads exactly what it is about:
 *
 * 1. Sensitive calls: a tool call whose input names a sensitive file or runs a secret command
 *    (`sensitive.ts`) is kept, so the session still says the agent looked; a sensitive-file
 *    call's input keeps only what names the file, and the call's result is replaced by
 *    `[redacted:sensitive-file]` / `[redacted:secret-output]` and marked `withheld`. A result can
 *    arrive in a later chunk than its call, so the pass takes the ids withheld so far and
 *    returns them with this pass's added; the pipeline keeps them in the session's metadata.
 * 2. The operator's patterns, then 3. the built-in secret patterns, over every string that is
 *    not structural (ids, roles, timestamps, the source and the branch stay as they are, as in
 *    `redactRecords`).
 *
 * Deterministic: the same records and the same withheld ids always redact to the same records,
 * which content hashes and the continuation prefix (computed over the output) depend on.
 * Idempotent: redacted records redact to themselves. What ran is summarized as the rule set's
 * hash and the matches by rule id (F2.3), never what matched.
 *
 * `Redactor` is the interface the pipeline takes, so F2's TOML packs (branch 07) can replace
 * `ruleRedactor` without the pipeline changing. */

import { createHash } from "node:crypto";
import type { NormalizedRecord, RedactionSummary } from "@seshi/model";
import { CUSTOM_PATTERN_KIND, redactPatterns } from "./patterns";
import { type RedactionRules, redactionRules } from "./rules";
import { redactSecrets } from "./secrets";
import { classifyCall, trimSensitiveInput, type WithheldCalls } from "./sensitive";

/** Names the built-in rules (secret patterns, sensitive files, secret commands) in the rule-set
 * hash. Bump it when a built-in rule changes, so `metadata.redaction.rule_set` tells sessions
 * redacted before the change from those after. */
export const BUILTIN_RULES_VERSION = "seshi/rules/1";

export interface RecordRedaction {
  records: NormalizedRecord[];
  /** The ids passed in as `carried`, plus every call this pass withheld. */
  withheld: WithheldCalls;
  /** The rule set that ran and how often each rule fired. */
  summary: RedactionSummary;
}

/** The pipeline's redaction stage. */
export interface Redactor {
  /** sha256 of the rule set, as `RedactionSummary.rule_set`. */
  readonly rule_set: string;
  /** `records` redacted; `carried` is what the passes over the session's earlier records
   * withheld. Never throws for content. */
  redact(records: readonly NormalizedRecord[], carried?: Readonly<WithheldCalls>): RecordRedaction;
}

/** Keys whose string values are structural identity, not text (see `records.ts`). */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "tool_call_id",
  "role",
  "timestamp",
  "source",
  "name",
  "git_branch",
  "withheld",
  "llm_call",
]);

type Counts = Record<string, number>;

function bump(counts: Counts, rule: string, n = 1): void {
  if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
}

function occurrences(text: string, marker: string): number {
  let n = 0;
  for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + marker.length)) {
    n++;
  }
  return n;
}

const CUSTOM_MARKER = `[redacted:${CUSTOM_PATTERN_KIND}]`;

function redactText(text: string, rules: RedactionRules, counts: Counts): string {
  let out = text;
  if (rules.patterns.length > 0) {
    const before = occurrences(out, CUSTOM_MARKER);
    out = redactPatterns(out, rules.patterns);
    bump(counts, CUSTOM_PATTERN_KIND, occurrences(out, CUSTOM_MARKER) - before);
  }
  const secrets = redactSecrets(out);
  for (const [rule, n] of Object.entries(secrets.counts)) bump(counts, rule, n);
  return secrets.text;
}

function redactValue(value: unknown, rules: RedactionRules, counts: Counts, key?: string): unknown {
  if (typeof value === "string") {
    return key !== undefined && STRUCTURAL_KEYS.has(key) ? value : redactText(value, rules, counts);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, rules, counts));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, rules, counts, k)]),
    );
  }
  return value;
}

/** The sensitive-call pass over one record. */
function withholdCalls(
  record: NormalizedRecord,
  rules: RedactionRules,
  withheld: WithheldCalls,
  counts: Counts,
): NormalizedRecord {
  if (record.role === "assistant" && "tool_calls" in record && Array.isArray(record.tool_calls)) {
    let changed = false;
    const calls = record.tool_calls.map((call) => {
      const kind = classifyCall(call.args, rules.sensitive);
      if (!kind) return call;
      if (!Object.hasOwn(withheld, call.id)) bump(counts, kind);
      withheld[call.id] = kind;
      if (kind !== "sensitive-file") return call;
      const args = trimSensitiveInput(call.args, rules.sensitive.files);
      if (args === call.args) return call;
      changed = true;
      return { ...call, args };
    });
    return changed ? ({ ...record, tool_calls: calls } as NormalizedRecord) : record;
  }
  if (record.role === "tool" && Object.hasOwn(withheld, record.tool_call_id)) {
    const kind = withheld[record.tool_call_id];
    return { ...record, content: `[redacted:${kind}]`, withheld: kind } as NormalizedRecord;
  }
  return record;
}

/** sha256 of a rule set: the built-in rules' version and every pattern, glob and command. */
export function ruleSetHash(rules: RedactionRules): string {
  const description = {
    builtin: BUILTIN_RULES_VERSION,
    patterns: rules.patterns.map((re) => re.source),
    files: {
      include: rules.sensitive.files.include.map((re) => re.source),
      exclude: rules.sensitive.files.exclude.map((re) => re.source),
    },
    commands: rules.sensitive.commands.map((re) => re.source),
  };
  return createHash("sha256").update(JSON.stringify(description), "utf8").digest("hex");
}

/** The regex rules as a `Redactor`: the built-in rules plus the operator's (`redactionRules`). */
export function ruleRedactor(rules: RedactionRules = redactionRules()): Redactor {
  const rule_set = ruleSetHash(rules);
  return {
    rule_set,
    redact(records, carried = {}) {
      const withheld: WithheldCalls = { ...carried };
      const counts: Counts = {};
      const out = records.map((record) => {
        const kept = withholdCalls(record, rules, withheld, counts);
        return redactValue(kept, rules, counts) as NormalizedRecord;
      });
      return { records: out, withheld, summary: { rule_set, counts } };
    },
  };
}
