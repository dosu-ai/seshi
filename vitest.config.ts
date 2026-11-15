import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

/** An Instance whose config names no search.path keeps its index in the user cache folder
 * (F10.3); tests must never write there, nor see an index a previous run left behind (several
 * tests use the same deployment id). A fresh folder per run, removed when the run ends. */
const cache = mkdtempSync(join(tmpdir(), "seshi-vitest-cache-"));
process.on("exit", () => rmSync(cache, { recursive: true, force: true }));

/** Every workspace package exports its source through the `bun` condition (X3.4); Vite does not
 * know that condition, so it goes in front of Vite's own server defaults (`module`, `node`,
 * `development|production`), which setting the list replaces. */
const conditions = ["bun", "module", "node", "development|production"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    environment: "node",
    include: [
      "apps/*/src/**/*.test.ts",
      "packages/ts/*/src/**/*.test.ts",
      "integrations/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    pool: "forks",
    testTimeout: 30_000,
    env: { XDG_CACHE_HOME: cache },
  },
});
