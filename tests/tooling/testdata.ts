/** Where the fixtures are (X3.6): cross-language record sets and their goldens in
 * `spec/testdata`, each vendor's transcripts and goldens in its integration's `testdata/`, and
 * ATIF's in `packages/ts/formats/testdata`. Tests look a fixture up by file name, wherever it
 * lives. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");

/** Every `testdata/` folder: spec's, the packages', and each integration's. */
export function testdataDirs(): string[] {
  const dirs = [join(ROOT, "spec", "testdata")];
  for (const parent of ["packages/ts", "integrations"]) {
    for (const name of readdirSync(join(ROOT, parent)).sort()) {
      const dir = join(ROOT, parent, name, "testdata");
      if (existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/** The path of `<kind>/<file>` in whichever testdata folder has it. */
export function fixturePath(kind: "transcripts" | "goldens" | "records", file: string): string {
  const found = testdataDirs()
    .map((dir) => join(dir, kind, file))
    .filter((path) => existsSync(path));
  if (found.length !== 1) {
    throw new Error(`${kind}/${file}: ${found.length === 0 ? "not found" : "found twice"}`);
  }
  return found[0] as string;
}

/** A transcript's text, by file name (`claude-basic.claude-code.jsonl`). */
export function transcript(file: string): string {
  return readFileSync(fixturePath("transcripts", file), "utf8");
}

/** A golden's parsed JSON, by file name (`claude-basic.records.json`). */
export function golden<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(fixturePath("goldens", file), "utf8")) as T;
}
