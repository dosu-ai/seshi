/** `seshi share` and `seshi unshare` (X5.10): a member shares their own session with the org
 * from the machine that uploaded it, with nothing but the device token that machine uploads
 * with, and takes it back. */

import { capturePaths, sessionKey, updateState } from "@seshi/capture";
import { HttpSessionDB } from "@seshi/client";
import { archiveId, readChanges, readMetadata } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const SMALL = transcript("claude-basic.claude-code.jsonl");
const CLAUDE = (id: string) =>
  `${SMALL.trim().replaceAll("sess1", id)}\n${JSON.stringify({
    type: "assistant",
    uuid: "a3",
    timestamp: "2026-09-01T00:00:08.000Z",
    sessionId: id,
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
    },
  })}\n`;

const ALICE = "u-0b6f3c1e-5d0a-4c55-9a3e-7b1d2f4e6a80";
const BOB = "u-9e2d4a7c-1b3f-4e8d-a6c5-0f7e9d1b3a52";

let server: TestServer;
let machine: Machine;
let admin: string;

async function mint(owner: string): Promise<string> {
  const res = await fetch(`${server.url}/v1/tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "device", owner }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

/** A machine signed in with `token`, as an admin enrolls a member's laptop. */
async function laptop(token: string): Promise<Machine> {
  const m = new Machine();
  const login = await m.seshi(["login", "--server", server.url, "--token", "-"], { stdin: token });
  expect(login.code, login.err).toBe(0);
  return m;
}

const stored = async (id: string, owner = ALICE) =>
  (await readMetadata(server.instance.store, owner, archiveId(owner, "claude-code", id)))
    ?.visibility;

/** This machine's capture state, as its hooks and uploader leave it for an uploaded session. */
async function captured(
  m: Machine,
  sessions: { id: string; parent?: string; generation?: number; toggle?: "off"; cwd?: string }[],
) {
  const paths = capturePaths({ env: m.env, home: m.dir, platform: process.platform });
  await updateState(paths, (state) => {
    for (const s of sessions) {
      state.sessions[sessionKey("claude-code", s.id)] = {
        agent: "claude-code",
        session_id: s.id,
        cwd: s.cwd ?? m.dir,
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        sent: true,
        ...(s.parent ? { parent_session_id: s.parent } : {}),
        ...(s.generation ? { generation: s.generation } : {}),
        ...(s.toggle ? { toggle: s.toggle } : {}),
      };
    }
  });
}

beforeEach(async () => {
  server = await startServer();
  admin = (await server.auth.initAdmin({ owner: "ops" })).admin?.token as string;
  const token = await mint(ALICE);
  const db = new HttpSessionDB({ server: server.url, token });
  for (const [id, parent] of [["s1"], ["agent-a1", "s1"], ["s2~1"], ["other"]] as const) {
    await db.ingest({
      format: "claude-code",
      session_id: id,
      transcript: CLAUDE(id),
      // As ADX's server has it (default_visibility = "owner"): private until shared.
      visibility: "owner",
      ...(parent ? { parent_session_id: parent } : {}),
    });
  }
  machine = await laptop(token);
});

afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

describe("seshi share and unshare", () => {
  it("share this agent's session and its subagents', with the device token, and take it back", async () => {
    expect(await stored("s1")).toBe("owner");
    await captured(machine, [{ id: "s1" }, { id: "agent-a1", parent: "s1" }]);
    const env = { SESHI_SESSION_ID: "s1", SESHI_AGENT: "claude-code" };
    const shared = await machine.seshi(["share"], { env });
    expect(shared.code, shared.err).toBe(0);
    expect(shared.out).toBe(
      "Shared claude-code/s1, with its 1 subagent session: visibility is org, so every member may read it.",
    );
    expect(await stored("s1")).toBe("org");
    expect(await stored("agent-a1")).toBe("org");
    expect(await stored("other")).toBe("owner");

    const unshared = await machine.seshi(["unshare", "--json"], { env });
    expect(unshared.code, unshared.err).toBe(0);
    expect(JSON.parse(unshared.out)).toMatchObject({
      session_id: "s1",
      visibility: "owner",
      subagents: ["agent-a1"],
    });
    expect(await stored("s1")).toBe("owner");
    expect(await stored("agent-a1")).toBe("owner");

    const { entries } = await readChanges(server.instance.store, ALICE);
    const changed = entries
      .filter((e) => e.entry.kind === "visibility_changed" && e.entry.session_id === "s1")
      .map((e) => [e.entry.writer.kind, (e.entry as { visibility?: string }).visibility]);
    expect(changed).toEqual([
      ["device", "org"],
      ["device", "owner"],
    ]);
  });

  it("find the one session seen in this folder without the agent's variables, as uploaded", async () => {
    // Turned off and on once, it is stored as s2~1.
    await captured(machine, [{ id: "s2", generation: 1, cwd: process.cwd() }]);
    const shared = await machine.seshi(["share"]);
    expect(shared.code, shared.err).toBe(0);
    expect(shared.out).toContain("Shared claude-code/s2~1: visibility is org");
    expect(await stored("s2~1")).toBe("org");
    // With two seen here, it asks which, and --session names it.
    await captured(machine, [{ id: "s1", cwd: process.cwd() }]);
    const which = await machine.seshi(["unshare"]);
    expect(which.code).toBe(2);
    expect(which.err).toContain("more than one ran here in the past day");
    expect((await machine.seshi(["unshare", "--session", "s2"])).code).toBe(0);
    expect(await stored("s2~1")).toBe("owner");
  });

  it("share a session named on the command line", async () => {
    const shared = await machine.seshi(["share", "claude-code", "other"]);
    expect(shared.code, shared.err).toBe(0);
    expect(await stored("other")).toBe("org");
    expect((await machine.seshi(["unshare", "claude-code/other"])).code).toBe(0);
    expect(await stored("other")).toBe("owner");
  });

  it("refuse another member's device, which finds nothing there, and admins share anyone's", async () => {
    const bob = await laptop(await mint(BOB));
    try {
      const refused = await bob.seshi(["share", "claude-code", "s1", "--owner", ALICE]);
      expect(refused.code).toBe(4);
      expect(refused.err).toContain("no session claude-code/s1");
      expect(await stored("s1")).toBe("owner");
    } finally {
      bob.cleanup();
    }
    const ops = await laptop(admin);
    try {
      const shared = await ops.seshi(["share", "claude-code", "s1", "--owner", ALICE]);
      expect(shared.code, shared.err).toBe(0);
      expect(await stored("s1")).toBe("org");
    } finally {
      ops.cleanup();
    }
  });

  it("say why there is nothing to share, and refuse what makes no sense", async () => {
    await captured(machine, [{ id: "s1", toggle: "off" }, { id: "fresh" }]);
    const off = await machine.seshi(["share"], { env: { SESHI_SESSION_ID: "s1" } });
    expect(off.code).toBe(1);
    expect(off.err).toContain("Session Capture is off for claude-code s1");
    expect(await stored("s1")).toBe("owner");

    const fresh = await machine.seshi(["share"], { env: { SESHI_SESSION_ID: "fresh" } });
    expect(fresh.code).toBe(4);
    expect(fresh.err).toContain("claude-code/fresh is not in the session store yet");

    expect((await machine.seshi(["share", "claude-code"])).code).toBe(2);
    expect((await machine.seshi(["share", "claude-code", "s1", "extra"])).code).toBe(2);
    expect((await machine.seshi(["share", "claude-code/s1", "--session"])).code).toBe(2);
    expect((await machine.seshi(["share", "--owner", BOB])).code).toBe(2);
    expect((await machine.seshi(["share", "--frobnicate"])).code).toBe(2);
    const help = await machine.seshi(["unshare", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: seshi unshare");
  });
});
