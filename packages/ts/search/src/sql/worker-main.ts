import { runSqlWorker } from "./worker";

/** The worker run directly by Bun, for tests and `bun run` (`scriptWorkerCommand`); a compiled
 * binary runs `seshi sql-worker`, which calls the same function. */
await runSqlWorker();
process.exit(0);
