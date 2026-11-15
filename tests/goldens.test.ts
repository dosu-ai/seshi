/** For every golden (the cross-language ones in `spec/testdata/goldens/`, each integration's in
 * its `testdata/goldens/`, ATIF's in `packages/ts/formats/testdata/goldens/`), `parseTrace`
 * must still produce the committed `content_hash`, events, trace fields and LLM calls, or reject
 * with `TrajectoryError` where the golden says so; and every transcript must still normalize to
 * its golden's records and LLM calls, so an adapter change is a visible diff too. `content_hash` is a layout contract
 * (`spec/layout.md`): a change here is a change every reader sees, so it has to be a deliberate
 * `bun run goldens` and a diff in review. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseTrace, TrajectoryError } from "@seshi/model";
import { normalizeTranscript } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { describe, expect, it } from "vitest";
import { type Expected, expectedOf, llmCallsFile } from "./tooling/goldens";
import { ROOT, testdataDirs } from "./tooling/testdata";

const FORMATS = buildFormats();

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

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
        const records = readJson(join(dir, `${name}.records.json`));
        const expected: Expected = readJson(join(dir, `${name}.expected.json`));
        const callsPath = join(dir, llmCallsFile(name));
        const llm_calls = existsSync(callsPath) ? readJson(callsPath) : undefined;
        const options = llm_calls ? { llm_calls } : {};

        if (expected.rejected) {
          it(`${name}: rejected (${expected.error})`, () => {
            expect(() => parseTrace(records, options)).toThrow(TrajectoryError);
            expect(() => parseTrace(records, options)).toThrow(expected.error);
          });
          continue;
        }

        it(`${name}: content_hash ${expected.content_hash.slice(0, 12)}`, () => {
          expect(expectedOf(parseTrace(records, options))).toEqual(expected);
        });
      }

      const transcripts = join(dir, "..", "transcripts");
      for (const file of existsSync(transcripts) ? readdirSync(transcripts).sort() : []) {
        const [name, source] = file.split(".") as [string, string];
        it(`${name}: the transcript still normalizes to the golden`, () => {
          const outcome = normalizeTranscript(FORMATS, {
            source,
            transcript: readFileSync(join(transcripts, file), "utf8"),
          });
          const callsPath = join(dir, llmCallsFile(name));
          expect(outcome.records).toEqual(readJson(join(dir, `${name}.records.json`)));
          expect(outcome.empty ? undefined : outcome.llm_calls).toEqual(
            existsSync(callsPath) ? readJson(callsPath) : undefined,
          );
        });
      }
    });
  }
});
