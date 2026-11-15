/** Regenerates the goldens (`bun run goldens`):
 *
 * 1. every transcript in a `testdata/transcripts/` folder (each integration's, and ATIF's in
 *    `packages/ts/formats`) is normalized through this binary's formats and redacted, as the
 *    server would, and the records written to `<name>.records.json` in the `goldens/` folder
 *    beside it; every hand-written record set in `spec/testdata/records/` is copied into
 *    `spec/testdata/goldens/` as-is (edge cases no adapter produces);
 * 2. each record set is parsed and what came out (`content_hash`, events, the rest of the trace,
 *    or the rejection) is written to `<name>.expected.json` beside it.
 *
 * 3. every redaction case (`packages/ts/redact/testdata/redaction/`, see `redaction-goldens.ts`)
 *    is redacted with its packs and what came out written to its `expected.json`.
 *
 * `tests/goldens.test.ts` asserts `parseTrace` still reproduces every expected file, so a
 * change to the hash or the event derivation is a visible diff, never an accident. Commit the
 * outputs. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTrace, TrajectoryError } from "@seshi/model";
import { normalizeTranscript } from "@seshi/pipeline";
import { buildFormats } from "seshi/integrations";
import { expectedOf } from "./goldens";
import { computeCase, redactionCases } from "./redaction-goldens";
import { testdataDirs } from "./testdata";

const formats = buildFormats();

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

for (const testdata of testdataDirs()) {
  const transcripts = join(testdata, "transcripts");
  const records = join(testdata, "records");
  if (!existsSync(transcripts) && !existsSync(records)) continue;
  const goldens = join(testdata, "goldens");
  rmSync(goldens, { recursive: true, force: true });
  mkdirSync(goldens, { recursive: true });

  const names: string[] = [];
  for (const file of existsSync(transcripts) ? readdirSync(transcripts).sort() : []) {
    const [name, source] = file.split(".");
    if (!name || !source || !formats.has(source)) throw new Error(`${file}: unknown source`);
    const outcome = normalizeTranscript(formats, {
      source,
      transcript: readFileSync(join(transcripts, file), "utf8"),
    });
    if (outcome.empty) throw new Error(`${file}: no conversation`);
    writeJson(goldens, `${name}.records.json`, outcome.records);
    names.push(name);
    console.log(`${name}: ${outcome.records.length} records from ${source}`);
  }
  for (const file of existsSync(records) ? readdirSync(records).sort() : []) {
    const name = basename(file, ".json");
    writeFileSync(join(goldens, `${name}.records.json`), readFileSync(join(records, file)));
    names.push(name);
    console.log(`${name}: hand-written records`);
  }

  for (const name of names) {
    const set = JSON.parse(readFileSync(join(goldens, `${name}.records.json`), "utf8"));
    try {
      const expected = expectedOf(parseTrace(set));
      writeJson(goldens, `${name}.expected.json`, expected);
      console.log(`${name}: ${expected.content_hash.slice(0, 12)}`);
    } catch (err) {
      if (!(err instanceof TrajectoryError)) throw err;
      writeJson(goldens, `${name}.expected.json`, { rejected: true, error: err.message });
      console.log(`${name}: rejected (${err.message})`);
    }
  }
}

for (const { name, dir } of redactionCases()) {
  writeJson(dir, "expected.json", computeCase(dir));
  console.log(`redaction ${name}: written`);
}
