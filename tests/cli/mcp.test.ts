/** `seshi mcp` over the protocol (docs/seshi/session-tools.md, "Testing it end to end", 2): a
 * real `seshi serve` on a folder store, with a SQLite index and again with a LanceDB one (the
 * server build's entry), `seshi mcp --token …` spawned as a child, and the SDK's own `Client`
 * driving it over stdio: `initialize`, `tools/list`, each tool with good and bad arguments, a
 * member and an admin, and a server that is down. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { HttpSeshi } from "@seshi/client";
import { loadServerConfig } from "@seshi/config";
import { buildInstance } from "@seshi/instance";
import { lanceIndex } from "@seshi/lance";
import { provideLance } from "@seshi/search";
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
}

const VARIANTS: Variant[] = [
  { name: "SQLite", entry: "apps/seshi/src/main.ts", search: "" },
  {
    name: "LanceDB on a folder",
    entry: "apps/seshi/src/main-server.ts",
    search: 'backend = "lance"\n\n[search.lance]\nread_consistency = "0s"\n',
  },
];

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
    const configPath = join(dir, "seshi.toml");
    writeFileSync(
      configPath,
      [
        `[store]\nurl = "file://${join(dir, "bucket")}"\n`,
        "[search]",
        `path = "${join(dir, "index.sqlite")}"`,
        'interval = "200ms"',
        variant.search,
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

    // Search, then read around the hit: the match names its trace and event.
    const found = textOf(
      await alice.callTool({ name: "search", arguments: { query: "scrub", since: "7d" } }),
    );
    const session = /^(alice\/[0-9a-f]{64}) · trajectory\/lance-scrub/m.exec(found)?.[1];
    const hit = /#(\d+)@([0-9a-f]{8}) user|#(\d+)@([0-9a-f]{8}) assistant/.exec(found);
    expect(session).toBeDefined();
    expect(hit).not.toBeNull();
    const [index, trace] = hit?.[1] !== undefined ? [hit[1], hit[2]] : [hit?.[3], hit?.[4]];
    const read = textOf(
      await alice.callTool({
        name: "read_session",
        arguments: { session, trace, around: Number(index), context: 2 },
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
  });

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
