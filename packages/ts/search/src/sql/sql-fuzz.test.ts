/** The `sql` fuzzer on SQLite (`bun run test:sql-fuzz`, nightly; see `fuzz.ts`): corpus
 * mutations and generated scope probes, run by real workers over the fixture index and, for the
 * answer each must match, over reference indexes holding only what each caller sees. Skipped in
 * `bun run test`. */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSqlite, SqlRefused } from "./check-sqlite";
import { buildFixture, FIXTURE_NOW } from "./fixture";
import {
  FUZZ_ENABLED,
  type FuzzCallerName,
  type FuzzCheckVerdict,
  type FuzzEngine,
  fuzzOptionsFromEnv,
  fuzzReferenceSessions,
  fuzzSql,
  reportFuzz,
  unexplainedFindings,
} from "./fuzz";
import { HOSTILE_ADMIN } from "./hostile";
import { SqlService } from "./service";
import { sqlViews } from "./views";

let dir: string;
let services: SqlService[] = [];
let db: Database | undefined;

function serviceOver(path: string): SqlService {
  const service = new SqlService({
    search: {
      status: async () => ({
        backend: "sqlite",
        location: path,
        ready: true,
        sessions: 0,
        events: 0,
        caught_up_at: new Date(FIXTURE_NOW).toISOString(),
      }),
    },
    now: () => new Date(FIXTURE_NOW),
    settings: { workers: 4, timeout: 2_000, memory: 64 * 1024 ** 2, workerMemory: 256 * 1024 ** 2 },
  });
  services.push(service);
  return service;
}

/** SQLite's own reading of a statement it cannot prepare: a parse error, not a bind error. */
const PARSE_ERROR = /syntax error|incomplete input|unrecognized token/i;

async function engine(): Promise<FuzzEngine> {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-fuzz-"));
  const full = await buildFixture(join(dir, "full"));
  const reference = {} as Record<FuzzCallerName, SqlService>;
  for (const caller of ["member", "admin"] as const) {
    reference[caller] = serviceOver(
      await buildFixture(join(dir, caller), fuzzReferenceSessions(caller, FIXTURE_NOW)),
    );
  }
  const handle = new Database(full, { readonly: true });
  db = handle;
  for (const view of sqlViews("sqlite", HOSTILE_ADMIN.viewer, { since: 0, until: FIXTURE_NOW })) {
    handle.run(view);
  }
  handle.run("PRAGMA query_only = 1");
  const decoys = ["decoy.csv", "decoy.sqlite", "credentials.json", "decoy.lance"];
  return {
    dialect: "sqlite",
    now: FIXTURE_NOW,
    paths: [
      full,
      `file:${full}?mode=ro`,
      ...decoys,
      ...decoys.map((d) => join(dir, "full", d)),
      "/etc/passwd",
    ],
    full: serviceOver(full),
    reference,
    checkThenPrepare: async (sql): Promise<FuzzCheckVerdict> => {
      let body: string;
      try {
        body = checkSqlite(sql).body;
      } catch (err) {
        if (err instanceof SqlRefused) return "refused";
        throw err;
      }
      try {
        handle.prepare(body).finalize();
        return "prepared";
      } catch (err) {
        const message = (err as Error).message;
        return PARSE_ERROR.test(message) ? { parse: message } : "bind";
      }
    },
  };
}

afterAll(async () => {
  db?.close();
  await Promise.all(services.map((s) => s.close()));
  services = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!FUZZ_ENABLED)("the sql fuzzer on SQLite", () => {
  let fuzzEngine: FuzzEngine;
  beforeAll(async () => {
    fuzzEngine = await engine();
  }, 120_000);

  it("finds nothing out of scope", async () => {
    // SQLite answers in a few milliseconds: 10,000 statements in about 20 s.
    const options = fuzzOptionsFromEnv(5_000);
    console.log(`sql fuzz on sqlite: seed ${options.seed}, ${options.count} per stream`);
    const summary = await fuzzSql(fuzzEngine, { ...options, log: console.log });
    reportFuzz("sqlite", options, summary);
    expect(unexplainedFindings(summary.findings)).toEqual([]);
  }, 3_600_000);
});
