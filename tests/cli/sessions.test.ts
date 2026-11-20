/** `seshi sessions` and `seshi tokens` (F8.1, F8.3) against a seshi server on 127.0.0.1 with
 * the credential `seshi login` stored, and in local mode against a folder bucket; and the
 * remote `workers status` and `sync status|failed|dropped` (06's open item). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpSessionDB } from "@seshi/client";
import { VERSION } from "@seshi/model";
import {
  archiveId,
  ensureLayout,
  FsStore,
  type Store,
  writeDropped,
  writeFailed,
  writeReview,
} from "@seshi/store";
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

/** Model review's record for write `n` of a session (F3.8), as the pipeline writes it. */
function review(
  store: Store,
  owner: string,
  sessionId: string,
  n: number,
  decision: "allow" | "redact" | "skipped",
) {
  return writeReview(store, owner, archiveId(owner, "claude-code", sessionId), {
    n,
    at: "2026-11-14T00:00:00.000Z",
    content_hash: "0".repeat(64),
    policy: "default",
    policy_hash: "1".repeat(64),
    decision,
    decision_model: "fake/model",
    findings: [],
  });
}

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
  it("names itself seshi/<version> to the server, not the client library's default", async () => {
    const ingests = server.requests.filter((r) => r.path === "/v1/sessions");
    expect(ingests[0]?.headers["user-agent"]).toBe(`@dosu/seshi-client/${VERSION}`);
    const login = server.requests.filter((r) => r.path === "/v1/me");
    expect(login.length).toBeGreaterThan(0);
    const from = server.requests.length;
    expect((await machine.seshi(["sessions", "ls"])).code).toBe(0);
    const cli = [...login, ...server.requests.slice(from)];
    expect(cli.length).toBeGreaterThan(login.length);
    for (const request of cli) expect(request.headers["user-agent"]).toBe(`seshi/${VERSION}`);
  });

  it("lists, as lines or one JSON document, and pages", async () => {
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.out).toContain("acme: 2 sessions; most recently active first, in local time");
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

  it("dates each session by its last activity, in local time", async () => {
    const local = new Date("2026-09-01T00:00:08.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`;
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.out).toContain(`claude-code/sess1  ${stamp}  `);
    const show = await machine.seshi(["sessions", "show", "claude-code", "sess1"]);
    expect(show.out).toContain("active      2026-09-01T00:00:08.000Z");
  });

  it("folds subagents under their session, and lists them with --subagents", async () => {
    const db = new HttpSessionDB({ server: server.url, token: TOKEN });
    await db.ingest({
      agent: "claude-code",
      session_id: "agent-a1",
      transcript: CLAUDE.replaceAll("sess1", "agent-a1"),
      parent_session_id: "sess1",
    });
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.out).toContain("acme: 2 sessions, 1 subagent not shown (--subagents)");
    expect(ls.out).toMatch(/claude-code\/sess1 .*\(main\) \+1 subagent$/m);
    expect(ls.out).not.toContain("agent-a1");
    const all = await machine.seshi(["sessions", "ls", "--subagents"]);
    expect(all.out).toContain("acme: 2 sessions, 1 subagent;");
    const lines = all.out.split("\n");
    const parent = lines.findIndex((l) => l.startsWith("claude-code/sess1 "));
    expect(lines[parent + 1]).toMatch(/^ {2}└ claude-code\/agent-a1 /);
    const show = await machine.seshi(["sessions", "show", "claude-code", "agent-a1"]);
    expect(show.out).toContain("subagent of sess1");
    const json = JSON.parse((await machine.seshi(["sessions", "ls", "--json"])).out);
    expect(json.sessions).toHaveLength(3);
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
    expect(show.out).not.toContain("review ");
    // Model review's decision for each stored write (F3.8), when a policy covered it.
    await review(server.instance.store, "acme", "sess1", 0, "allow");
    await review(server.instance.store, "acme", "sess1", 1, "redact");
    const reviewed = await machine.seshi(["sessions", "show", "claude-code/sess1"]);
    expect(reviewed.out).toContain("review      #0 allow, #1 redact");
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

  it("never prints a session's control characters to the terminal", async () => {
    // A member's transcript and project carrying escape sequences: a title change, an OSC 52
    // clipboard write, a cursor move that would hide a line.
    const db = new HttpSessionDB({ server: server.url, token: TOKEN });
    const nasty = `${JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "evil",
      message: { role: "user", content: "hi\x1b]0;owned\x07 \x1b]52;c;cm0gLXJm\x07\x1b[2Aok" },
    })}\n${JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-01T00:00:01.000Z",
      sessionId: "evil",
      message: {
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: `Sure \x1b[31mred\x1b[0m. ${"words ".repeat(400)}` }],
      },
    })}\n`;
    await db.ingest({
      agent: "claude-code",
      session_id: "evil",
      transcript: nasty,
      project: "acme\x1b[1Kwidget",
    });
    const tty = { stdout: true, stdin: false };
    const env = { TERM: "xterm-256color", COLORTERM: "truecolor", SESHI_THEME: "dark" };
    for (const argv of [
      ["sessions", "ls"],
      ["sessions", "show", "claude-code/evil", "--trace"],
    ]) {
      const result = await machine.seshi(argv, { tty, env });
      expect(result.code, result.err).toBe(0);
      // Colour on, yet once our own SGR sequences are gone, no control character is left.
      expect(result.out).toContain("\x1b[");
      const ours = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
      const left = [...result.out.replace(ours, "")].filter((c) => {
        const code = c.charCodeAt(0);
        return c !== "\n" && (code < 0x20 || (code >= 0x7f && code <= 0x9f));
      });
      expect(left, argv.join(" ")).toEqual([]);
    }
    // What is left of the sequences is inert text.
    const trace = await machine.seshi(["sessions", "show", "claude-code/evil", "--trace"], {
      tty,
      env,
    });
    expect(trace.out).toContain("hi\uFFFD]0;owned\uFFFD");
    expect(trace.out).toContain("\uFFFD[2Aok");
    // JSON escapes them; it is for programs.
    const json = await machine.seshi(["sessions", "show", "claude-code/evil", "--json"]);
    expect(JSON.parse(json.out).project).toBe("acme\x1b[1Kwidget");
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
    // A file that cannot be written is a failure with a message, not a crash.
    const nowhere = await machine.seshi([
      "sessions",
      "export",
      "claude-code/sess1",
      "-o",
      join(machine.dir, "missing", "out.json"),
      "--json",
    ]);
    expect(nowhere.code).toBe(1);
    expect(JSON.parse(nowhere.err)).toMatchObject({ error: { code: "io" } });
  });

  it("names a logins file it cannot read instead of crashing", async () => {
    writeFileSync(join(machine.configDir, "logins.json"), "{ not json");
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.code).toBe(3);
    expect(ls.err).toContain("logins.json is not a JSON object");
    expect(ls.err).toContain("seshi login");
  });

  it("changes visibility, and deletes only with --yes or a terminal's yes", async () => {
    const vis = await machine.seshi(["sessions", "visibility", "claude-code/sess1", "owner"]);
    expect(vis.code, vis.err).toBe(0);
    expect(vis.out).toContain("is owner: only its owner (and admins) may read it");
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

describe("serverless mode, by its old name [local] (F11.1)", () => {
  it("lists, shows, exports and deletes on the bucket, and leaves tokens to a server", async () => {
    const local = new Machine();
    try {
      const toml = join(local.dir, "seshi.toml");
      writeFileSync(toml, `[store]\nurl = "file://${join(local.dir, "bucket")}"\n`, {
        mode: 0o600,
      });
      local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
      await ensureLayout(new FsStore(join(local.dir, "bucket")), {
        createdBy: "test",
        mode: "serverless",
      });
      const connection = await connect({
        cli: {
          local: { config: toml, owner: "me" },
          search: { scope: "visible" },
          theme: "auto",
          keychain: true,
          capture: { enabled: true, paths: [], remotes: [], exclude: [], redact_tool_calls: [] },
        },
        env: {},
        home: local.dir,
        integrations: INTEGRATIONS,
      });
      await connection.db.ingest({ agent: "claude-code", session_id: "s1", transcript: CLAUDE });
      await connection.close();

      const who = JSON.parse((await local.seshi(["whoami", "--json"])).out);
      expect(who).toMatchObject({
        mode: "serverless",
        identity: { owner: "me", kind: "local", role: "member", owner_basis: "claimed" },
      });
      expect((await local.seshi(["whoami"])).out).toContain("me in serverless mode");
      const ls = await local.seshi(["sessions", "ls"]);
      expect(ls.code, ls.err).toBe(0);
      expect(ls.out).toContain("claude-code/s1");
      expect((await local.seshi(["sessions", "show", "claude-code/s1"])).out).toContain(
        "owner       me (claimed)",
      );
      await review(new FsStore(`file://${join(local.dir, "bucket")}`), "me", "s1", 0, "skipped");
      expect((await local.seshi(["sessions", "show", "claude-code/s1"])).out).toContain(
        "review      #0 skipped",
      );
      // Search goes through the same local backend: the bucket's own index.
      const found = await local.seshi(["search", "auth", "flow"]);
      expect(found.code, found.err).toBe(0);
      expect(found.err).toContain("building the search index");
      expect(found.out).toContain("claude-code/s1  me");
      const atif = await local.seshi(["sessions", "export", "claude-code/s1", "--format", "atif"]);
      expect(JSON.parse(atif.out)).toMatchObject({ schema_version: "ATIF-v1.7" });
      const vis = await local.seshi(["sessions", "visibility", "claude-code/s1", "owner"]);
      expect(vis.code, vis.err).toBe(0);
      expect(vis.out).toContain("any key that can read the bucket can read it");
      expect(vis.out).not.toContain("admins");

      const tokens = await local.seshi(["tokens", "create", "admin", "--owner", "ops"]);
      expect(tokens.code).toBe(3);
      expect(tokens.err).toContain("tokens need a server");

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
    const assemble = await machine.seshi(["sync", "assemble", "--server", server.url]);
    expect(assemble.code).toBe(2);
    expect(assemble.err).toContain("assembles on its own");
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
