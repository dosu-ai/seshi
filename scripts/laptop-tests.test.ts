/** The Windows CI job runs `bun run test:laptop` (F8.4, decision 9): every pattern it lists must
 * still name test files, so a move or rename cannot quietly empty the job, and none of them may
 * reach the server's tests, which stay on Linux. */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LAPTOP_TESTS } from "../vitest.laptop.config";

const root = join(import.meta.dirname, "..");
const matches = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: root })];

describe("the laptop test selection", () => {
  it("names test files with every pattern", () => {
    for (const pattern of LAPTOP_TESTS) expect(matches(pattern), pattern).not.toEqual([]);
  });

  it("covers capture, the CLI config and the client, and leaves the server out", () => {
    const files = new Set(LAPTOP_TESTS.flatMap(matches).map((f) => f.replaceAll("\\", "/")));
    for (const file of [
      "packages/ts/capture/src/uploader.test.ts",
      "packages/ts/capture/src/hook.test.ts",
      "packages/ts/capture/src/state.test.ts",
      "packages/ts/config/src/cli.test.ts",
      "packages/ts/client/src/http.test.ts",
      "apps/seshi/src/capture.test.ts",
    ]) {
      expect(files.has(file), file).toBe(true);
    }
    for (const file of files) {
      expect(file).not.toMatch(/^tests\/|commands\/serve\.test|config\/src\/load\.test/);
    }
  });
});
