/** `seshi login`, `whoami` and `logout` (F8.2, X5.7) against a seshi server on 127.0.0.1 and a
 * stand-in IdP: the device flow and the browser with PKCE, the org key, a pasted token, the
 * session token renewed through the refresh token, and the delete freshness rule (X5.3). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpSessionDB } from "@seshi/client";
import { credentialFor } from "seshi/account";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeTerminal, IdpServer, Machine, startServer, type TestServer } from "../tooling/cli";
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

let idp: IdpServer;
let server: TestServer;
let machine: Machine;

async function idpServer(): Promise<TestServer> {
  return startServer({
    idp: idp.idp,
    settings: {
      oidc: {
        issuer: idp.url,
        client_id: "seshi-cli",
        audience: "seshi-cli",
        owner_claim: "email",
        groups_claim: "groups",
      },
    },
  });
}

beforeEach(async () => {
  idp = await IdpServer.start();
  server = await idpServer();
  machine = new Machine({ SESHI_USER: "nobody@acme.com" });
});

afterEach(async () => {
  await server.stop();
  idp.stop();
  machine.cleanup();
});

describe("signing in through the IdP (X5.7)", () => {
  it("runs the device flow, exchanges once, and keeps a session, refresh and device token", async () => {
    const result = await machine.seshi(["login", "--server", `${server.url}/`]);
    expect(result.code, result.err).toBe(0);
    expect(result.err).toContain("enter the code WDJB-MJHT");
    expect(result.err).toContain(`${idp.url}/activate`);
    expect(result.out).toContain(
      `Signed in to ${server.url} as alice@acme.com (member, through the IdP)`,
    );
    expect(result.out).toMatch(/device token that expires \d{4}-\d{2}-\d{2}/);
    // Polled until signed in: one pending answer, then the tokens.
    expect(idp.calls.filter((c) => c.path === "/token").length).toBe(2);

    const profile = machine.logins.get(server.url);
    expect(profile).toMatchObject({
      mode: "oidc",
      owner: "alice@acme.com",
      role: "member",
      stored_in: "memory",
      oidc: { issuer: idp.url, client_id: "seshi-cli", flow: "device" },
    });
    expect([...machine.secrets.values.keys()].sort()).toEqual([
      `${server.url} device`,
      `${server.url} refresh`,
      `${server.url} session`,
    ]);
    // The server is remembered in the CLI config.
    expect(readFileSync(join(machine.configDir, "config.toml"), "utf8")).toBe(
      `server = "${server.url}"\n`,
    );
    // The device token was issued for this machine, and only writes.
    const devices = await server.auth.tokens.list({ owner: "alice@acme.com", kind: "device" });
    expect(devices.map((d) => d.machine?.id)).toEqual([machine.logins.machineId()]);

    const who = await machine.seshi(["whoami", "--json"]);
    expect(who.code, who.err).toBe(0);
    expect(JSON.parse(who.out)).toMatchObject({
      mode: "server",
      where: server.url,
      identity: { owner: "alice@acme.com", kind: "person", owner_basis: "verified" },
      login: { mode: "oidc", stored_in: "memory" },
    });
  });

  it("signs in again on the same machine, replacing its device token", async () => {
    expect((await machine.seshi(["login", "--server", server.url])).code).toBe(0);
    idp.pendingPolls = 0;
    expect((await machine.seshi(["login"])).code).toBe(0);
    const live = await server.auth.tokens.list({ owner: "alice@acme.com", kind: "device" });
    expect(live).toHaveLength(1);
  });

  it("uses the browser with PKCE when asked, or when the IdP has no device flow", async () => {
    const terminal = fakeTerminal();
    const result = await machine.seshi(["login", "--server", server.url, "--browser", "--json"], {
      terminal,
    });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      mode: "oidc",
      owner: "alice@acme.com",
      refresh: true,
    });
    expect(machine.logins.get(server.url)?.oidc?.flow).toBe("browser");
    expect(idp.calls.some((c) => c.path === "/authorize")).toBe(true);

    idp.device = false;
    const again = await machine.seshi(["login"], { terminal });
    expect(again.code, again.err).toBe(0);
    expect(again.err).toContain("Opening your browser");
  });

  it("renews the session token through the refresh token, and asks for a fresh one to delete", async () => {
    expect((await machine.seshi(["login", "--server", server.url])).code).toBe(0);
    // Upload as the uploader would, with the device token.
    const upload = await credentialFor(
      { logins: machine.logins, env: machine.env },
      server.url,
      "upload",
    );
    await new HttpSessionDB({ server: server.url, token: upload.token }).ingest({
      agent: "claude-code",
      session_id: "s1",
      transcript: CLAUDE,
    });

    // An expired session token is renewed on the next command.
    const logins = machine.logins;
    const before = await logins.secret(server.url, "session");
    await logins.update(server.url, {
      session: { issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z" },
    });
    const ls = await machine.seshi(["sessions", "ls"]);
    expect(ls.code, ls.err).toBe(0);
    expect(ls.out).toContain("claude-code/s1");
    expect(idp.calls.filter((c) => c.grant === "refresh_token")).toHaveLength(1);
    const after = await logins.secret(server.url, "session");
    expect(after).not.toBe(before);

    // A session token older than ten minutes reads, but is renewed before a delete (X5.3).
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const later = new Date(Date.now() + 30 * 60_000).toISOString();
    await logins.update(server.url, { session: { issued_at: old, expires_at: later } });
    expect((await machine.seshi(["sessions", "show", "claude-code", "s1"])).code).toBe(0);
    expect(idp.calls.filter((c) => c.grant === "refresh_token")).toHaveLength(1);
    // The person is asked first: a declined delete renews nothing.
    const declined = await machine.seshi(["sessions", "rm", "claude-code/s1", "--json"], {
      terminal: {
        ask: async () => "n",
        background: async () => undefined,
        openUrl: async () => false,
      },
      tty: { stdout: false, stdin: true },
    });
    expect(declined.code).toBe(1);
    expect(JSON.parse(declined.err)).toMatchObject({ error: { code: "cancelled" } });
    expect(idp.calls.filter((c) => c.grant === "refresh_token")).toHaveLength(1);
    const rm = await machine.seshi(["sessions", "rm", "claude-code/s1", "--yes"]);
    expect(rm.code, rm.err).toBe(0);
    expect(rm.out).toContain("Deleted claude-code/s1");
    expect(idp.calls.filter((c) => c.grant === "refresh_token")).toHaveLength(2);
  });

  it("asks for a new sign-in once the IdP stops renewing", async () => {
    expect((await machine.seshi(["login", "--server", server.url])).code).toBe(0);
    idp.refreshTokens.clear();
    await machine.logins.update(server.url, {
      session: { issued_at: "2026-01-01T00:00:00.000Z", expires_at: "2026-01-01T01:00:00.000Z" },
    });
    const who = await machine.seshi(["whoami"]);
    expect(who.code).toBe(5);
    expect(who.err).toContain("the IdP no longer renews the session");
    expect(who.err).toContain(`seshi login --server ${server.url}`);
  });

  it("refuses an ID token the server does not accept", async () => {
    idp.claims = { email: "eve@acme.com", email_verified: false };
    const result = await machine.seshi(["login", "--server", server.url]);
    expect(result.code).toBe(5);
    expect(result.err).toContain("refused the sign-in");
    expect(machine.logins.get(server.url)).toBeUndefined();
  });

  it("forgets everything on logout, and names the device token still valid", async () => {
    expect((await machine.seshi(["login", "--server", server.url])).code).toBe(0);
    const device = machine.logins.get(server.url)?.device?.id as string;
    const out = await machine.seshi(["logout"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain(`Signed out of ${server.url}`);
    expect(out.out).toContain(`seshi tokens revoke ${device}`);
    expect(machine.secrets.values.size).toBe(0);
    expect(machine.logins.get(server.url)).toBeUndefined();
    expect((await machine.seshi(["logout"])).out).toBe(`Not signed in to ${server.url}.`);
    const who = await machine.seshi(["whoami", "--json"]);
    expect(who.code).toBe(5);
    expect(JSON.parse(who.err)).toMatchObject({ error: { code: "not_signed_in" } });
  });
});

describe("signing in without an IdP (X5.12)", () => {
  let plain: TestServer;
  beforeEach(async () => {
    plain = await startServer();
  });
  afterEach(() => plain.stop());

  it("stores the org key and states the username on every call", async () => {
    const { org_key, admin } = await plain.auth.initAdmin({ owner: "ops" });
    const result = await machine.seshi(
      ["login", "--server", plain.url, "--key", "-", "--user", "bob@acme.com"],
      { stdin: `${org_key?.token}\n`, env: { SESHI_USER: "" } },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("with the org key, as bob@acme.com");
    expect(readFileSync(join(machine.configDir, "config.toml"), "utf8")).toBe(
      `server = "${plain.url}"\nuser = "bob@acme.com"\n`,
    );
    expect(machine.logins.get(plain.url)).toMatchObject({ mode: "org_key", owner: "bob@acme.com" });

    // The username is resolved again each time: SESHI_USER first (X5.7).
    const who = await machine.seshi(["whoami", "--json"], {
      env: { SESHI_USER: "carol@acme.com" },
    });
    expect(JSON.parse(who.out).identity).toMatchObject({
      owner: "carol@acme.com",
      owner_basis: "claimed",
    });
    // The username stated, as typed: the owner id is its lowercased form.
    expect(JSON.parse(who.out).login).toMatchObject({ mode: "org_key", user: "carol@acme.com" });
    const mixed = await machine.seshi(["whoami"], { env: { SESHI_USER: "Carol@Acme.com" } });
    expect(mixed.out).toContain("stating 'Carol@Acme.com'");
    const asBob = await machine.seshi(["whoami", "--json"], { env: { SESHI_USER: "" } });
    expect(JSON.parse(asBob.out).identity.owner).toBe("bob@acme.com");

    // --visibility is the IdP device token's default; it means nothing with the org key.
    const visibility = await machine.seshi(
      ["login", "--server", plain.url, "--key", "-", "--visibility", "owner"],
      { stdin: `${org_key?.token}\n` },
    );
    expect(visibility.code).toBe(2);
    expect(visibility.err).toContain("device token");

    // The org key manages no tokens.
    const tokens = await machine.seshi(["tokens", "ls"], { env: { SESHI_USER: "" } });
    expect(tokens.code).toBe(5);
    expect(tokens.err).toContain("not allowed");
    expect(admin).toBeDefined();
  });

  it("asks for the key on a terminal, and needs --key elsewhere", async () => {
    const { org_key } = await plain.auth.initAdmin({ owner: "ops" });
    const noTerminal = await machine.seshi(["login", "--server", plain.url]);
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.err).toContain("--key -");
    const terminal = fakeTerminal([org_key?.token as string]);
    const prompted = await machine.seshi(["login", "--server", plain.url], {
      terminal,
      tty: { stdout: false, stdin: true },
    });
    expect(prompted.code, prompted.err).toBe(0);
    expect(terminal.asked).toEqual(["Org key: "]);
  });

  it("refuses a key the server does not accept, and the org key where it is off", async () => {
    const bad = await machine.seshi(["login", "--server", plain.url, "--key", "seshi_nope"]);
    expect(bad.code).toBe(5);
    expect(bad.err).toContain("does not accept that credential");
    const viaIdp = await machine.seshi(["login", "--server", server.url, "--key", "x"]);
    expect(
      (
        await startServer({ settings: { orgKey: false } }).then(async (off) => {
          const r = await machine.seshi(["login", "--server", off.url, "--key", "x"]);
          await off.stop();
          return r;
        })
      ).code,
    ).toBe(5);
    // The IdP server takes the org key too (both on), and refuses this one.
    expect(viaIdp.code).toBe(5);
  });

  it("stores a pasted admin token", async () => {
    const { admin } = await plain.auth.initAdmin({ owner: "ops" });
    const result = await machine.seshi(["login", "--server", plain.url, "--token", "-", "--json"], {
      stdin: admin?.token as string,
    });
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ mode: "token", owner: "ops", role: "admin" });
    expect((await machine.seshi(["tokens", "ls"])).code).toBe(0);
  });
});

describe("what login refuses", () => {
  it("needs a server, refuses local mode, a bad URL and a server that is not seshi", async () => {
    const none = await machine.seshi(["login"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("seshi login --server <url>");
    expect((await machine.seshi(["login", "--server", "seshi.acme.com"])).code).toBe(2);
    expect((await machine.seshi(["login", "--key", "a", "--token", "b"])).code).toBe(2);
    expect((await machine.seshi(["login", "--browser", "--device"])).code).toBe(2);
    expect((await machine.seshi(["login", "--visibility", "everyone"])).code).toBe(2);
    expect((await machine.seshi(["login", "--server", idp.url])).code).toBe(3);
    const down = await machine.seshi(["login", "--server", "http://127.0.0.1:9"]);
    expect(down.code).toBe(7);
    machine.cliConfig('[local]\nconfig = "~/seshi.toml"\n');
    const local = await machine.seshi(["login", "--server", server.url]);
    expect(local.code).toBe(3);
    expect(local.err).toContain("local mode");
  });

  it("is not signed in before login", async () => {
    const who = await machine.seshi(["whoami"]);
    expect(who.code).toBe(5);
    expect(who.err).toBe("seshi: not signed in: run seshi login --server <url>");
    machine.cliConfig(`server = "${server.url}"\n`);
    expect((await machine.seshi(["sessions", "ls"])).err).toContain(
      `not signed in to ${server.url}: run seshi login --server ${server.url}`,
    );
  });
});
