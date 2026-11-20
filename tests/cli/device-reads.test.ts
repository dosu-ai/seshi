/** A member's machine signed in with nothing but a device token (X5.10), as ADX's `dosu setup`
 * enrolls one: `seshi sessions ls|show|export` and `seshi search` read the member's own
 * sessions, private ones too, and find no one else's. */

import { HttpSessionDB } from "@seshi/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = (id: string, words: string) =>
  `${SMALL.trim().replaceAll("sess1", id)}\n${JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-09-01T00:00:08.000Z",
    sessionId: id,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: `${words}: ${"details ".repeat(400)}` }],
    },
  })}\n`;

const ALICE = "u-0b6f3c1e-5d0a-4c55-9a3e-7b1d2f4e6a80";
const BOB = "u-9e2d4a7c-1b3f-4e8d-a6c5-0f7e9d1b3a52";

let server: TestServer;
let machine: Machine;

async function mint(admin: string, owner: string): Promise<string> {
  const res = await fetch(`${server.url}/v1/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "device", owner }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  server = await startServer();
  const admin = (await server.auth.initAdmin({ owner: "ops" })).admin?.token as string;
  const alice = await mint(admin, ALICE);
  await new HttpSessionDB({ server: server.url, token: alice }).ingest({
    format: "claude-code",
    session_id: "mine",
    transcript: CLAUDE("mine", "The rotation plan"),
    visibility: "owner",
  });
  await new HttpSessionDB({ server: server.url, token: await mint(admin, BOB) }).ingest({
    format: "claude-code",
    session_id: "theirs",
    transcript: CLAUDE("theirs", "The rotation rollout"),
    visibility: "org",
  });
  await server.instance.search?.catchUp();
  machine = new Machine();
  const login = await machine.seshi(["login", "--server", server.url, "--token", "-"], {
    stdin: alice,
  });
  expect(login.code, login.err).toBe(0);
});

afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

describe("a device login reads its own sessions", () => {
  it("lists, shows and exports its own session, private as it is", async () => {
    const ls = await machine.seshi(["sessions", "ls", "--json"]);
    expect(ls.code, ls.err).toBe(0);
    expect(JSON.parse(ls.out).sessions.map((s: { session_id: string }) => s.session_id)).toEqual([
      "mine",
    ]);
    const show = await machine.seshi(["sessions", "show", "claude-code", "mine", "--json"]);
    expect(show.code, show.err).toBe(0);
    expect(JSON.parse(show.out)).toMatchObject({ owner: ALICE, visibility: "owner" });
    const exported = await machine.seshi(["sessions", "export", "claude-code", "mine"]);
    expect(exported.code, exported.err).toBe(0);
    expect(exported.out).toContain("The rotation plan");
  });

  it("finds no one else's session, shared or not, and may not list another owner's", async () => {
    const show = await machine.seshi(["sessions", "show", "claude-code", "theirs", "--owner", BOB]);
    expect(show.code).toBe(4);
    expect(show.err).toContain("no session claude-code/theirs");
    const ls = await machine.seshi(["sessions", "ls", "--owner", BOB]);
    expect(ls.code).not.toBe(0);
    expect(ls.err).toContain("reads only its own sessions");
  });

  it("searches its own sessions only", async () => {
    const found = await machine.seshi(["search", "rotation", "--json"]);
    expect(found.code, found.err).toBe(0);
    const hits = JSON.parse(found.out).results.map((r: { session_id: string }) => r.session_id);
    expect(hits).toEqual(["mine"]);
    const refused = await machine.seshi(["search", "rotation", "--owner", BOB]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("reads only its own sessions");
  });
});
