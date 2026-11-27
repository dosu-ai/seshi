/** `seshi sql` (docs/seshi/session-tools.md, phase 3): in-process against a server config, and
 * against a server over HTTP (a local `Bun.serve` of the real routes), with its table, `--json`,
 * `--schema`, refusals pointing at the statement, and the exit codes. Serverless laptops are in
 * `serverless/team.test.ts`. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@seshi/api";
import { loadConfig, serverConfigSchema } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { Instance } from "@seshi/instance";
import type { SqlResult, SqlSchema } from "@seshi/model";
import { StoreSeshi } from "@seshi/pipeline";
import { ensureLayout, FsStore } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT } from "../cli/exit";
import { sqlWorkerCommand } from "../cli/spawn";
import { INTEGRATIONS } from "../integrations";
import { main } from "../main";
import { caret, resultLines } from "./sql";

const formats = new FormatRegistry(BUILTIN_FORMATS);
const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const transcript = (prompt: string) =>
  line({ role: "meta", source: "trajectory" }) +
  // Long enough to be worth a trace.
  line({
    role: "user",
    content: `${prompt}\n${"context ".repeat(260)}`,
    timestamp: "2026-11-01T10:00:00Z",
  }) +
  line({ role: "assistant", content: "done", timestamp: "2026-11-01T10:00:05Z" });

/** A window that holds the sessions above whenever the tests run. */
const WINDOW = ["--since", "2026-06-01", "--until", "2027-06-01"];
const TOKEN = "seshi-sql-test-token-0123456789";

let dir: string;
let home: string;
let bucket: string;
let toml: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "seshi-sql-cmd-"));
  home = join(dir, "home");
  mkdirSync(home);
  bucket = `file://${join(dir, "bucket")}`;
  await ensureLayout(new FsStore(bucket), { createdBy: "test" });
  toml = join(dir, "seshi.toml");
  writeFileSync(
    toml,
    `[store]\nurl = "${bucket}"\n[search]\npath = "${join(dir, "index.sqlite")}"\n`,
    { mode: 0o600 },
  );
  for (const [owner, id] of [
    ["alice", "s1"],
    ["alice", "s2"],
    ["bob", "s3"],
  ] as const) {
    await new StoreSeshi({ store: new FsStore(bucket), owner, formats }).ingest({
      format: "trajectory",
      session_id: id,
      transcript: transcript(`prompt of ${id}`),
    });
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seshi(argv: string[], options: { stdin?: string } = {}) {
  return cli(["sql", ...argv], options);
}

/** Any seshi command, as this machine's user. */
async function cli(argv: string[], options: { stdin?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    env: { HOME: home },
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    integrations: async () => INTEGRATIONS,
    ...(options.stdin !== undefined ? { stdin: async () => options.stdin as string } : {}),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const COUNT = "SELECT owner, count(*) AS n FROM sessions GROUP BY 1 ORDER BY 1";

describe("seshi sql, in-process on the server's host", () => {
  it("builds the index on first use and prints a table", async () => {
    const result = await seshi([COUNT, ...WINDOW, "--config", toml]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.err).toContain("building the search index");
    expect(result.out.split("\n").slice(0, 4)).toEqual([
      "owner │ n",
      "──────┼──",
      "alice │ 2",
      "bob   │ 1",
    ]);
    expect(result.out).toMatch(
      /2 rows · \d+ ms · as local \(local index\) · sessions 2026-06-01 → 2027-06-01/,
    );
  });

  it("answers --json, --schema, and a statement on stdin", async () => {
    const json = JSON.parse(
      (await seshi([COUNT, ...WINDOW, "--config", toml, "--json"])).out,
    ) as SqlResult;
    expect(json.rows).toEqual([
      ["alice", 2],
      ["bob", 1],
    ]);
    const schema = await seshi(["--schema", "--config", toml]);
    expect(schema.out).toContain("CREATE VIEW sessions (");
    expect(schema.out).toContain("SQLite: use datetime('now', '-30 days')");
    expect(
      (JSON.parse((await seshi(["--schema", "--config", toml, "--json"])).out) as SqlSchema)
        .dialect,
    ).toBe("sqlite");
    const piped = await seshi(["-", ...WINDOW, "--config", toml], {
      stdin: "SELECT count(*) FROM events WHERE role = 'user'\n",
    });
    expect(piped.out.split("\n")[2]).toBe("3");
  });

  it("points at what it refused, and cuts at --max-rows", async () => {
    const refused = await seshi(["SELECT owner FROM meta", "--config", toml]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.err.split("\n").slice(-3)).toEqual([
      "seshi: table meta is not allowed: read sessions, events, llm_calls or a CTE",
      "  SELECT owner FROM meta",
      "                    ^",
    ]);
    const unknown = await seshi(["SELECT nope FROM sessions", "--config", toml, "--json"]);
    expect(unknown.code).toBe(EXIT.usage);
    expect(JSON.parse(unknown.err)).toMatchObject({ error: { code: "sql_error" } });
    const cut = await seshi([
      "SELECT * FROM events",
      ...WINDOW,
      "--max-rows",
      "2",
      "--config",
      toml,
    ]);
    expect(cut.out).toContain("truncated at 2 rows: add LIMIT or aggregate");
  });

  it("refuses bad flags and a missing statement", async () => {
    expect((await seshi(["--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["SELECT", "1", "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["SELECT 1", "--schema", "--config", toml])).code).toBe(EXIT.usage);
    expect((await seshi(["SELECT 1", "--max-rows", "many", "--config", toml])).code).toBe(
      EXIT.usage,
    );
    expect((await seshi(["SELECT 1", "--since", "whenever", "--config", toml])).code).toBe(
      EXIT.usage,
    );
    expect((await seshi(["SELECT 1", "--nope"])).code).toBe(EXIT.usage);
    const nothing = await seshi(["SELECT 1"]);
    expect(nothing.code).toBe(EXIT.config);
    expect(nothing.err).toContain("no server or bucket configured");
  });
});

describe("seshi sql, against a server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let instance: Instance;
  let url: string;
  let admin: string;

  beforeEach(async () => {
    const config = loadConfig(serverConfigSchema, {
      env: {
        SESHI_STORE__URL: bucket,
        SESHI_SEARCH__PATH: join(dir, "served.sqlite"),
        SESHI_AUTH__TOKENS__ACME: TOKEN,
      },
    }).config;
    instance = new Instance({
      config,
      store: new FsStore(bucket),
      storage: { url: bucket },
      formats,
      deployment: "test",
      roles: ["api"],
      sqlWorker: sqlWorkerCommand(),
    });
    admin = (await instance.auth.initAdmin({ owner: "ops" })).admin?.token as string;
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(instance).fetch });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    server.stop(true);
    await instance.close();
  });

  it("asks the server with an admin's token, through seshi sql-worker", async () => {
    const building = await seshi([COUNT, "--server", url, "--token", admin]);
    expect(building.code).toBe(EXIT.unavailable);
    await instance.search?.catchUp();
    const result = await seshi([COUNT, ...WINDOW, "--server", url, "--token", admin]);
    expect(result.code).toBe(EXIT.ok);
    expect(result.out).toContain("alice │ 2");
    expect(result.out).toContain("as ops (admin)");
    const refused = await seshi(["SELECT * FROM main.events", "--server", url, "--token", admin]);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.err).toContain("               ^");
  });

  it("maps the server's refusals to exit codes", async () => {
    await instance.search?.catchUp();
    // A static token is a member's: no sql scope.
    const member = await seshi([COUNT, "--server", url, "--token", TOKEN]);
    expect(member.code).toBe(EXIT.auth);
    expect(member.err).toContain("sql scope");
    expect((await seshi([COUNT, "--server", url])).code).toBe(EXIT.auth);
    const gone = await seshi([COUNT, "--server", "http://127.0.0.1:1", "--token", admin]);
    expect(gone.code).toBe(EXIT.unavailable);
  });
  it("reports the server's sql workers: in its job status, seshi search --status and seshi doctor", async () => {
    const login = await cli(["login", "--server", url, "--token", "-"], { stdin: admin });
    expect(login.code, login.err).toBe(EXIT.ok);
    const jobs = async () =>
      JSON.parse((await cli(["workers", "status", "--server", url, "--json"])).out);
    // Before its first statement the server has started none.
    expect((await jobs()).sql).toBeNull();
    expect((await cli(["workers", "status", "--server", url])).out).toContain(
      `sql workers (${instance.process}): none started yet`,
    );

    await instance.search?.catchUp();
    expect((await seshi([COUNT, "--server", url])).code).toBe(EXIT.ok);
    const pool = { workers: 2, busy: 0, queued: 0, restarts: 0 };
    expect((await jobs()).sql).toEqual(pool);
    expect((await cli(["workers", "status", "--server", url])).out).toContain(
      `sql workers (${instance.process}): 2 started, 0 busy, 0 queued, 0 restarted`,
    );

    // On the server's host, --server asks the running server rather than this process.
    const status = await cli(["search", "--status", "--config", toml, "--server", url, "--json"]);
    expect(status.code, status.err).toBe(EXIT.ok);
    expect(JSON.parse(status.out).sql).toEqual({ engine: "sqlite", server: url, workers: pool });
    const text = await cli(["search", "--status", "--config", toml, "--server", url]);
    expect(text.out).toContain(`sql workers on ${url}: 2 started, 0 busy, 0 queued, 0 restarted`);
    const doctor = await cli(["doctor", "--config", toml, "--server", url, "--json"]);
    expect(doctor.code, doctor.err).toBe(EXIT.ok);
    expect(JSON.parse(doctor.out).server).toContainEqual(
      expect.objectContaining({
        id: "sql-server-workers",
        status: "ok",
        summary: `${url}: 2 started, 0 busy, 0 queued, 0 restarted`,
      }),
    );

    // A member's token may not read job status: said, not failed.
    const member = await cli([
      "search",
      "--status",
      "--config",
      toml,
      "--server",
      url,
      "--token",
      TOKEN,
      "--json",
    ]);
    expect(member.code, member.err).toBe(EXIT.ok);
    expect(JSON.parse(member.out).sql).toMatchObject({
      server: url,
      workers_error: expect.any(String),
    });
  }, 60_000);
});

describe("the command's pieces", () => {
  const result: SqlResult = {
    now: "2026-11-25T12:00:00.000Z",
    scope: {
      as: "ops",
      role: "admin",
      since: "2026-10-26T12:00:00.000Z",
      until: "2026-11-25T12:00:00.000Z",
    },
    index: { backend: "sqlite", dialect: "sqlite" },
    columns: [
      { name: "text", type: "TEXT" },
      { name: "n", type: "INTEGER" },
    ],
    rows: [
      ["a\u001b[31m red\nline", null],
      ["x".repeat(100), 2],
    ],
    truncated: true,
    elapsed_ms: 7,
  };

  it("prints NULL, cuts long cells, and strips control characters", () => {
    const lines = resultLines(result);
    expect(lines[2]).toBe(`${"a\uFFFD[31m red line".padEnd(60)} │ NULL`);
    expect(lines[3]).toBe(`${"x".repeat(59)}… │ 2`);
    expect(lines[4]).toBe(
      "truncated at 2 rows: add LIMIT or aggregate · 7 ms · as ops (admin) · sessions 2026-10-26 → 2026-11-25",
    );
  });

  it("puts a caret under the character a refusal names, on its line", () => {
    expect(caret("SELECT 1\nFROM meta", 14)).toEqual(["  FROM meta", "       ^"]);
  });
});
