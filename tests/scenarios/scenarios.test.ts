/** The capture scenarios (32): every `*.yaml` here is one test. Each runs in-process (a served
 * Instance over a temporary bucket, a simulated machine running real seshi commands, synthetic
 * transcripts, the fake reviewer, one scenario clock), checks the invariants after every step
 * and the quiet-state checks at `settle` and at the end. tests/scenarios/README.md is the
 * format; tests/tooling/scenario/ is the runner. A file that does not parse is a failing test
 * naming the file and step, never a crash of the whole suite. */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScenario } from "../tooling/scenario/runner";
import { loadScenario, type Scenario, ScenarioError } from "../tooling/scenario/schema";

const DIR = import.meta.dirname;
const FILES = readdirSync(DIR)
  .filter((name) => name.endsWith(".yaml"))
  .sort();

describe("capture scenarios", () => {
  it("has scenarios to run", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  for (const name of FILES) {
    const file = `tests/scenarios/${name}`;
    let scenario: Scenario | undefined;
    let invalid: Error | undefined;
    try {
      scenario = loadScenario(file, readFileSync(join(DIR, name), "utf8"));
    } catch (err) {
      if (!(err instanceof ScenarioError)) throw err;
      invalid = err;
    }
    it(scenario ? `${name}: ${scenario.name}` : name, async () => {
      if (invalid) throw invalid;
      await runScenario(scenario as Scenario);
    });
  }
});
