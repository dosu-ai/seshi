/** The redaction goldens (F2): each case in `packages/ts/redact/testdata/redaction/<case>/`
 * holds operator packs (`packs/*.toml`, `packs/*.json`, applied in file-name order; none for
 * the built-in pack alone) and an input: normalized records (`input.records.json`, redacted as
 * the pipeline's redaction stage does) or a native transcript (`input.<format>`, `jsonl` or
 * `json`, redacted as the uploader's pre-redaction does, F2.4). `expected.json` is what came
 * out: the records or text, the withheld calls, and the summary (rule-set hash and counts by
 * rule id).
 *
 * `tests/redact/goldens.test.ts` checks every case still comes out the same, and that the
 * output redacts to itself; `bun run goldens` rewrites `expected.json`. A diff in review is a
 * change in what the rules do, so it has to be deliberate. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRecord, RawFormat } from "@seshi/model";
import {
  compileRuleSet,
  loadPacks,
  type RuleSet,
  redactTranscript,
  ruleRedactor,
} from "@seshi/redact";
import { ROOT } from "./testdata";

export const REDACTION_GOLDENS = join(ROOT, "packages/ts/redact/testdata/redaction");

export interface RedactionCase {
  name: string;
  dir: string;
}

export function redactionCases(): RedactionCase[] {
  return readdirSync(REDACTION_GOLDENS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, dir: join(REDACTION_GOLDENS, e.name) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The case's rule set: the built-in pack and the case's packs, test strings checked. */
export function caseRules(dir: string): RuleSet {
  const packsDir = join(dir, "packs");
  const files = existsSync(packsDir)
    ? readdirSync(packsDir)
        .sort()
        .map((name) => ({ path: name, text: readFileSync(join(packsDir, name), "utf8") }))
    : [];
  return compileRuleSet({ packs: loadPacks(files).map((l) => l.pack), runTests: true });
}

/** The case's input: records, or a transcript and its format. */
export function caseInput(
  dir: string,
): { records: NormalizedRecord[] } | { transcript: string; format: RawFormat } {
  const records = join(dir, "input.records.json");
  if (existsSync(records)) return { records: JSON.parse(readFileSync(records, "utf8")) };
  for (const format of ["jsonl", "json"] as const) {
    const path = join(dir, `input.${format}`);
    if (existsSync(path)) return { transcript: readFileSync(path, "utf8"), format };
  }
  throw new Error(`${dir}: no input.records.json, input.jsonl or input.json`);
}

/** What the case's rules make of its input. */
export function computeCase(dir: string): Record<string, unknown> {
  const rules = caseRules(dir);
  const input = caseInput(dir);
  if ("records" in input) {
    const out = ruleRedactor(rules).redact(input.records);
    return { records: out.records, withheld: out.withheld, summary: out.summary };
  }
  const out = redactTranscript(rules, input.transcript, input.format);
  return { text: out.text, withheld: out.withheld, summary: out.summary };
}
