/** The rule set built from today's JSON rule lists, the way callers built one before packs
 * (`redactionRules({ patterns })`). A JSON rule file loads as the `legacy` pack (F2.1), so this
 * is `compileRuleSet` over that pack; the patterns now run under RE2 like every operator
 * pattern (F2.2).
 *
 * The JSON shape is the one Dosu's CLI writes for an org's rules (`redaction.json`):
 *
 * ```json
 * { "patterns": ["ACME-[0-9A-F]{32}", "internal-key: (?P<secret>\\S+)"],
 *   "sensitive_files": ["config/master.key", "secrets/**", "!secrets/README.md"],
 *   "secret_commands": ["acme-cli\\s+token\\b"] }
 * ``` */

import type { RawFormat } from "@seshi/model";
import {
  checkLegacyRules,
  type LegacyRules,
  legacyPack,
  RulePackError,
  readLegacyRules,
} from "./pack";
import { applyTextRule, type Counts, compileRuleSet, type RuleSet } from "./ruleset";
import { redactSensitive, type WithheldCalls } from "./sensitive";

/** Today's JSON rule lists. */
export type RedactionConfig = LegacyRules;

/** A compiled rule set (the built-in pack plus the operator's). */
export type RedactionRules = RuleSet;

/** A rule pack or rule set that cannot be used. */
export { RulePackError as RedactionConfigError };

/** The built-in pack with `config`'s lists added as the `legacy` pack. Throws
 * `RulePackError` naming every pattern or command that is not usable: an operator who wrote
 * one expects it to apply, so it is refused rather than skipped. */
export function redactionRules(config: RedactionConfig = {}): RuleSet {
  const rules = checkLegacyRules(config, "redaction rules");
  const any =
    (rules.patterns?.length ?? 0) +
      (rules.sensitive_files?.length ?? 0) +
      (rules.secret_commands?.length ?? 0) >
    0;
  return compileRuleSet({ packs: any ? [legacyPack(rules, "redaction rules")] : [] });
}

/** `redactionRules` over a JSON rule file's text. */
export function parseRedactionConfig(json: string, source = "redaction rules"): RuleSet {
  const rules = readLegacyRules(json, source);
  const any = Object.values(rules).some((list) => list.length > 0);
  return compileRuleSet({ packs: any ? [legacyPack(rules, source)] : [] });
}

/** The passes over a native transcript that come before the built-in secret patterns:
 * sensitive calls, then the text rules. `carried` is what the pass over the session's earlier
 * chunks took out. `redactTranscript` runs every pass. */
export function applyRules(
  transcript: string,
  format: RawFormat,
  rules: RuleSet,
  carried: Readonly<WithheldCalls> = {},
): { text: string; withheld: WithheldCalls } {
  const sensitive = redactSensitive(transcript, format, rules.sensitive, carried);
  if (rules.text.length === 0) return sensitive;
  const counts: Counts = {};
  const redact = (value: unknown): { value: unknown; changed: boolean } => {
    if (typeof value === "string") {
      let next = value;
      for (const rule of rules.text) next = applyTextRule(next, rule, counts, rules);
      return { value: next, changed: next !== value };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((v) => {
        const r = redact(v);
        changed ||= r.changed;
        return r.value;
      });
      return changed ? { value: next, changed } : { value, changed };
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const r = redact(v);
        changed ||= r.changed;
        next[k] = r.value;
      }
      return changed ? { value: next, changed } : { value, changed };
    }
    return { value, changed: false };
  };
  const line = (text: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return redact(text).value as string;
    }
    const r = redact(parsed);
    return r.changed ? JSON.stringify(r.value) : text;
  };
  const text =
    format === "json"
      ? line(sensitive.text)
      : sensitive.text
          .split("\n")
          .map((l) => (l.trim() ? line(l) : l))
          .join("\n");
  return { text, withheld: sensitive.withheld };
}

export { RulePackError };
