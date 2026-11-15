/** For every golden (the cross-language ones in `spec/testdata/goldens/`, each integration's in
 * its `testdata/goldens/`, ATIF's in `packages/ts/formats/testdata/goldens/`), `parseTrajectory`
 * must still produce the committed `content_hash`, events and trace fields, or reject with
 * `TrajectoryError` where the golden says so. `content_hash` is a layout contract
 * (`spec/layout.md`): a change here is a change every reader sees, so it has to be a deliberate
 * `bun run goldens` and a diff in review. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseTrajectory, TrajectoryError } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { type Expected, expectedOf } from "./tooling/goldens";
import { ROOT, testdataDirs } from "./tooling/testdata";

const sets = testdataDirs()
  .map((dir) => join(dir, "goldens"))
  .filter((dir) => existsSync(dir))
  .map((dir) => ({
    dir,
    names: readdirSync(dir)
      .filter((f) => f.endsWith(".records.json"))
      .map((f) => f.slice(0, -".records.json".length))
      .sort(),
  }));

describe("goldens", () => {
  it("has goldens to check, cross-language ones among them", () => {
    expect(sets.flatMap((set) => set.names).length).toBeGreaterThan(0);
    expect(sets.find((set) => set.dir === join(ROOT, "spec", "testdata", "goldens"))).toBeDefined();
  });

  for (const { dir, names } of sets) {
    describe(relative(ROOT, dir), () => {
      for (const name of names) {
        const records = JSON.parse(readFileSync(join(dir, `${name}.records.json`), "utf8"));
        const expected: Expected = JSON.parse(
          readFileSync(join(dir, `${name}.expected.json`), "utf8"),
        );

        if (expected.rejected) {
          it(`${name}: rejected (${expected.error})`, () => {
            expect(() => parseTrajectory(records)).toThrow(TrajectoryError);
            expect(() => parseTrajectory(records)).toThrow(expected.error);
          });
          continue;
        }

        it(`${name}: content_hash ${expected.content_hash.slice(0, 12)}`, () => {
          expect(expectedOf(parseTrajectory(records))).toEqual(expected);
        });
      }
    });
  }
});
