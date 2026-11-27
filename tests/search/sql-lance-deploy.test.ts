/** `sql` on a LanceDB index as a `-sql` server deploys it (docs/seshi/session-tools.md, phase
 * 4): the worker (main-server.ts, in its own process) writes the index to the bucket, and an API
 * instance with DuckDB (`provideSql`, as main-server-sql.ts gives it) answers `POST /v1/sql`
 * and `GET /v1/sql/schema` from its own `sql` workers, which hold only `[search.sql.storage]`.
 * Admins and service tokens given the `sql` scope get answers; members are refused. On a folder
 * in every run, and on S3 and Azure where `SESHI_TEST_*` names one (CI's rustfs and Azurite). */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "@seshi/api";
import { HttpSeshi, ServerError } from "@seshi/client";
import { loadServerConfig } from "@seshi/config";
import { buildInstance, type Instance } from "@seshi/instance";
import { lanceIndex } from "@seshi/lance";
import type { SqlResult } from "@seshi/model";
import { provideLance } from "@seshi/search";
import { duckdbSql, provideSql } from "@seshi/sql";
import { lanceExtensions } from "@seshi/sql/testing";
import { FetchAzureBlobClient } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

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

const unique = () =>
  `sql-deploy-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Variant {
  name: string;
  skip: boolean;
  store(dir: string): string;
  /** `[search.sql.storage]`: the workers' own credential, or a wrong one. */
  storage?(right: boolean): string;
}

const VARIANTS: Variant[] = [
  {
    name: "a folder",
    skip: false,
    store: (dir) => `[store]\nurl = "file://${join(dir, "bucket")}"\n`,
  },
  {
    name: "S3",
    skip: !(s3.endpoint && s3.bucket && s3.key && s3.secret),
    store: () =>
      [
        "[store]",
        `url = "s3://${s3.bucket}/${unique()}"`,
        `endpoint = "${s3.endpoint}"`,
        'region = "us-east-1"',
        `credentials = { access_key_id = "${s3.key}", secret_access_key = "${s3.secret}" }`,
        "",
      ].join("\n"),
    storage: (right) =>
      `access_key_id = "${right ? s3.key : "nobody"}"\nsecret_access_key = "${right ? s3.secret : "wrong"}"\n`,
  },
  {
    name: "Azure Blob Storage",
    skip: !(azure.endpoint && azure.account && azure.key),
    store: () =>
      [
        "[store]",
        `url = "az://${azure.container}/${unique()}"`,
        `account_name = "${azure.account}"`,
        `endpoint = "${azure.endpoint}"`,
        `credentials = { account_key = "${azure.key}" }`,
        "",
      ].join("\n"),
    storage: (right) =>
      `account_key = "${right ? azure.key : Buffer.from("wrong key").toString("base64")}"\n`,
  },
];

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
function log(prompt: string): string {
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: `${prompt} ${"context ".repeat(260)}`, timestamp: ts }) +
    line({ role: "assistant", content: "on it", timestamp: ts })
  );
}

async function until<T>(read: () => Promise<T | undefined>, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    }
    await Bun.sleep(200);
  }
}

provideLance(lanceIndex);
provideSql(duckdbSql);

describe.each(VARIANTS)("sql on a LanceDB index served from $name", (variant) => {
  let dir: string;
  let env: Record<string, string>;
  let extensions: string;
  let worker: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let workerLog = "";
  const apis: Instance[] = [];
  let as: (api: Instance, token: string, user?: string) => HttpSeshi;
  let orgKey: string;
  let adminToken: string;
  let api: Instance;

  function config(storage?: string): string {
    return [
      variant.store(dir),
      "[search]",
      'backend = "lance"',
      'interval = "200ms"',
      "",
      "[search.lance]",
      'read_consistency = "0s"',
      "",
      "[search.sql]",
      // Where the API's sql workers find DuckDB's lance extension (beside the binary in the
      // -sql image).
      `extensions = "${extensions}"`,
      "",
      ...(storage ? ["[search.sql.storage]", storage] : []),
      "[worker]",
      'heartbeat_interval = "1s"',
      "",
    ].join("\n");
  }

  async function instance(text: string): Promise<Instance> {
    const path = join(dir, `seshi-${apis.length}.toml`);
    writeFileSync(path, text, { mode: 0o600 });
    const made = await buildInstance(loadServerConfig({ configFlag: path, env }).config, {
      formats: buildFormats(),
      roles: ["api"],
      id: `api-${apis.length}`,
      env,
    });
    apis.push(made);
    return made;
  }

  beforeAll(async () => {
    if (variant.skip) return;
    dir = mkdtempSync(join(tmpdir(), "seshi-sql-deploy-"));
    env = {
      HOME: dir,
      PATH: process.env.PATH ?? "",
    };
    extensions = await lanceExtensions();
    if (variant.name === "Azure Blob Storage") {
      await new FetchAzureBlobClient({
        account: azure.account as string,
        container: azure.container,
        endpoint: azure.endpoint as string,
        credentials: { accountKey: azure.key as string },
      }).createContainer();
    }
    const text = config(variant.storage?.(true));
    api = await instance(text);
    const apps = new Map<Instance, ReturnType<typeof createApp>>();
    as = (on, token, user) => {
      let app = apps.get(on);
      if (!app) {
        app = createApp(on);
        apps.set(on, app);
      }
      const served = app;
      return new HttpSeshi({
        server: "http://seshi.test",
        token,
        ...(user ? { user } : {}),
        fetch: (url, init) => served.fetch(new Request(url, init)),
      });
    };
    const init = await api.auth.initAdmin({ owner: "ops" });
    orgKey = init.org_key?.token as string;
    adminToken = init.admin?.token as string;

    const workerConfig = join(dir, "worker.toml");
    writeFileSync(workerConfig, text, { mode: 0o600 });
    worker = Bun.spawn(
      [
        process.execPath,
        "run",
        join(ROOT, "apps/seshi/src/main-server.ts"),
        "serve",
        "--config",
        workerConfig,
        "--roles",
        "worker",
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    for (const stream of [worker.stdout, worker.stderr]) {
      void (async () => {
        for await (const chunk of stream) workerLog += new TextDecoder().decode(chunk);
      })();
    }
    await as(api, orgKey, "alice").ingest({
      format: "trajectory",
      session_id: "pay",
      transcript: log("deploy the payments service"),
    });
    await as(api, orgKey, "bob").ingest({
      format: "trajectory",
      session_id: "docs",
      transcript: log("deploy the docs site"),
    });
  }, 120_000);

  afterAll(async () => {
    if (variant.skip) return;
    worker?.kill();
    await worker?.exited;
    for (const made of apis) await made.close(1000);
    rmSync(dir, { recursive: true, force: true });
  });

  let lastSql = "";
  async function sql(client: HttpSeshi, statement: string): Promise<SqlResult | undefined> {
    try {
      return await client.sql({ sql: statement });
    } catch (err) {
      // 503 while the worker builds the first generation.
      if (err instanceof ServerError && err.status === 503) {
        lastSql = err.message;
        return undefined;
      }
      throw err;
    }
  }

  it.skipIf(variant.skip)(
    "answers an admin and a service token with the sql scope from the worker's index",
    async () => {
      const admin = as(api, adminToken);
      const sessions = await until(async () => {
        const r = await sql(admin, "SELECT owner, agent FROM sessions ORDER BY owner");
        return r && r.rows.length === 2 ? r : undefined;
      }, "the worker to index both sessions").catch((err) => {
        throw new Error(`${(err as Error).message} (${lastSql})\nworker:\n${workerLog}`);
      });
      expect(sessions.rows).toEqual([
        ["alice", "trajectory"],
        ["bob", "trajectory"],
      ]);
      expect(sessions.index).toMatchObject({ backend: "lance", dialect: "duckdb" });
      expect(sessions.scope).toMatchObject({ as: "ops", role: "admin" });

      const prompts = await admin.sql({
        sql: "SELECT e.owner, left(e.text, 27) FROM events e WHERE e.role = 'user' ORDER BY e.owner",
      });
      expect(prompts.rows).toEqual([
        ["alice", "deploy the payments service"],
        ["bob", "deploy the docs site contex"],
      ]);

      const schema = await admin.sqlSchema();
      expect(schema.dialect).toBe("duckdb");
      expect(schema.ddl).toContain("TIMESTAMPTZ");

      const service = await api.auth.issue(
        { kind: "service", service: "reports", scopes: ["sql"] },
        await api.auth.authenticate(adminToken),
      );
      const counted = await as(api, service.token).sql({
        sql: "SELECT count(*) AS n FROM sessions",
      });
      expect(counted.rows).toEqual([[2]]);
      expect(counted.scope.role).toBe("service");

      await expect(
        admin.sql({ sql: "SELECT * FROM read_text('/etc/passwd')" }),
      ).rejects.toMatchObject({
        status: 400,
        code: "sql_refused",
      });
    },
    120_000,
  );

  it.skipIf(variant.skip)("refuses a member: sql is for admins and service tokens", async () => {
    const member = as(api, orgKey, "alice");
    await expect(member.sql({ sql: "SELECT count(*) FROM sessions" })).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("needs the sql scope"),
    });
    await expect(member.sqlSchema()).rejects.toMatchObject({ code: "forbidden" });
  });

  it.skipIf(variant.skip || variant.storage === undefined)(
    "reads the bucket with [search.sql.storage] only: a wrong key there reads nothing",
    async () => {
      await until(async () => {
        const r = await sql(as(api, adminToken), "SELECT count(*) FROM sessions");
        return r?.rows[0]?.[0] === 2 ? r : undefined;
      }, "the index");
      const wrong = await instance(config(variant.storage?.(false)));
      const answer = as(wrong, adminToken).sql({ sql: "SELECT count(*) FROM sessions" });
      await expect(answer).rejects.toBeInstanceOf(ServerError);
      await expect(answer).rejects.not.toMatchObject({ code: "sql_refused" });
    },
    120_000,
  );
});
