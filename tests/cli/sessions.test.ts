/** `seshi sessions` and `seshi tokens` (F8.1, F8.3) against a seshi server on 127.0.0.1 with
 * the credential `seshi login` stored, and in local mode against a folder bucket; and the
 * remote `workers status` and `sync status|failed|dropped` (06's open item). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpSessionDB } from "@seshi/client";
import { writeDropped, writeFailed } from "@seshi/store";
import { connect } from "seshi/connect";
import { INTEGRATIONS } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = `${SMALL.trim()}\n${JSON.stringify({
  type: "assistant",
  uuid: "a3",
  timestamp: "2026-09-01T00:00:08.000Z",
  sessionId: "sess1",
  message: {
    role: "assistant",
    model: "claude-x",
    content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
  },
})}\n`;

const TOKEN = "static-token-for-acme-0123456789";

let server: TestServer;
let machine: Machine;
let admin: string;

beforeEach(async () => {
  server = await startServer({ settings: { staticTokens: [{ token: TOKEN, owner: "acme" }] } });
  admin = (await server.auth.initAdmin({ owner: "ops" })).admin?.token as string;
  machine = new Machine();
  const db = new HttpSessionDB({ server: server.url, token: TOKEN });
  await db.ingest({
    agent: "claude-code",
    session_id: "sess1",
    transcript: CLAUDE,
    project: "github.com/acme/widget",
    branch: "main",
  });
  await db.ingest({ agent: "claude-code", session_id: "sess2", transcript: CLAUDE });
  const login = await machine.seshi(["login", "--server", server.url, "--token", "-"], {
    stdin: TOKEN,
  });
  expect(login.code, login.err).toBe(0);
});

afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

describe("seshi sessions against a server", () => {
  it("lists, as lines or one JSON document, and pages", async () => {
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.out).toContain("acme: 2 session(s), newest first");
    expect(ls.out).toMatch(
      /claude-code\/sess1 +\d{4}-\d\d-\d\d \d\d:\d\d +\d+ records +org +github.com\/acme\/widget \(main\)/,
    );
    // Not a terminal: no colour codes.
    expect(ls.out).not.toContain("\x1b[");
    const json = JSON.parse((await machine.seshi(["sessions", "ls", "--json"])).out);
    expect(json.sessions.map((s: { session_id: string }) => s.session_id).sort()).toEqual([
      "sess1",
      "sess2",
    ]);
    const page = await machine.seshi(["sessions", "ls", "--limit", "1"]);
    expect(page.out).toMatch(/… more: seshi sessions ls --after \S+/);
    const all = JSON.parse(
      (await machine.seshi(["sessions", "ls", "--limit", "1", "--all", "--json"])).out,
    );
    expect(all).toMatchObject({ truncated: false });
    expect(all.sessions).toHaveLength(2);
    expect((await machine.seshi(["sessions", "ls", "--limit", "0"])).code).toBe(2);
    expect((await machine.seshi(["sessions", "ls", "extra"])).code).toBe(2);
  });

  it("colours a terminal's output, and keeps the words", async () => {
    const ls = await machine.seshi(["sessions", "show", "claude-code", "sess1"], {
      tty: { stdout: true, stdin: false },
      env: { TERM: "xterm-256color" },
    });
    expect(ls.out).toContain("\x1b[38;5;");
    expect(ls.out.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")).toContain(
      "status      stored",
    );
    const off = await machine.seshi(["sessions", "show", "claude-code", "sess1", "--no-color"], {
      tty: { stdout: true, stdin: false },
      env: { TERM: "xterm-256color" },
    });
    expect(off.out).not.toContain("\x1b[");
    const noColor = await machine.seshi(["sessions", "show", "claude-code", "sess1"], {
      tty: { stdout: true, stdin: false },
      env: { TERM: "xterm-256color", NO_COLOR: "1" },
    });
    expect(noColor.out).not.toContain("\x1b[");
  });

  it("shows a session, its trace, and refuses one that is not there", async () => {
    const show = await machine.seshi(["sessions", "show", "claude-code/sess1"]);
    expect(show.code, show.err).toBe(0);
    expect(show.out).toContain("claude-code/sess1");
    expect(show.out).toContain("owner       acme (verified)");
    expect(show.out).toContain("project     github.com/acme/widget");
    const withTrace = await machine.seshi(["sessions", "show", "claude-code", "sess1", "--trace"]);
    expect(withTrace.out).toContain("head trace,");
    expect(withTrace.out).toMatch(/assistant +The auth flow/);
    const json = JSON.parse(
      (await machine.seshi(["sessions", "show", "claude-code", "sess1", "--trace", "--json"])).out,
    );
    expect(json.trace).toMatchObject({ schema: "seshi/trace/1" });
    expect(json.metadata).toMatchObject({ session_id: "sess1" });
    const missing = await machine.seshi(["sessions", "show", "claude-code", "nope", "--json"]);
    expect(missing.code).toBe(4);
    expect(JSON.parse(missing.err)).toMatchObject({ error: { code: "not_found" } });
    expect((await machine.seshi(["sessions", "show", "claude-code"])).code).toBe(2);
  });

  it("exports in each format, to standard output or a file", async () => {
    const atif = await machine.seshi([
      "sessions",
      "export",
      "claude-code",
      "sess1",
      "--format",
      "atif",
    ]);
    expect(atif.code, atif.err).toBe(0);
    expect(JSON.parse(atif.out)).toMatchObject({ schema_version: "ATIF-v1.7" });
    const seshi = JSON.parse(
      (await machine.seshi(["sessions", "export", "claude-code/sess1"])).out,
    );
    expect(seshi).toMatchObject({ schema: "seshi/trace/1" });
    const hash = seshi.content_hash as string;
    const letta = JSON.parse(
      (
        await machine.seshi([
          "sessions",
          "export",
          "claude-code/sess1",
          "--format",
          "letta",
          "--hash",
          hash,
        ])
      ).out,
    );
    expect(letta).toMatchObject({ schema: "sessionstorage/trace/1", content_hash: hash });

    const file = join(machine.dir, "out.json");
    const written = await machine.seshi([
      "sessions",
      "export",
      "claude-code/sess1",
      "-o",
      file,
      "--json",
    ]);
    expect(JSON.parse(written.out)).toMatchObject({ path: file, format: "seshi", hash });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(seshi);
    const folder = join(machine.dir, "exports");
    mkdirSync(folder);
    const named = await machine.seshi([
      "sessions",
      "export",
      "claude-code/sess1",
      "--format",
      "otlp",
      "-o",
      folder,
    ]);
    expect(named.out).toContain(`claude-code-sess1-${hash.slice(0, 12)}.otlp.json`);
    expect(existsSync(join(folder, `claude-code-sess1-${hash.slice(0, 12)}.otlp.json`))).toBe(true);

    expect(
      (await machine.seshi(["sessions", "export", "claude-code/sess1", "--format", "xml"])).code,
    ).toBe(2);
    expect(
      (await machine.seshi(["sessions", "export", "claude-code/sess1", "--hash", "abc"])).code,
    ).toBe(2);
    const wrongHash = await machine.seshi([
      "sessions",
      "export",
      "claude-code/sess1",
      "--hash",
      "0".repeat(64),
    ]);
    expect(wrongHash.code).toBe(4);
    expect((await machine.seshi(["sessions", "export", "claude-code/nope"])).code).toBe(4);
  });

  it("changes visibility, and deletes only with --yes or a terminal's yes", async () => {
    const vis = await machine.seshi(["sessions", "visibility", "claude-code/sess1", "owner"]);
    expect(vis.code, vis.err).toBe(0);
    expect(vis.out).toContain("is owner");
    expect((await machine.seshi(["sessions", "visibility", "claude-code/sess1", "all"])).code).toBe(
      2,
    );
    expect((await machine.seshi(["sessions", "visibility", "claude-code/nope", "org"])).code).toBe(
      4,
    );

    const refused = await machine.seshi(["sessions", "rm", "claude-code/sess1"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("add --yes");
    const terminal = {
      ask: async () => "n",
      background: async () => undefined,
      openUrl: async () => false,
    };
    const declined = await machine.seshi(["sessions", "rm", "claude-code/sess1"], {
      terminal,
      tty: { stdout: false, stdin: true },
    });
    expect(declined.code).toBe(1);
    expect(declined.err).toContain("nothing deleted");
    const confirmed = await machine.seshi(["sessions", "rm", "claude-code/sess1", "--json"], {
      terminal: { ...terminal, ask: async () => "yes" },
      tty: { stdout: false, stdin: true },
    });
    expect(confirmed.code, confirmed.err).toBe(0);
    expect(JSON.parse(confirmed.out)).toMatchObject({ session_id: "sess1" });
    const after = await machine.seshi(["sessions", "show", "claude-code/sess1"]);
    expect(after.out).toContain("deleted (redacted)");
    const gone = await machine.seshi(["sessions", "export", "claude-code/sess1"]);
    expect(gone.code).toBe(4);
    expect(gone.err).toContain("was deleted");
    expect((await machine.seshi(["sessions", "rm", "claude-code/nope", "--yes"])).code).toBe(4);
  });

  it("reads another owner's sessions as visibility allows (X5.10)", async () => {
    // Log in as the admin, who reads everything.
    await machine.seshi(["login", "--token", "-"], { stdin: admin });
    const ls = await machine.seshi(["sessions", "ls", "--owner", "acme", "--json"]);
    expect(JSON.parse(ls.out).sessions).toHaveLength(2);
    const show = await machine.seshi(["sessions", "show", "claude-code/sess2", "--owner", "acme"]);
    expect(show.code).toBe(0);
    expect((await machine.seshi(["sessions", "show", "claude-code/sess2"])).code).toBe(4);
    const rm = await machine.seshi([
      "sessions",
      "rm",
      "claude-code/sess2",
      "--owner",
      "acme",
      "--yes",
    ]);
    expect(rm.code, rm.err).toBe(0);
    expect(rm.out).toContain("claude-code/sess2 of acme");
  });

  it("says when the server is down or refuses the credential", async () => {
    // A stored token the server no longer accepts.
    await machine.logins.update(server.url, {}, { token: "seshi_00000000000000000000_nope" });
    const refused = await machine.seshi(["sessions", "ls"]);
    expect(refused.code).toBe(5);
    expect(refused.err).toContain("refused the stored credential");
    const down = await machine.seshi(["sessions", "ls", "--server", "http://127.0.0.1:9"]);
    expect(down.code).toBe(5); // no credential stored for that server
    machine.cliConfig('server = "http://127.0.0.1:9"\n');
    await machine.logins.save(
      { server: "http://127.0.0.1:9", mode: "token", signed_in_at: new Date().toISOString() },
      { token: "x" },
    );
    const unreachable = await machine.seshi(["sessions", "ls"]);
    expect(unreachable.code).toBe(7);
    expect(unreachable.err).toContain("cannot reach http://127.0.0.1:9");
  });
});

describe("seshi tokens", () => {
  beforeEach(async () => {
    await machine.seshi(["login", "--token", "-"], { stdin: admin });
  });

  it("creates, lists, revokes one and revokes an owner's", async () => {
    const created = await machine.seshi([
      "tokens",
      "create",
      "device",
      "--owner",
      "alice",
      "--label",
      "laptop",
      "--expires",
      "30d",
      "--json",
    ]);
    expect(created.code, created.err).toBe(0);
    const { token, record } = JSON.parse(created.out);
    expect(token).toMatch(/^seshi_/);
    expect(record).toMatchObject({ kind: "device", owner: "alice", label: "laptop" });
    const human = await machine.seshi(["tokens", "create", "service", "--service", "sync"]);
    expect(human.out).toContain("Shown once");
    expect(human.out).toMatch(/^seshi_/m);

    const ls = await machine.seshi(["tokens", "ls"]);
    expect(ls.out).toMatch(
      new RegExp(`${record.id} +device +alice +live +\\d{4}-\\d\\d-\\d\\d +laptop`),
    );
    const only = JSON.parse(
      (await machine.seshi(["tokens", "ls", "--kind", "device", "--json"])).out,
    );
    expect(only.tokens.map((t: { id: string }) => t.id)).toEqual([record.id]);

    const revoked = await machine.seshi(["tokens", "revoke", record.id]);
    expect(revoked.out).toContain(`Revoked device token ${record.id} of alice`);
    expect((await machine.seshi(["tokens", "ls", "--owner", "alice", "--json"])).out).toContain(
      '"tokens": []',
    );
    expect((await machine.seshi(["tokens", "ls", "--owner", "alice", "--all"])).out).toContain(
      "revoked",
    );
    expect((await machine.seshi(["tokens", "revoke", "0".repeat(20)])).code).toBe(4);

    await machine.seshi(["tokens", "create", "admin", "--owner", "bob"]);
    const offboard = await machine.seshi(["tokens", "revoke", "--owner", "bob", "--json"]);
    expect(JSON.parse(offboard.out).revoked).toHaveLength(1);
    expect((await machine.seshi(["tokens", "revoke", "--owner", "bob"])).out).toContain(
      "had no live tokens",
    );
  });

  it("refuses what makes no sense", async () => {
    expect((await machine.seshi(["tokens"])).code).toBe(2);
    expect((await machine.seshi(["tokens", "create"])).code).toBe(2);
    expect((await machine.seshi(["tokens", "create", "superuser"])).code).toBe(2);
    expect(
      (await machine.seshi(["tokens", "create", "device", "--scope", "everything"])).code,
    ).toBe(2);
    expect(
      (await machine.seshi(["tokens", "create", "device", "--expires", "yesterday"])).code,
    ).toBe(2);
    expect(
      (await machine.seshi(["tokens", "create", "device", "--expires", "2001-01-01"])).code,
    ).toBe(2);
    expect((await machine.seshi(["tokens", "revoke"])).code).toBe(2);
    expect((await machine.seshi(["tokens", "revoke", "x", "--owner", "y"])).code).toBe(2);
    // The server refuses a device token without an owner (400).
    const noOwner = await machine.seshi(["tokens", "create", "device"]);
    expect(noOwner.code).toBe(2);
    expect(noOwner.err).toContain("owner");
  });
});

describe("local mode (F8.3, X3.5)", () => {
  it("lists, shows, exports, deletes and manages tokens on your own bucket", async () => {
    const local = new Machine();
    try {
      const toml = join(local.dir, "seshi.toml");
      writeFileSync(toml, `[store]\nurl = "file://${join(local.dir, "bucket")}"\n`, {
        mode: 0o600,
      });
      local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
      const connection = await connect({
        cli: {
          local: { config: toml, owner: "me" },
          theme: "auto",
          capture: { enabled: true, paths: [] },
        },
        env: {},
        integrations: INTEGRATIONS,
      });
      await connection.db.ingest({ agent: "claude-code", session_id: "s1", transcript: CLAUDE });
      await connection.close();

      const who = JSON.parse((await local.seshi(["whoami", "--json"])).out);
      expect(who).toMatchObject({ mode: "local", identity: { owner: "me", kind: "local" } });
      expect((await local.seshi(["whoami"])).out).toContain("me in local mode");
      const ls = await local.seshi(["sessions", "ls"]);
      expect(ls.code, ls.err).toBe(0);
      expect(ls.out).toContain("claude-code/s1");
      expect((await local.seshi(["sessions", "show", "claude-code/s1"])).out).toContain(
        "owner       me (verified)",
      );
      const atif = await local.seshi(["sessions", "export", "claude-code/s1", "--format", "atif"]);
      expect(JSON.parse(atif.out)).toMatchObject({ schema_version: "ATIF-v1.7" });
      expect((await local.seshi(["sessions", "visibility", "claude-code/s1", "owner"])).code).toBe(
        0,
      );

      const created = JSON.parse(
        (await local.seshi(["tokens", "create", "admin", "--owner", "ops", "--json"])).out,
      );
      expect(created.record).toMatchObject({
        kind: "admin",
        owner: "ops",
        created_by: { kind: "local", principal: "me" },
      });
      expect((await local.seshi(["tokens", "ls"])).out).toContain(created.record.id);
      expect((await local.seshi(["tokens", "revoke", created.record.id])).code).toBe(0);

      const rm = await local.seshi(["sessions", "rm", "claude-code/s1", "--yes"]);
      expect(rm.code, rm.err).toBe(0);
      expect((await local.seshi(["sessions", "export", "claude-code/s1"])).code).toBe(4);

      // A bucket config it cannot use is a setting to fix.
      local.cliConfig(`[local]\nconfig = "${join(local.dir, "missing.toml")}"\n`);
      expect((await local.seshi(["sessions", "ls"])).code).toBe(3);
    } finally {
      local.cleanup();
    }
  });
});

describe("remote status (X7.5)", () => {
  beforeEach(async () => {
    await machine.seshi(["login", "--token", "-"], { stdin: admin });
    await writeFailed(server.instance.store, {
      at: "2026-11-01T00:00:00.000Z",
      source: "upload",
      idempotency_key: "k1",
      session_key: "claude-code/x",
      code: "invalid",
      message: "no records",
    });
    await writeDropped(server.instance.store, {
      at: "2026-11-02T00:00:00.000Z",
      source: "upload",
      idempotency_key: "k2",
      session_key: "claude-code/y",
      reason: "review_drop",
      policy: "default",
      policy_hash: "h",
      decision_model: "m",
    });
  });

  it("reads workers status from the server", async () => {
    const status = await machine.seshi(["workers", "status", "--server", server.url]);
    // No worker has run against this bucket: nothing needs a look yet.
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("worker: none has run against this bucket");
    expect(status.out).toContain("upload");
    const json = JSON.parse(
      (await machine.seshi(["workers", "status", "--server", server.url, "--json"])).out,
    );
    expect(json).toMatchObject({ deployment: "local", worker: { state: "never" } });
    const both = await machine.seshi([
      "workers",
      "status",
      "--server",
      server.url,
      "--config",
      "x",
    ]);
    expect(both.code).toBe(2);
  });

  it("reads sync status, failures and drops from the server", async () => {
    const status = await machine.seshi(["sync", "status", "--server", server.url]);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toMatch(
      /upload +upload +hooks and seshi upload; checkpoint none; 1 dropped, 1 failed/,
    );
    const one = JSON.parse(
      (await machine.seshi(["sync", "status", "upload", "--server", server.url, "--json"])).out,
    );
    expect(one).toMatchObject({ id: "upload", failed: 1 });
    expect((await machine.seshi(["sync", "status", "nope", "--server", server.url])).code).toBe(4);

    const failed = await machine.seshi(["sync", "failed", "upload", "--server", server.url]);
    expect(failed.out).toBe("2026-11-01T00:00:00.000Z  claude-code/x  invalid: no records");
    const dropped = JSON.parse(
      (await machine.seshi(["sync", "dropped", "upload", "--server", server.url, "--json"])).out,
    );
    expect(dropped).toMatchObject({
      kind: "dropped",
      records: [{ record: { reason: "review_drop" } }],
    });
    const since = await machine.seshi([
      "sync",
      "failed",
      "upload",
      "--since",
      "2026-11-02",
      "--server",
      server.url,
    ]);
    expect(since.out).toBe("no failed records for upload");
    expect((await machine.seshi(["sync", "failed", "nope", "--server", server.url])).code).toBe(4);
    expect(
      (await machine.seshi(["sync", "failed", "upload", "--since", "x", "--server", server.url]))
        .code,
    ).toBe(2);
    const run = await machine.seshi(["sync", "run", "upload", "--server", server.url]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("polls on its own");
  });

  it("uses the signed-in server when no server config is here", async () => {
    if (existsSync("/etc/seshi/seshi.toml") || existsSync("seshi.toml")) return;
    const status = await machine.seshi(["sync", "failed", "upload"]);
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("invalid: no records");
  });

  it("needs an admin", async () => {
    await machine.seshi(["login", "--token", "-"], { stdin: TOKEN });
    const status = await machine.seshi(["workers", "status", "--server", server.url]);
    expect(status.code).toBe(5);
    expect(status.err).toContain("not allowed");
  });
});
