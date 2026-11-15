import { defineConfig } from "vitest/config";

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
  },
});
