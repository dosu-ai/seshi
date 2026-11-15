/** Redaction of a native transcript before it leaves the machine (F2.4): the uploader can fetch
 * the org's rule packs (`GET /v1/redaction/rules`, `ruleSetFromDocument`) and apply them, with
 * the built-in pack, so secrets never reach the server. The server still redacts everything it
 * receives, because a client can skip this; what the client did is never trusted.
 *
 * The transcript is the agent's own file, not normalized records, so this works on JSON:
 *
 * 1. The sensitive-call pass over the transcript's objects (`redactSensitive`): a call that
 *    names a sensitive file or runs a secret command keeps its call, and its result goes.
 * 2. Every string value through the text rules, then the built-in secret patterns. A string
 *    under a key that is an identifier (`id`, `uuid`, `tool_use_id`, `call_id`, `sessionId`, …)
 *    or framing (`type`, `role`, `timestamp`) is left alone: the server links a tool result to
 *    its call by these ids, and a long random id looks like a secret to the entropy rule.
 *
 * Where a string sits (text, tool input, tool output) is not known before normalizing, so a
 * text rule runs on every string here, whatever its `applies_to` says: pre-redaction can only
 * take out more than the server would, never less.
 *
 * Lines (`jsonl`) or the whole document (`json`) are re-serialized only when something in them
 * changed, so a transcript with nothing to redact keeps its bytes, and the same rules always
 * turn the same line into the same text (the server's offsets and prefix hashes rely on it). */

import type { RawFormat, RedactionSummary } from "@seshi/model";
import { bump, type Counts, type RuleSet } from "./ruleset";
import { redactSensitive, type WithheldCalls } from "./sensitive";

/** Keys whose string values identify or frame, rather than say anything. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "uuid",
  "type",
  "role",
  "timestamp",
  "name",
  "tool_use_id",
  "tool_call_id",
  "toolCallId",
  "call_id",
  "callID",
  "parentUuid",
  "parent_id",
  "parentId",
  "sessionId",
  "session_id",
  "sessionID",
  "messageID",
  "messageId",
  "requestId",
  "request_id",
]);

function isStructural(key: string | undefined): boolean {
  return key !== undefined && STRUCTURAL_KEYS.has(key);
}

function redactStrings(
  value: unknown,
  rules: RuleSet,
  counts: Counts,
  key?: string,
): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    if (isStructural(key)) return { value, changed: false };
    const next = rules.redactString(value, "anywhere", counts);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactStrings(item, rules, counts);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value)) {
      const r = redactStrings(item, rules, counts, k);
      changed ||= r.changed;
      next[k] = r.value;
    }
    return changed ? { value: next, changed } : { value, changed };
  }
  return { value, changed: false };
}

/** One JSON document (or a line that is not JSON, redacted as text). */
function redactDocument(text: string, rules: RuleSet, counts: Counts): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rules.redactString(text, "anywhere", counts);
  }
  const r = redactStrings(parsed, rules, counts);
  return r.changed ? JSON.stringify(r.value) : text;
}

export interface TranscriptRedaction {
  text: string;
  /** `carried` and every call this pass withheld: what the next chunk's pass starts from. */
  withheld: WithheldCalls;
  summary: RedactionSummary;
}

/** `transcript` (a whole log, or a chunk of one with `carried` from the chunks before it)
 * redacted with `rules`. */
export function redactTranscript(
  rules: RuleSet,
  transcript: string,
  format: RawFormat,
  carried: Readonly<WithheldCalls> = {},
): TranscriptRedaction {
  const counts: Counts = {};
  const sensitive = redactSensitive(transcript, format, rules.sensitive, carried, (input, kind) =>
    bump(counts, rules.withholdingRule(input, kind)),
  );
  const text =
    format === "json"
      ? redactDocument(sensitive.text, rules, counts)
      : sensitive.text
          .split("\n")
          .map((line) => (line.trim() ? redactDocument(line, rules, counts) : line))
          .join("\n");
  return { text, withheld: sensitive.withheld, summary: { rule_set: rules.hash, counts } };
}
