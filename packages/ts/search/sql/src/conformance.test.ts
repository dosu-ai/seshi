/** `sql` on a LanceDB index, end to end through real workers with DuckDB: the schema the
 * endpoint serves, the DDL against what DuckDB reports for each view, the three examples (the
 * same answers SQLite gives, in DuckDB's dialect), a member's scope as a commit changes it, and
 * the worker reading the bucket with only the credential in its environment. On a folder in
 * every run; on S3, Azure Blob Storage and Google Cloud Storage where the same variables as the
 * search index's conformance suite name one (CI's rustfs and Azurite; a real GCS bucket):
 *
 *   SESHI_TEST_S3_ENDPOINT, SESHI_TEST_S3_BUCKET, SESHI_TEST_S3_ACCESS_KEY, SESHI_TEST_S3_SECRET_KEY
 *   SESHI_TEST_AZURE_ENDPOINT, SESHI_TEST_AZURE_ACCOUNT, SESHI_TEST_AZURE_KEY
 *   SESHI_TEST_GCS_BUCKET, written with Application Default Credentials. The workers read it
 *   with SESHI_TEST_GCS_KEY_FILE, a read-only key for SESHI_TEST_GCS_PREFIX in it, when given;
 *   else with GOOGLE_APPLICATION_CREDENTIALS. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBType } from "@duckdb/node-api";
import {
  provideSql,
  SQL_EXAMPLES,
  type SqlCaller,
  SqlService,
  type SqlTables,
  SqlUnavailable,
  sqlSchema,
  sqlViews,
} from "@seshi/search";
import {
  expectExample,
  FIXTURE_NOW,
  FIXTURE_SESSIONS,
  HOSTILE_ADMIN,
  HOSTILE_ALICE,
  visiblePairs,
} from "@seshi/search/sql-testing";
import { FetchAzureBlobClient } from "@seshi/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { typeName } from "./engine";
import { DUCKDB_EXTENSIONS_ENV, SQL_STORAGE_ENV } from "./env";
import { duckdbSql } from "./sql";
import { buildLanceFixture, type LanceFixture, lanceExtensions } from "./testing";

const s3 = {
  endpoint: process.env.SESHI_TEST_S3_ENDPOINT,
  bucket: process.env.SESHI_TEST_S3_BUCKET,
  key: process.env.SESHI_TEST_S3_ACCESS_KEY,
  secret: process.env.SESHI_TEST_S3_SECRET_KEY,
};
const azure = {
  endpoint: process.env.SESHI_TEST_AZURE_ENDPOINT,
  account: process.env.SESHI_TEST_AZURE_ACCOUNT,
  key: process.env.SESHI_TEST_AZURE_KEY,
  container: process.env.SESHI_TEST_AZURE_CONTAINER ?? "seshi-test",
};
// A real bucket only: LanceDB's GCS client cannot use fake-gcs-server (CI's emulator).
const gcsBucket = process.env.SESHI_TEST_GCS_EMULATOR
  ? undefined
  : process.env.SESHI_TEST_GCS_BUCKET;
const gcsKey = process.env.SESHI_TEST_GCS_KEY_FILE;
const gcsPrefix = (process.env.SESHI_TEST_GCS_PREFIX ?? "").replace(/^\/+|\/+$/g, "");

interface Where {
  name: string;
  skip: boolean;
  /** A fresh bucket location, the storage options the fixture is written with, and what the
   * workers' environment holds to read it (the same options, unless `worker` says); none for a
   * folder. */
  bucket?: () => {
    uri: string;
    storageOptions: Record<string, string>;
    worker?: Record<string, string>;
  };
}

const stamp = () => `sql-conformance-${Date.now().toString(36)}`;

const WHERE: Where[] = [
  { name: "a folder", skip: false },
  {
    name: "S3",
    skip: !(s3.endpoint && s3.bucket && s3.key && s3.secret),
    bucket: () => ({
      uri: `s3://${s3.bucket}/${stamp()}`,
      storageOptions: {
        aws_endpoint: s3.endpoint as string,
        aws_access_key_id: s3.key as string,
        aws_secret_access_key: s3.secret as string,
        aws_region: "us-east-1",
        ...(s3.endpoint?.startsWith("http://") ? { allow_http: "true" } : {}),
      },
    }),
  },
  {
    name: "Azure Blob Storage",
    skip: !(azure.endpoint && azure.account && azure.key),
    bucket: () => ({
      uri: `az://${azure.container}/${stamp()}`,
      storageOptions: {
        azure_storage_account_name: azure.account as string,
        azure_storage_account_key: azure.key as string,
        azure_storage_endpoint: azure.endpoint as string,
        ...(azure.endpoint?.startsWith("http://") ? { allow_http: "true" } : {}),
      },
    }),
  },
  {
    name: "Google Cloud Storage",
    skip: gcsBucket === undefined,
    bucket: () => ({
      uri: `gs://${gcsBucket}/${gcsPrefix ? `${gcsPrefix}/` : ""}${stamp()}`,
      storageOptions: {},
      worker: gcsKey
        ? {
            [SQL_STORAGE_ENV]: JSON.stringify({
              google_service_account_key: readFileSync(gcsKey, "utf8"),
            }),
          }
        : {
            [SQL_STORAGE_ENV]: "{}",
            ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
              ? { GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS }
              : {}),
          },
    }),
  },
];

let extensions: string;

beforeAll(async () => {
  extensions = await lanceExtensions();
  provideSql(duckdbSql);
  if (WHERE.find((w) => w.name === "Azure Blob Storage")?.skip === false) {
    await new FetchAzureBlobClient({
      account: azure.account as string,
      container: azure.container,
      endpoint: azure.endpoint as string,
      credentials: { accountKey: azure.key as string },
    }).createContainer();
  }
}, 120_000);

describe.each(WHERE)("sql on a LanceDB index on $name", (where) => {
  let dir: string;
  let fixture: LanceFixture;
  let tables: SqlTables;
  let service: SqlService;
  const caughtUp = new Date(FIXTURE_NOW).toISOString();

  beforeAll(async () => {
    if (where.skip) return;
    dir = mkdtempSync(join(tmpdir(), "seshi-sql-lance-"));
    const bucket = where.bucket?.();
    fixture = await buildLanceFixture(dir, bucket);
    tables = await fixture.tables();
    service = new SqlService({
      search: {
        status: async () => ({
          backend: "lance",
          location: fixture.uri,
          ready: true,
          sessions: 0,
          events: 0,
          generation: "g",
          caught_up_at: caughtUp,
        }),
        sqlTables: async () => tables,
      },
      now: () => new Date(FIXTURE_NOW),
      // What the worker reads the bucket with: only what its environment holds.
      workerEnv: {
        [DUCKDB_EXTENSIONS_ENV]: extensions,
        ...(bucket
          ? (bucket.worker ?? { [SQL_STORAGE_ENV]: JSON.stringify(bucket.storageOptions) })
          : {}),
      },
      settings: { workers: 1, timeout: 30_000 },
    });
  }, 180_000);

  afterAll(async () => {
    await service?.close();
    await fixture?.index.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(where.skip)("serves DuckDB's schema, examples and index", async () => {
    const schema = await service.schema(HOSTILE_ADMIN);
    expect(schema.dialect).toBe("duckdb");
    expect(schema.ddl).toBe(sqlSchema("duckdb"));
    expect(schema.examples).toEqual([...SQL_EXAMPLES.duckdb]);
    expect(schema.hint).toContain("GROUP BY ALL");
    expect(schema.index).toEqual({
      backend: "lance",
      dialect: "duckdb",
      generation: "g",
      updated_at: caughtUp,
    });
  });

  it.skipIf(where.skip)("1. tokens per person and model", async () => {
    await expectExample(service, HOSTILE_ADMIN, "duckdb", 0);
  });

  it.skipIf(where.skip)("2. tools that fail most, by repo", async () => {
    await expectExample(service, HOSTILE_ADMIN, "duckdb", 1);
  });

  it.skipIf(where.skip)("3. sessions with many prompts and few tool calls", async () => {
    await expectExample(service, HOSTILE_ADMIN, "duckdb", 2);
  });

  it.skipIf(where.skip)("answers times as TIMESTAMPTZ in UTC, and labels as JSON", async () => {
    const result = await service.query(HOSTILE_ADMIN, {
      sql: "SELECT started_at, labels, labels ->> '$.team' AS team, models FROM sessions ORDER BY started_at LIMIT 1",
    });
    expect(result.columns.map((c) => c.type)).toEqual([
      "TIMESTAMPTZ",
      "JSON",
      "VARCHAR",
      "VARCHAR[]",
    ]);
    const oldest = FIXTURE_SESSIONS.filter(
      (s) => !s.removed && s.started > FIXTURE_NOW - 30 * 86_400_000,
    )
      .map((s) => s.started)
      .sort((a, b) => a - b)[0] as number;
    expect(Date.parse(String(result.rows[0]?.[0]).replace(" ", "T").replace(/\+00$/, "Z"))).toBe(
      oldest,
    );
    expect(result.rows[0]?.[3]).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });
});

describe("sql on a LanceDB index (a folder)", () => {
  let dir: string;
  let fixture: LanceFixture;
  let tables: SqlTables;
  const services: SqlService[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-sql-lance-scope-"));
    fixture = await buildLanceFixture(dir);
    tables = await fixture.tables();
  }, 120_000);

  afterAll(async () => {
    await Promise.all(services.map((s) => s.close()));
    await fixture?.index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function service(env: Record<string, string> = { [DUCKDB_EXTENSIONS_ENV]: extensions }) {
    const made = new SqlService({
      search: {
        status: async () => ({
          backend: "lance",
          location: fixture.uri,
          ready: true,
          sessions: 0,
          events: 0,
        }),
        sqlTables: () => fixture.tables(),
      },
      now: () => new Date(FIXTURE_NOW),
      workerEnv: env,
      settings: { workers: 1 },
    });
    services.push(made);
    return made;
  }

  it("names exactly the columns DuckDB reports for each view, with the DDL's types", async () => {
    const instance = await DuckDBInstance.create(":memory:", {
      extension_directory: extensions,
      autoload_known_extensions: "false",
    });
    const connection = await instance.connect();
    try {
      await connection.run("LOAD lance");
      for (const view of sqlViews("duckdb", HOSTILE_ADMIN.viewer, { since: 0, until: 1 }, tables)) {
        await connection.run(view);
      }
      const ddl = sqlSchema("duckdb");
      for (const view of ["sessions", "events", "llm_calls"]) {
        const block = ddl.split("\n\n").find((b) => b.includes(`CREATE VIEW ${view} (`)) as string;
        const want = [...block.matchAll(/^ {2}(\w+)\s+([A-Z][A-Z[\]]*),?/gm)].map((m) => [
          m[1],
          m[2],
        ]);
        const reader = await connection.runAndReadAll(`SELECT * FROM ${view} LIMIT 0`);
        const got = reader
          .columnNames()
          .map((name, i) => [name, typeName(reader.columnTypes()[i] as DuckDBType)]);
        expect(got, view).toEqual(want);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  it("gives a member her sessions and the org's, and drops one turned owner-only with its commit", async () => {
    const sql = "SELECT owner, archive_id FROM sessions ORDER BY ALL";
    const window = { since: FIXTURE_NOW - 30 * 86_400_000, until: FIXTURE_NOW };
    const visible = () => [...visiblePairs(HOSTILE_ALICE.viewer, window)].sort();
    const answer = async (caller: SqlCaller, statement = sql) =>
      (await service().query(caller, { sql: statement })).rows.map((r) => `${r[0]}/${r[1]}`);
    expect(await answer(HOSTILE_ALICE)).toEqual(visible());

    // bob's org session goes owner-only: gone from alice's sessions, events and llm_calls at
    // the commit that carries it, still there for an admin.
    const bobs = FIXTURE_SESSIONS[3]?.archive as string;
    await fixture.setVisibility(bobs, "owner");
    try {
      for (const view of ["sessions", "events", "llm_calls"]) {
        const rows = await answer(
          HOSTILE_ALICE,
          `SELECT DISTINCT owner, archive_id FROM ${view} WHERE archive_id = '${bobs}'`,
        );
        expect(rows, view).toEqual([]);
      }
      expect(await answer(HOSTILE_ADMIN)).toContain(`bob/${bobs}`);
    } finally {
      await fixture.setVisibility(bobs, "org");
    }
    expect(await answer(HOSTILE_ALICE)).toContain(`bob/${bobs}`);
  });

  it("answers 501 when the worker cannot load the lance extension", async () => {
    const missing = service({ [DUCKDB_EXTENSIONS_ENV]: join(dir, "no-extensions") });
    await expect(missing.query(HOSTILE_ADMIN, { sql: "SELECT 1" })).rejects.toThrow(SqlUnavailable);
    await expect(missing.query(HOSTILE_ADMIN, { sql: "SELECT 1" })).rejects.toThrow(
      /lance extension could not be loaded/,
    );
  });

  it("refuses the index's own tables, by path, as a CTE and through the scan", async () => {
    for (const sql of [
      `SELECT * FROM '${tables.events}'`,
      `WITH events AS (SELECT * FROM '${tables.events}') SELECT * FROM events`,
      `SELECT * FROM __lance_scan('${tables.sessions}')`,
      `SELECT * FROM '${join(fixture.uri, "meta.lance")}'`,
      `SELECT * FROM '${join(dir, "decoy.lance")}'`,
    ]) {
      await expect(service().query(HOSTILE_ADMIN, { sql }), sql).rejects.toMatchObject({
        code: "sql_refused",
      });
    }
  });

  it("holds no seshi secret in the worker's environment that a statement could read", async () => {
    // getenv is not on the allowlist, and DuckDB's own settings are refused.
    for (const sql of [
      "SELECT getenv('SESHI_SQL_STORAGE')",
      "SELECT current_setting('lance_storage_options')",
      "SELECT * FROM duckdb_secrets()",
      "SELECT * FROM which_secret('gs://b/x', 'lance')",
    ]) {
      await expect(service().query(HOSTILE_ADMIN, { sql }), sql).rejects.toMatchObject({
        code: "sql_refused",
      });
    }
  });
});
