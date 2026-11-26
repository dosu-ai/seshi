/** The hostile-statement suite on DuckDB (docs/seshi/session-tools.md, "The hostile-statement
 * suite"): the same corpus as SQLite's run in `@seshi/search`, with DuckDB's own outcome where
 * it answers otherwise, run by real `sql` workers with DuckDB against the fixture built as a
 * LanceDB index, with decoy files (a real Lance table among them) beside it. Every case asserts
 * its outcome and that no decoy's marker (and, for a member, no other member's private text)
 * appears anywhere in the answer. Two checks run over the whole corpus as well: every statement
 * the check accepts also prepares, and every `owner`/`archive_id` pair an answer returns is one
 * the caller may see. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { provideSql, SqlRefused, SqlService, type SqlTables, sqlViews } from "@seshi/search";
import {
  expectOutcome,
  FIXTURE_NOW,
  HOSTILE_ADMIN,
  HOSTILE_ALICE,
  HOSTILE_FAMILIES,
  hostileCases,
  runCase,
} from "@seshi/search/sql-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDuckdb, SqlUnparsed } from "./check-duckdb";
import { DUCKDB_EXTENSIONS_ENV } from "./env";
import { duckdbSql } from "./sql";
import { buildLanceFixture, type LanceFixture, lanceExtensions } from "./testing";

const CASES = hostileCases("duckdb");
const TIMEOUT_MS = 2_000;

let dir: string;
let extensions: string;
let fixture: LanceFixture;
let tables: SqlTables;
let service: SqlService;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-lance-hostile-"));
  extensions = await lanceExtensions();
  fixture = await buildLanceFixture(dir);
  tables = await fixture.tables();
  // This process gets DuckDB, as the -sql build's entry gives it, so the pool starts workers
  // with DuckDB (`scriptWorkerCommand`).
  provideSql(duckdbSql);
  service = new SqlService({
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
    settings: {
      workers: 2,
      timeout: TIMEOUT_MS,
      memory: 128 * 1024 ** 2,
      workerMemory: 1024 ** 3,
    },
  });
}, 120_000);

afterAll(async () => {
  await service?.close();
  await fixture?.index.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the hostile-statement suite on DuckDB, over a Lance index", () => {
  it("has cases for every family the design lists", () => {
    const families = new Set(CASES.map((c) => c.family));
    for (const family of HOSTILE_FAMILIES) expect(families, family).toContain(family);
  });

  for (const c of CASES) {
    it(`${c.id} (${c.expect}${c.as === "member" ? ", as a member" : ""}): ${JSON.stringify(c.sql).slice(0, 70)}`, async () => {
      expectOutcome(c, await runCase(service, c));
    }, 30_000);
  }

  it("answers after a statement it interrupted for time", async () => {
    const result = await service.query(HOSTILE_ADMIN, { sql: "SELECT count(*) FROM sessions" });
    expect(result.rows).toEqual([[5]]);
  });

  it("prepares every statement the check accepts (unless DuckDB's binder refuses it)", async () => {
    const instance = await DuckDBInstance.create(":memory:", {
      extension_directory: extensions,
      autoload_known_extensions: "false",
    });
    const connection = await instance.connect();
    try {
      await connection.run("LOAD lance");
      for (const view of sqlViews(
        "duckdb",
        HOSTILE_ALICE.viewer,
        { since: 0, until: FIXTURE_NOW },
        tables,
      )) {
        await connection.run(view);
      }
      for (const c of CASES) {
        try {
          await checkDuckdb(connection, c.sql);
        } catch (err) {
          if (err instanceof SqlUnparsed) {
            expect(c.expect, `${c.id} does not parse`).toBe("error");
            continue;
          }
          expect(err, c.id).toBeInstanceOf(SqlRefused);
          expect(c.expect, `${c.id} was refused by the check`).toBe("refused");
          continue;
        }
        expect(c.expect, `${c.id} was accepted`).not.toBe("refused");
        let prepared = true;
        try {
          (await connection.prepare(c.sql)).destroySync();
        } catch {
          prepared = false;
        }
        expect(prepared || c.expect === "error", `${c.id} does not prepare`).toBe(true);
        if (c.expect === "error") expect(prepared, `${c.id} prepares`).toBe(false);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }, 120_000);
});
