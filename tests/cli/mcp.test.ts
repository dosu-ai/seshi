/** `seshi mcp` over the protocol (docs/seshi/session-tools.md, "Testing it end to end", 2): a
 * real `seshi serve` on a folder store, with a SQLite index and again with a LanceDB one (the
 * server build's entry), `seshi mcp --token …` spawned as a child, and the SDK's own `Client`
 * driving it over stdio: `initialize`, `tools/list`, each tool with good and bad arguments, a
 * member and an admin, and a server that is down. `sql` runs on SQLite, on LanceDB through the
 * `-sql` build's DuckDB, and on a serverless laptop over its own index; the LanceDB server
 * without DuckDB does not list it. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HttpSeshi } from "@seshi/client";
import { loadServerConfig } from "@seshi/config";
import { BUILTIN_FORMATS, FormatRegistry } from "@seshi/formats";
import { buildInstance } from "@seshi/instance";
import { lanceIndex } from "@seshi/lance";
import { StoreSeshi } from "@seshi/pipeline";
import { provideLance } from "@seshi/search";
import { lanceExtensions } from "@seshi/sql/testing";
import { FsStore } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

provideLance(lanceIndex);

const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A session: a prompt, a failing test run and an answer. */
function log(prompt: string, failure: string, when: string): string {
  return (
    line({ role: "meta", source: "trajectory" }) +
    line({ role: "user", content: prompt, timestamp: when }) +
    line({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", name: "Bash", args: '{"command":"bun test"}' }],
      timestamp: when,
    }) +
    line({ role: "tool", tool_call_id: "c1", content: failure, ok: false, timestamp: when }) +
    line({
      role: "assistant",
      content: `the run failed: ${failure.slice(0, 40)}`,
      timestamp: when,
    }) +
    // Long enough that the server's filter keeps it (min_chars).
    line({ role: "user", content: `fix it ${"context ".repeat(260)}`, timestamp: when }) +
    line({ role: "assistant", content: "fixed", timestamp: when })
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
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(last ?? "")}`);
    await Bun.sleep(200);
  }
}

const textOf = (r: unknown) =>
  ((r as { content: { type: string; text: string }[] }).content ?? []).map((c) => c.text).join("");

interface Variant {
  name: string;
  entry: string;
  search: string;
  /** The dialect its `sql` answers in, or none: a LanceDB server without DuckDB. */
  sql?: "SQLite" | "DuckDB";
}

const LANCE = 'backend = "lance"\n\n[search.lance]\nread_consistency = "0s"\n';

const VARIANTS: Variant[] = [
  { name: "SQLite", entry: "apps/seshi/src/main.ts", search: "", sql: "SQLite" },
  { name: "LanceDB on a folder", entry: "apps/seshi/src/main-server.ts", search: LANCE },
  {
    name: "LanceDB on a folder, the -sql build",
    entry: "apps/seshi/src/main-server-sql.ts",
    search: LANCE,
    sql: "DuckDB",
  },
];

/** The sessions per owner, as the `sql` tool's pipe table gives them. */
const COUNT = "SELECT owner, count(*) AS n FROM sessions GROUP BY owner ORDER BY owner";

describe.each(VARIANTS)("seshi mcp against seshi serve, $name", (variant) => {
  let dir: string;
  let env: Record<string, string>;
  let server: Bun.Subprocess<"ignore", "pipe", "pipe">;
  let serverLog = "";
  let url: string;
  let orgKey: string;
  let adminToken: string;
  const clients: Client[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-mcp-"));
    // The -sql build's workers load DuckDB's lance extension from here (downloaded once).
    const extensions =
      variant.sql === "DuckDB" ? `[search.sql]\nextensions = "${await lanceExtensions()}"\n` : "";
    const configPath = join(dir, "seshi.toml");
    writeFileSync(
      configPath,
      [
        `[store]\nurl = "file://${join(dir, "bucket")}"\n`,
        "[search]",
        `path = "${join(dir, "index.sqlite")}"`,
        'interval = "200ms"',
        variant.search,
        extensions,
        "[worker]",
        'heartbeat_interval = "1s"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    env = { HOME: dir, PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config") };
    // The admin and the org key, written to the bucket before the server starts.
    const setup = await buildInstance(loadServerConfig({ configFlag: configPath, env }).config, {
      formats: buildFormats(),
      roles: [],
      id: "setup",
      env,
    });
    const init = await setup.auth.initAdmin({ owner: "ops" });
    orgKey = init.org_key?.token as string;
    adminToken = init.admin?.token as string;
    await setup.close();

    server = Bun.spawn(
      [
        process.execPath,
        "run",
        join(ROOT, variant.entry),
        "serve",
        "--config",
        configPath,
        "--listen",
        "127.0.0.1:0",
      ],
      { cwd: dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    for (const stream of [server.stdout, server.stderr]) {
      void (async () => {
        for await (const chunk of stream) serverLog += new TextDecoder().decode(chunk);
      })();
    }
    url = await until(
      async () => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(serverLog)?.[1],
      "the server to listen",
    );
    const as = (user: string) => new HttpSeshi({ server: url, token: orgKey, user });
    await as("alice").ingest({
      format: "trajectory",
      session_id: "lance-scrub",
      transcript: log(
        "run the search tests",
        `FAIL src/lance.test.ts > scrub keeps deleted rows ${"trace ".repeat(500)}`,
        recent(30),
      ),
      repo: "github.com/acme/seshi",
      branch: "main",
    });
    await as("alice").ingest({
      format: "trajectory",
      session_id: "private",
      transcript: log("my own notes", "FAIL nothing to see", recent(20)),
      visibility: "owner",
    });
    await as("bob").ingest({
      format: "trajectory",
      session_id: "docs",
      transcript: log("write the docs", "FAIL docs build broke", recent(10)),
      repo: "github.com/acme/docs",
    });
    await until(async () => {
      const list = await new HttpSeshi({ server: url, token: adminToken }).searchSessions();
      if (list.sessions.length !== 3) {
        throw new Error(`listed ${list.sessions.map((x) => x.session_id).join(", ")}`);
      }
      return list;
    }, "the index to hold the sessions").catch((err) => {
      throw new Error(`${(err as Error).message}\nserver:\n${serverLog}`);
    });
  }, 240_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    server?.kill();
    await server?.exited;
    rmSync(dir, { recursive: true, force: true });
  });

  async function mcp(args: string[], extraEnv: Record<string, string> = {}): Promise<Client> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(ROOT, "apps/seshi/src/main.ts"), "mcp", ...args],
      env: { ...env, ...extraEnv },
      cwd: dir,
      // Inherited, not piped: a pipe nobody reads would block the child once full.
      stderr: "inherit",
    });
    const client = new Client({ name: "seshi-test", version: "0" });
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it("lists its tools, then lists, searches and reads as a member", async () => {
    const alice = await mcp(["--server", url, "--token", orgKey, "--user", "alice"]);
    expect(alice.getServerVersion()?.name).toBe("seshi");
    const { tools } = await alice.listTools();
    // A member has no sql scope: sql is not listed.
    expect(tools.map((t) => t.name)).toEqual(["list_sessions", "read_session", "search"]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

    const listed = textOf(await alice.callTool({ name: "list_sessions", arguments: {} }));
    const lines = listed.split("\n");
    expect(lines[0]).toMatch(
      /^now \d{4}-\d\d-\d\dT[\d:]+Z · as alice \(member: own \+ org\) · window /,
    );
    expect(lines.slice(1, -1).map((l) => l.split(" · ")[1])).toEqual([
      "trajectory/docs",
      "trajectory/private",
      "trajectory/lance-scrub",
    ]);
    expect(lines.at(-1)).toBe("end");
    expect(
      textOf(await alice.callTool({ name: "list_sessions", arguments: { repo: "acme/docs" } })),
    ).toContain("trajectory/docs");

    // Search, then read around the hit: the match gives its seq.
    const found = textOf(
      await alice.callTool({ name: "search", arguments: { query: "scrub", since: "7d" } }),
    );
    const session = /^(alice\/[0-9a-f]{64}) · trajectory\/lance-scrub/m.exec(found)?.[1];
    const seq = /^ {2}#(\d+) (?:user|assistant|tool_result)/m.exec(found)?.[1];
    expect(session).toBeDefined();
    expect(seq).toBeDefined();
    const read = textOf(
      await alice.callTool({
        name: "read_session",
        arguments: { session, around: Number(seq), context: 2 },
      }),
    );
    const readLines = read.split("\n");
    expect(readLines[1]).toBe(
      `session ${session} · trajectory/lance-scrub · github.com/acme/seshi@main · ${readLines[1]?.split(" · ")[3]}`,
    );
    expect(read).toMatch(/^#2 tool_result Bash ok=0 \S+ {2}FAIL src\/lance\.test\.ts > scrub/m);
    expect(read).toMatch(/\[\+[\d,]+ chars\]/);
    expect(readLines.at(-1)).toMatch(/^(next: \d+|end)$/);

    // The whole tool result, a piece at a time.
    const piece = textOf(
      await alice.callTool({
        name: "read_session",
        arguments: { session: "trajectory/lance-scrub", event: 2, max_chars: 1000 },
      }),
    );
    expect(piece).toMatch(/next_offset: 1000/);
  });

  it("answers bad arguments and refusals as errors, and shows a member no one else's private session", async () => {
    const bob = await mcp(["--server", url, "--token", orgKey, "--user", "bob"]);
    const listed = textOf(await bob.callTool({ name: "list_sessions", arguments: {} }));
    expect(listed).not.toContain("trajectory/private");
    const refused = await bob.callTool({
      name: "read_session",
      arguments: { session: "trajectory/private" },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("error not_found (HTTP 404)");
    const bad = await bob.callTool({
      name: "read_session",
      arguments: { session: "x/y", from: -1 },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("from must be at least 0");
    const badQuery = await bob.callTool({ name: "search", arguments: { query: '"' } });
    expect(badQuery.isError).toBe(true);
    const sql = await bob.callTool({ name: "sql", arguments: { sql: COUNT } });
    expect(sql.isError).toBe(true);
    expect(textOf(sql)).toContain(
      "error sql_unavailable: sql is not available: this credential has no sql scope",
    );
  });

  it.runIf(variant.sql !== undefined)(
    "lists sql for an admin, described from the server's schema, and answers it",
    async () => {
      const admin = await mcp(["--server", url, "--token", adminToken]);
      const { tools } = await admin.listTools();
      expect(tools.map((t) => t.name)).toEqual(["list_sessions", "read_session", "search", "sql"]);
      const description = tools.find((t) => t.name === "sql")?.description ?? "";
      const schema = await new HttpSeshi({ server: url, token: adminToken }).sqlSchema();
      // The DDL the server serves, in its dialect, so it cannot drift from the views.
      expect(description.startsWith(`Write ${variant.sql}:`)).toBe(true);
      expect(description).toContain(schema.ddl);
      for (const example of schema.examples) expect(description).toContain(example);
      expect(description).toContain("the views hold every session in the store");

      const counted = await admin.callTool({ name: "sql", arguments: { sql: COUNT, since: "7d" } });
      expect(counted.isError).toBeFalsy();
      expect(textOf(counted).split("\n")).toEqual([
        expect.stringMatching(
          new RegExp(
            `^now \\S+ · as ops \\(admin: every session\\) · ${variant.sql === "SQLite" ? "sqlite index, sqlite" : "lance index, duckdb"} · window `,
          ),
        ),
        "| owner | n |",
        "| --- | --- |",
        "| alice | 2 |",
        "| bob | 1 |",
        expect.stringMatching(/^2 rows · \d+ ms$/),
      ]);
      expect(counted.structuredContent).toMatchObject({
        rows: [
          ["alice", 2],
          ["bob", 1],
        ],
        truncated: false,
      });

      // From a row of events to the session around it: seq is read_session's around.
      const failed = textOf(
        await admin.callTool({
          name: "sql",
          arguments: {
            sql: "SELECT s.owner || '/' || s.archive_id AS session, e.seq FROM events e JOIN sessions s USING (owner, archive_id) WHERE s.session_id = 'lance-scrub' AND e.role = 'tool_result'",
          },
        }),
      );
      const row = /^\| (alice\/[0-9a-f]{64}) \| (\d+) \|$/m.exec(failed);
      expect(row).not.toBeNull();
      const around = textOf(
        await admin.callTool({
          name: "read_session",
          arguments: { session: row?.[1], around: Number(row?.[2]), context: 0 },
        }),
      );
      expect(around).toMatch(
        new RegExp(`^#${row?.[2]} tool_result Bash ok=0 .*FAIL src/lance`, "m"),
      );

      // A refused statement says where, so the agent can correct it.
      const statement = "SELECT *\nFROM read_csv('/etc/passwd')";
      const refused = await admin.callTool({ name: "sql", arguments: { sql: statement } });
      expect(refused.isError).toBe(true);
      const lines = textOf(refused).split("\n");
      expect(lines[1]).toMatch(/^error sql_refused \(HTTP 400\): /);
      expect(lines.slice(-2)[0]).toBe("  FROM read_csv('/etc/passwd')");
      const unknown = await admin.callTool({
        name: "sql",
        arguments: { sql: "SELECT nope FROM sessions" },
      });
      expect(unknown.isError).toBe(true);
      expect(textOf(unknown)).toMatch(/error sql_(error|refused) \(HTTP 400\)/);
      const cut = await admin.callTool({
        name: "sql",
        arguments: { sql: "SELECT owner FROM sessions", max_rows: 1 },
      });
      expect(textOf(cut)).toMatch(/^truncated at 1 row: add LIMIT or aggregate · \d+ ms$/m);
    },
    120_000,
  );

  it.runIf(variant.sql === undefined)(
    "does not list sql where the server cannot run it, and says why",
    async () => {
      const admin = await mcp(["--server", url, "--token", adminToken]);
      expect((await admin.listTools()).tools.map((t) => t.name)).toEqual([
        "list_sessions",
        "read_session",
        "search",
      ]);
      const result = await admin.callTool({ name: "sql", arguments: { sql: COUNT } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/error sql_unavailable: sql is not available: .*-sql/);
    },
  );

  it("sees every session as an admin, through SESHI_TOKEN", async () => {
    const admin = await mcp(["--server", url, "--tools", "list_sessions"], {
      SESHI_TOKEN: adminToken,
    });
    expect((await admin.listTools()).tools.map((t) => t.name)).toEqual(["list_sessions"]);
    const listed = textOf(await admin.callTool({ name: "list_sessions", arguments: {} }));
    expect(listed).toMatch(/as ops \(admin: every session\)/);
    expect(listed).toContain("trajectory/private");
  });

  it("starts with the server down, and answers each call with the error", async () => {
    const down = await mcp(["--server", "http://127.0.0.1:9", "--token", orgKey, "--user", "x"]);
    expect((await down.listTools()).tools).toHaveLength(3);
    const result = await down.callTool({ name: "list_sessions", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/error unavailable: cannot reach http:\/\/127\.0\.0\.1:9/);
  });
});

describe("seshi mcp on a serverless laptop", () => {
  let dir: string;
  let env: Record<string, string>;
  const clients: Client[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "seshi-mcp-laptop-"));
    env = { HOME: dir, PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: join(dir, "config") };
    const url = `file://${join(dir, "bucket")}`;
    const init = Bun.spawnSync(
      [
        process.execPath,
        "run",
        join(ROOT, "apps/seshi/src/main.ts"),
        "init",
        "--serverless",
        "--url",
        url,
        "--owner",
        "alice",
      ],
      { cwd: dir, env, stdout: "pipe", stderr: "pipe" },
    );
    expect(init.exitCode, init.stderr.toString()).toBe(0);
    const formats = new FormatRegistry(BUILTIN_FORMATS);
    for (const [owner, id, when] of [
      ["alice", "lance-scrub", recent(30)],
      ["bob", "docs", recent(10)],
    ] as const) {
      await new StoreSeshi({ store: new FsStore(url), owner, formats }).ingest({
        format: "trajectory",
        session_id: id,
        transcript: log(`work on ${id}`, `FAIL ${id} broke`, when),
      });
    }
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists sql over the laptop's own index, in SQLite, and answers it", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", join(ROOT, "apps/seshi/src/main.ts"), "mcp"],
      env,
      cwd: dir,
      stderr: "inherit",
    });
    const client = new Client({ name: "seshi-test", version: "0" });
    await client.connect(transport);
    clients.push(client);
    const { tools } = await client.listTools();
    const sql = tools.find((t) => t.name === "sql");
    expect(tools.map((t) => t.name)).toContain("sql");
    expect(sql?.description?.startsWith("Write SQLite:")).toBe(true);
    expect(sql?.description).toContain("this machine's own search index");
    const counted = textOf(await client.callTool({ name: "sql", arguments: { sql: COUNT } }));
    expect(counted.split("\n")).toEqual([
      expect.stringMatching(
        /^now \S+ · as alice \(this machine's index: own \+ org\) · sqlite index, sqlite · window /,
      ),
      "| owner | n |",
      "| --- | --- |",
      "| alice | 1 |",
      "| bob | 1 |",
      expect.stringMatching(/^2 rows · \d+ ms$/),
    ]);
  }, 120_000);
});
