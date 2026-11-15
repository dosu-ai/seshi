import { defineConfig } from "vitest/config";
import base from "./vitest.config";

/** What runs on a developer's laptop (F8.4, revised 15 Nov 2026: decision 9 of
 * docs/seshi/build/18-decisions.md): the capture hooks, spool, uploader, sweep and state; the
 * hooks' contract and the agents' hook handlers and installers; the CLI config; the HTTP client
 * the CLI uploads with; and the CLI's own wiring (accounts and credentials, output, the capture
 * commands' helpers, the session doctor's checks, the entry point). CI runs these on Windows
 * (`bun run test:laptop`); the full suite stays on Linux.
 *
 * Left out, as server code that stays Linux-only: the server's config and its loader
 * (`load.test.ts`, `show.test.ts`, `server/`), the server commands (`serve`, `admin`,
 * `workers`, `sync`, `reprocess`, `review`, `search` and `redact backfill`, in
 * `apps/seshi/src/commands/`), and `tests/` (end to end against a served Instance). */
export const LAPTOP_TESTS = [
  "packages/ts/capture/src/**/*.test.ts",
  "packages/ts/kit/src/capture.test.ts",
  "packages/ts/config/src/cli.test.ts",
  "packages/ts/config/src/secret.test.ts",
  "packages/ts/config/src/units.test.ts",
  "packages/ts/client/src/**/*.test.ts",
  "integrations/claude-code/src/**/capture.test.ts",
  "integrations/codex/src/**/capture.test.ts",
  "integrations/cursor/src/**/capture.test.ts",
  "apps/seshi/src/account/**/*.test.ts",
  "apps/seshi/src/cli/**/*.test.ts",
  "apps/seshi/src/capture.test.ts",
  "apps/seshi/src/doctor/**/*.test.ts",
  "apps/seshi/src/integrations.test.ts",
  "apps/seshi/src/main.test.ts",
];

export default defineConfig({ ...base, test: { ...base.test, include: LAPTOP_TESTS } });
