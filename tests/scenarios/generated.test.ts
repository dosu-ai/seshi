/** Generated capture scenarios (33): a small, fixed budget of the explorer's runs in every
 * `bun run test`. Each seed draws one scenario of up to 25 steps from `generate.ts`, runs it
 * with the same invariants and quiet checks as the hand-written ones, and, on a failure, shrinks
 * it and writes the minimal scenario to tests/scenarios/found/ (the failure names the file).
 * The seeds are fixed and the shrink is bounded by a count of runs, so the same code always
 * gives the same result: CI never flakes on it. Longer exploration, with fresh seeds, is
 * `bun run scenarios:explore` (tests/scenarios/README.md). */

import { describe, it } from "vitest";
import { exploreOne, FOUND_DIR } from "../tooling/scenario/explore";

/** The budget: 40 seeds of up to 25 steps, about 3 s of test time when nothing fails. */
const BUDGET = { first: 33_000, seeds: 40, maxSteps: 25, shrinkRuns: 150 };

describe("generated capture scenarios", () => {
  for (let i = 0; i < BUDGET.seeds; i++) {
    const seed = BUDGET.first + i;
    it(`seed ${seed}`, { timeout: 300_000 }, async () => {
      const result = await exploreOne(seed, {
        maxSteps: BUDGET.maxSteps,
        shrinkRuns: BUDGET.shrinkRuns,
        dir: FOUND_DIR,
      });
      if (result.found) {
        throw new Error(
          `seed ${seed} failed (${result.found.original} steps, shrunk to ${result.found.steps}): ${result.found.file}\n${result.found.message}`,
        );
      }
    });
  }
});
