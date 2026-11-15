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
 * 3. Except in a tool call's input (an object or array under `input`, `arguments`, `args` or
 *    `parameters`). The server normalizes that to one JSON string, the call's `args`, and
 *    redacts all of it, so here it is redacted the same way: serialized, run through the rules
 *    as one string, and read back. That takes out what sits under an input's own `name`,
 *    `type` or `id`, and a value a rule finds only with its key (`"password":"…"`). When a
 *    match spans the JSON's structure so the result no longer parses, every string of the
 *    input is redacted on its own instead, framing keys included.
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
  // As the server's record redaction leaves them (`redactor.ts`): a branch name that looks
  // random to the entropy rule would otherwise reach the server as a marker.
  "source",
  "gitBranch",
  "git_branch",
]);

/** Keys under which an agent keeps a tool call's input (as `sensitive.ts` reads calls). */
const INPUT_KEYS: ReadonlySet<string> = new Set(["input", "arguments", "args", "parameters"]);

function isStructural(key: string | undefined): boolean {
  return key !== undefined && STRUCTURAL_KEYS.has(key);
}

type Redacted = { value: unknown; changed: boolean };

/** A tool call's input (an object or array) as the server redacts its `args`: one JSON string. */
function redactInput(value: object, rules: RuleSet, counts: Counts): Redacted {
  const text = JSON.stringify(value);
  const found: Counts = {};
  const next = rules.redactString(text, "anywhere", found);
  if (next === text) return { value, changed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(next);
  } catch {
    // A match ran across quotes or brackets: redact each string, none exempt.
    return redactStrings(value, rules, counts, undefined, true);
  }
  for (const [rule, n] of Object.entries(found)) bump(counts, rule, n);
  return { value: parsed, changed: true };
}

/** `value` with its strings redacted; under a structural key a string is left alone, unless
 * `every` (inside a tool call's input). */
function redactStrings(
  value: unknown,
  rules: RuleSet,
  counts: Counts,
  key?: string,
  every = false,
): Redacted {
  if (typeof value === "string") {
    if (!every && isStructural(key)) return { value, changed: false };
    const next = rules.redactString(value, "anywhere", counts);
    return { value: next, changed: next !== value };
  }
  if (!every && key !== undefined && INPUT_KEYS.has(key) && value !== null) {
    if (typeof value === "object") return redactInput(value, rules, counts);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactStrings(item, rules, counts, undefined, every);
      changed ||= r.changed;
      return r.value;
    });
    return changed ? { value: next, changed } : { value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [k, item] of Object.entries(value)) {
      const r = redactStrings(item, rules, counts, k, every);
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
