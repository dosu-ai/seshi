/** The redaction goldens (`packages/ts/redact/testdata/redaction/`, see
 * `tooling/redaction-goldens.ts`): every case's packs and input must still redact to its
 * committed `expected.json`, and what came out must redact to itself with nothing counted, the
 * property backfill and whole-upload extension rely on. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedRecord } from "@seshi/model";
import { redactTranscript, ruleRedactor } from "@seshi/redact";
import { describe, expect, it } from "vitest";
import { caseInput, caseRules, computeCase, redactionCases } from "../tooling/redaction-goldens";

const cases = redactionCases();

describe("redaction goldens", () => {
  it("has cases: the built-in pack alone, operator packs, a JSON file, a transcript", () => {
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "builtin-only",
        "operator-pack",
        "legacy-and-pack",
        "transcript-preredaction",
      ]),
    );
  });

  for (const { name, dir } of cases) {
    describe(name, () => {
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));

      it("comes out as expected.json (run `bun run goldens` after a deliberate change)", () => {
        expect(computeCase(dir)).toEqual(expected);
      });

      it("redacts to itself, counting nothing", () => {
        const rules = caseRules(dir);
        const input = caseInput(dir);
        if ("records" in input) {
          const again = ruleRedactor(rules).redact(
            expected.records as NormalizedRecord[],
            expected.withheld,
          );
          expect(again.records).toEqual(expected.records);
          expect(again.summary.counts).toEqual({});
        } else {
          const again = redactTranscript(rules, expected.text, input.format, expected.withheld);
          expect(again.text).toBe(expected.text);
          expect(again.summary.counts).toEqual({});
        }
      });

      it("records counts by rule id and the rule set's hash, never what matched", () => {
        expect(expected.summary.rule_set).toBe(caseRules(dir).hash);
        for (const id of Object.keys(expected.summary.counts)) {
          expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        }
      });
    });
  }
});
