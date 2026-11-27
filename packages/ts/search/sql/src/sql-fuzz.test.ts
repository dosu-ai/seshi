/** The `sql` fuzzer on DuckDB over a Lance index (`bun run test:sql-fuzz`, nightly; see
 * `@seshi/search`'s `fuzz.ts`): corpus mutations and generated scope probes, run by real workers
 * over the fixture index and, for the answer each must match, over reference Lance indexes
 * holding only what each caller sees. Skipped in `bun run test`. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { provideSql, SqlRefused, SqlService, sqlViews } from "@seshi/search";
import {
  FIXTURE_NOW,
  FUZZ_ENABLED,
  type FuzzCallerName,
  type FuzzCheckVerdict,
  type FuzzEngine,
  fuzzOptionsFromEnv,
  fuzzReferenceSessions,
  fuzzSql,
  HOSTILE_ADMIN,
  reportFuzz,
  unexplainedFindings,
} from "@seshi/search/sql-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDuckdb, SqlUnparsed } from "./check-duckdb";
import { DUCKDB_EXTENSIONS_ENV } from "./env";
import { duckdbSql } from "./sql";
import { buildLanceFixture, type LanceFixture, lanceExtensions } from "./testing";

let dir: string;
const fixtures: LanceFixture[] = [];
const services: SqlService[] = [];
let instance: DuckDBInstance | undefined;
let connection: DuckDBConnection | undefined;

async function serviceOver(fixture: LanceFixture, extensions: string): Promise<SqlService> {
  const tables = await fixture.tables();
  const service = new SqlService({
    search: {
      status: async () => ({
        backend: "lance",
        location: fixture.uri,
        ready: true,
        sessions: 0,
        events: 0,
        caught_up_at: new Date(FIXTURE_NOW).toISOString(),
      }),
      sqlTables: async () => tables,
    },
    now: () => new Date(FIXTURE_NOW),
    workerEnv: { [DUCKDB_EXTENSIONS_ENV]: extensions },
    settings: { workers: 4, timeout: 2_000, memory: 128 * 1024 ** 2, workerMemory: 1024 ** 3 },
  });
  services.push(service);
  return service;
}

async function engine(): Promise<FuzzEngine> {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-lance-fuzz-"));
  const extensions = await lanceExtensions();
  provideSql(duckdbSql);
  const full = await buildLanceFixture(join(dir, "full"));
  fixtures.push(full);
  const reference = {} as Record<FuzzCallerName, SqlService>;
  for (const caller of ["member", "admin"] as const) {
    const fixture = await buildLanceFixture(
      join(dir, caller),
      undefined,
      fuzzReferenceSessions(caller, FIXTURE_NOW),
    );
    fixtures.push(fixture);
    reference[caller] = await serviceOver(fixture, extensions);
  }
  const tables = await full.tables();

  instance = await DuckDBInstance.create(":memory:", {
    extension_directory: extensions,
    autoload_known_extensions: "false",
  });
  const conn = await instance.connect();
  connection = conn;
  await conn.run("LOAD lance");
  for (const view of sqlViews(
    "duckdb",
    HOSTILE_ADMIN.viewer,
    { since: 0, until: FIXTURE_NOW },
    tables,
  )) {
    await conn.run(view);
  }
  const decoys = ["decoy.csv", "decoy.sqlite", "credentials.json", "decoy.lance"];
  return {
    dialect: "duckdb",
    now: FIXTURE_NOW,
    paths: [
      tables.events,
      tables.sessions,
      tables.llm_calls,
      `${tables.events}/data/*`,
      full.uri,
      ...decoys,
      ...decoys.map((d) => join(dir, "full", d)),
      "/etc/passwd",
    ],
    full: await serviceOver(full, extensions),
    reference,
    checkThenPrepare: async (sql): Promise<FuzzCheckVerdict> => {
      try {
        await checkDuckdb(conn, sql);
      } catch (err) {
        if (err instanceof SqlRefused || err instanceof SqlUnparsed) return "refused";
        throw err;
      }
      try {
        (await conn.prepare(sql)).destroySync();
        return "prepared";
      } catch (err) {
        const message = (err as Error).message;
        return /Parser Error/i.test(message) ? { parse: message } : "bind";
      }
    },
  };
}

afterAll(async () => {
  connection?.closeSync();
  instance?.closeSync();
  await Promise.all(services.map((s) => s.close()));
  await Promise.all(fixtures.map((f) => f.index.close()));
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!FUZZ_ENABLED)("the sql fuzzer on DuckDB, over a Lance index", () => {
  let fuzzEngine: FuzzEngine;
  beforeAll(async () => {
    fuzzEngine = await engine();
  }, 300_000);

  it("finds nothing out of scope", async () => {
    // DuckDB over Lance takes about 100 ms a query: 2,000 statements in about 12 minutes.
    const options = fuzzOptionsFromEnv(1_000);
    console.log(`sql fuzz on duckdb: seed ${options.seed}, ${options.count} per stream`);
    const summary = await fuzzSql(fuzzEngine, { ...options, log: console.log });
    reportFuzz("duckdb", options, summary);
    expect(unexplainedFindings(summary.findings)).toEqual([]);
  }, 3_600_000);
});
