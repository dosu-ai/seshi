/** The scenario generator and the explorer's bookkeeping (33): every plan makes a valid scenario
 * that ends with a settle, respects the preconditions, reads back from its YAML unchanged and
 * is the same for the same seed; failures are grouped and matched while shrinking by their
 * shape. The generated scenarios themselves run in tests/scenarios/generated.test.ts. */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sameFailure, shapeOf, signatureOf } from "./explore";
import { buildScenario, type Plan, planArb, toYaml } from "./generate";
import { loadScenario, type Step } from "./schema";

const plans = (seed: number, numRuns = 300): Plan[] => fc.sample(planArb(25), { seed, numRuns });

/** The sessions a step needs to exist already. */
function needs(step: Step): string[] {
  switch (step.kind) {
    case "subagent":
      return [step.parent];
    case "compact":
    case "move-transcript":
    case "hook":
      return [step.session];
    case "capture": {
      const i = step.args.indexOf("--session");
      return i === -1 ? [] : [step.args[i + 1] as string];
    }
    default:
      return [];
  }
}

describe("the generator", () => {
  it("makes valid scenarios that end with a settle and respect the preconditions", () => {
    for (const plan of plans(1)) {
      const { scenario } = buildScenario(plan, "t");
      const { steps, setup } = scenario;
      expect(steps.at(-1)?.kind).toBe("settle");
      const exists = new Set<string>();
      let armed = 0;
      let rulesDirty = false;
      for (const step of steps) {
        for (const name of needs(step)) expect(exists, `${name} before it exists`).toContain(name);
        if (step.kind === "turns") exists.add(step.session);
        if (step.kind === "subagent") exists.add(`agent-${step.id}`);
        if (step.kind === "review") expect(setup.review).toBeDefined();
        if (step.kind === "fault") {
          if ("http" in step) expect(setup.mode).toBe("server");
          else if (step.error === "precondition") {
            expect(step.after || step.key.endsWith("metadata.json")).toBe(true);
          }
          armed++;
        }
        if (step.kind === "heal") armed = 0;
        if (step.kind === "rules") rulesDirty = true;
        if (step.kind === "backfill") rulesDirty = false;
        if (step.kind === "capture" && step.args[0] === "resend") {
          expect(step.args).toEqual(["resend", "--all"]);
        }
        if (step.kind === "settle") {
          expect(armed, "a settle with a fault armed").toBe(0);
          expect(rulesDirty, "a settle after a rule change with no backfill").toBe(false);
        }
      }
    }
  });

  it("covers every step kind, both modes and review", () => {
    const kinds = new Set<string>();
    const modes = new Set<string>();
    let review = 0;
    for (const plan of plans(2, 500)) {
      const { scenario } = buildScenario(plan, "t");
      modes.add(scenario.setup.mode);
      if (scenario.setup.review) review++;
      for (const step of scenario.steps) kinds.add(step.kind);
    }
    expect([...modes].sort()).toEqual(["local", "server"]);
    expect(review).toBeGreaterThan(50);
    for (const kind of [
      "turns",
      "subagent",
      "compact",
      "move-transcript",
      "hook",
      "pass",
      "capture",
      "clock",
      "restart-server",
      "rules",
      "format-bump",
      "sweep",
      "backfill",
      "review",
      "fault",
      "heal",
      "settle",
    ]) {
      expect(kinds).toContain(kind);
    }
  });

  it("writes YAML that reads back as the same scenario", () => {
    for (const plan of plans(3, 200)) {
      const { raw, scenario } = buildScenario(plan, "t");
      expect(loadScenario("t", toYaml(raw))).toEqual(scenario);
    }
  });

  it("is the same for the same seed", () => {
    const yaml = (seed: number) => plans(seed, 20).map((p) => toYaml(buildScenario(p, "t").raw));
    expect(yaml(7)).toEqual(yaml(7));
    expect(yaml(7)).not.toEqual(yaml(8));
  });
});

describe("failure shapes", () => {
  const doctor = (checks: string[]) =>
    [
      "generated:9: step 7 (settle max=40): once quiet, seshi doctor fails a check",
      ...checks.map((c) => `  main: ${c}: the transcript's first 3146 bytes differ`),
      "      detail line",
      "  faults fired:",
      "    store put owners/me/changes/x: …",
    ].join("\n");

  it("leave out the file, the step, numbers, session names and bucket keys", () => {
    const shape = shapeOf(doctor(["records"]));
    expect(shape).toEqual({
      head: "once quiet, seshi doctor fails S check",
      keys: ["S: records"],
    });
    expect(signatureOf(shape)).toBe("once quiet, seshi doctor fails S check | S: records");
    const store = shapeOf(
      "x: step 3 (pass): checkStore found errors\n  error head_missing: head 9d64b43270ca… has no object (owners/me/sessions/ab12/trace.9d.json.gz)",
    );
    expect(store.keys).toEqual(["error head_missing: head H… has no object KEY"]);
  });

  it("match while shrinking when the first finding is still there", () => {
    const original = shapeOf(doctor(["records"]));
    expect(sameFailure(original, shapeOf(doctor(["offsets", "records"])))).toBe(true);
    expect(sameFailure(original, shapeOf(doctor(["offsets"])))).toBe(false);
    expect(
      sameFailure(original, shapeOf("x: step 2 (pass): checkStore found errors\n  error y: z")),
    ).toBe(false);
  });
});
