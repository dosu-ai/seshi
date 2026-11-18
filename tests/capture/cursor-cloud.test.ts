/** Cursor Cloud agents (F9): seshi's hooks committed to a repository, run as Cursor runs them on
 * the VM (the command line in `.cursor/hooks.json`, through `sh`, and `seshi hook cursor <event>
 * --cloud` in-process), upload before the hook returns to a seshi server on 127.0.0.1, signed in
 * with a device token an admin minted for the cloud owner. On every other machine the same hooks
 * do nothing. A follow-up on a rebuilt VM, whose upload state is gone, extends the stored session
 * or, when its transcript does not start with it, continues it as a new session. */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSession } from "@seshi/pipeline";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";

const OWNER = "cursor-cloud";
const CONVERSATION = "c0ffee00-1111-4222-8333-444455556666";

const turn = (n: number, details = 400) =>
  `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: `Step ${n}: how does auth work?` }] } })}\n${JSON.stringify(
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: `Step ${n}, the auth flow: ${"details ".repeat(details)}` },
        ],
      },
    },
  )}\n`;

let server: TestServer;
let vm: Machine;
let workspace: string;
let transcriptFile: string;
let deviceToken: string;

const stateDir = (m: Machine) => join(m.dir, ".local", "state", "seshi");
const stored = (id = CONVERSATION) => getSession(server.instance.store, OWNER, "cursor", id);

/** What `sh .cursor/seshi-cloud.sh start` does on every run: mark the VM, sign in. */
async function start(m: Machine) {
  const mark = await m.seshi(["capture", "install", "cursor", "--cloud"]);
  expect(mark.code, mark.err).toBe(0);
  const login = await m.seshi(["login", "--server", server.url, "--token", "-"], {
    stdin: deviceToken,
  });
  expect(login.code, login.err).toBe(0);
}

function payload(event: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    conversation_id: CONVERSATION,
    generation_id: "g1",
    hook_event_name: event,
    workspace_roots: [workspace],
    // Cursor Cloud has sent none (forum, 2026-09); seshi finds the transcript itself.
    transcript_path: null,
    user_email: "alice@acme.com",
    ...extra,
  });
}

const CLOUD_FLAG = "--cloud";

/** The command line `seshi capture install cursor --project` committed for `event`, as Cursor
 * runs it. */
async function committed(event: string): Promise<string> {
  const file = join(workspace, ".cursor", "hooks.json");
  if (!existsSync(file)) {
    const install = await vm.seshi(["capture", "install", "cursor", "--project", workspace]);
    expect(install.code, install.err).toBe(0);
  }
  const ours = JSON.parse(readFileSync(file, "utf8")).hooks[event] as { command: string }[];
  expect(ours).toHaveLength(1);
  return (ours[0] as { command: string }).command;
}

const hook = (
  m: Machine,
  event: string,
  extra: Record<string, unknown> = {},
  flags = [CLOUD_FLAG],
) => m.seshi(["hook", "cursor", event, ...flags], { stdin: payload(event, extra) });

beforeEach(async () => {
  server = await startServer();
  const adminToken = (await server.auth.initAdmin({ owner: "ops" })).admin?.token as string;
  // The admin mints the cloud owner's token, as docs/capture.md says.
  const admin = new Machine();
  expect(
    (await admin.seshi(["login", "--server", server.url, "--token", "-"], { stdin: adminToken }))
      .code,
  ).toBe(0);
  const minted = await admin.seshi([
    "tokens",
    "create",
    "device",
    "--owner",
    OWNER,
    "--expires",
    "365d",
    "--label",
    "Cursor Cloud agents",
    "--json",
  ]);
  expect(minted.code, minted.err).toBe(0);
  deviceToken = JSON.parse(minted.out).token;
  admin.cleanup();

  vm = new Machine();
  workspace = join(vm.dir, "workspace");
  mkdirSync(join(workspace, ".git"), { recursive: true });
  const dir = join(vm.dir, ".cursor", "projects", "workspace", "agent-transcripts", CONVERSATION);
  mkdirSync(dir, { recursive: true });
  transcriptFile = join(dir, `${CONVERSATION}.jsonl`);
  writeFileSync(transcriptFile, turn(1));
  await start(vm);
});

afterEach(async () => {
  await server.stop();
  vm.cleanup();
});

describe("a Cursor Cloud agent's stop", () => {
  it("uploads before the hook returns, under the cloud owner, starting no uploader", async () => {
    const run = await hook(vm, "stop", { status: "completed", loop_count: 0 });
    expect(run).toEqual({ code: 0, out: "", err: "" });
    expect(vm.spawned).toEqual([]);
    expect(await stored()).toMatchObject({
      owner: OWNER,
      owner_basis: "verified",
      status: "stored",
      project: "workspace",
    });
    const files = readdirSync(join(stateDir(vm), "spool")).filter((n) => n.endsWith(".json"));
    expect(files).toEqual([]);
  });

  it("says on stderr why it did not upload, the token's expiry plainly", async () => {
    const logins = join(vm.configDir, "logins.json");
    const file = JSON.parse(readFileSync(logins, "utf8"));
    expect(file.logins[server.url].token_expires_at).toMatch(/^\d{4}-/);
    file.logins[server.url].token_expires_at = "2026-01-01T00:00:00.000Z";
    writeFileSync(logins, JSON.stringify(file));
    const run = await hook(vm, "stop");
    expect(run.code).toBe(0);
    expect(run.out).toBe("");
    expect(run.err).toContain(`seshi: cursor:${CONVERSATION} was not uploaded: the token for`);
    expect(run.err).toContain("expired 2026-01-01");
    expect(run.err).toContain("SESHI_TOKEN");
    expect(await stored()).toBeNull();
    expect(readFileSync(join(stateDir(vm), "capture.log"), "utf8")).toContain("expired 2026-01-01");
  });

  it("is turned off by /session-capture off in the cloud chat, retracting what it uploaded", async () => {
    await hook(vm, "stop");
    expect((await stored())?.status).toBe("stored");
    const off = await hook(vm, "beforeSubmitPrompt", { prompt: "/session-capture off" });
    expect(JSON.parse(off.out)).toEqual({
      continue: false,
      user_message:
        "Session Capture ⏸ · turned off for this session; what it uploaded is being retracted",
    });
    expect(vm.spawned).toEqual([]);
    // Retracted before the hook returned, not left to an uploader.
    expect((await stored())?.status).toBe("redacted");
    writeFileSync(transcriptFile, turn(1) + turn(2));
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    expect((await stored())?.status).toBe("redacted");
  });
});

describe("the committed hooks on any other machine", () => {
  it("do nothing: no spool, no uploader, no output, exit 0", async () => {
    const laptop = new Machine();
    try {
      for (const event of ["stop", "sessionEnd", "beforeSubmitPrompt"]) {
        const run = await hook(laptop, event, { prompt: "/session-capture off" });
        expect(run).toEqual({ code: 0, out: "", err: "" });
      }
      expect(laptop.spawned).toEqual([]);
      expect(existsSync(stateDir(laptop))).toBe(false);
    } finally {
      laptop.cleanup();
    }
  });

  it("exit 0 with nothing said through the shell when seshi is not on the machine", async () => {
    const home = join(vm.dir, "no-seshi-home");
    mkdirSync(home);
    for (const event of ["stop", "sessionEnd", "beforeSubmitPrompt"]) {
      const run = spawnSync("/bin/sh", ["-c", await committed(event)], {
        cwd: workspace,
        env: { PATH: "/usr/bin:/bin", HOME: home },
        input: payload(event),
        encoding: "utf8",
      });
      expect({ status: run.status, out: run.stdout, err: run.stderr }).toEqual({
        status: 0,
        out: "",
        err: "",
      });
    }
  });

  it("start no seshi off a marked VM, and on one run the seshi on the PATH or where the setup script puts it", async () => {
    const home = join(vm.dir, "fake-home");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const seen = join(home, "seen");
    const fake = join(bin, "seshi");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" > "${seen}"\ncat >> "${seen}"\n`);
    chmodSync(fake, 0o755);
    const command = await committed("stop");
    const run = (env: Record<string, string> = {}) =>
      spawnSync("/bin/sh", ["-c", command], {
        cwd: workspace,
        env: { PATH: "/usr/bin:/bin", HOME: home, ...env },
        input: "{}",
        encoding: "utf8",
      });
    // A teammate's laptop: seshi is there, but no marker, so it never starts.
    expect(run().status).toBe(0);
    expect(existsSync(seen)).toBe(false);
    // A marked VM, the marker where seshi's state folder is (XDG_STATE_HOME moves it).
    const state = join(home, "state");
    mkdirSync(join(state, "seshi"), { recursive: true });
    writeFileSync(join(state, "seshi", "cursor-cloud"), "");
    expect(run().status).toBe(0);
    expect(existsSync(seen)).toBe(false);
    expect(run({ XDG_STATE_HOME: state }).status).toBe(0);
    expect(readFileSync(seen, "utf8")).toBe("hook cursor stop --cloud\n{}");
  });

  it("stand aside for each other: the user-level hook does nothing on a cloud VM", async () => {
    const run = await hook(vm, "stop", {}, []);
    expect(run).toEqual({ code: 0, out: "", err: "" });
    expect(vm.spawned).toEqual([]);
    expect(await stored()).toBeNull();
  });
});

describe("a cloud VM whose uploads failed or whose transcript was rewritten", () => {
  const statePath = () => join(stateDir(vm), "state.json");
  const key = `cursor:${CONVERSATION}`;

  it("tries again at the next stop, not after the background uploader's backoff", async () => {
    await hook(vm, "stop");
    const first = await stored();
    const s = JSON.parse(readFileSync(statePath(), "utf8"));
    s.sessions[key].next_attempt_at = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(statePath(), JSON.stringify(s), { mode: 0o600 });
    writeFileSync(transcriptFile, turn(1) + turn(2));
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    expect((await stored())?.normalized?.records).toBeGreaterThan(first?.normalized?.records ?? 0);
  });

  it("retracts what it stored before a continuation too, when the chat turns capture off", async () => {
    await hook(vm, "stop");
    // The VM keeps its state, but the transcript, now shorter, no longer starts with what was
    // stored.
    writeFileSync(transcriptFile, turn(2, 300));
    await hook(vm, "stop");
    expect((await stored(`${CONVERSATION}~r1`))?.status).toBe("stored");
    expect(JSON.parse(readFileSync(statePath(), "utf8")).sessions[key].retract_also).toEqual([
      CONVERSATION,
    ]);
    const off = await hook(vm, "beforeSubmitPrompt", { prompt: "/session-capture off" });
    expect(off.err).toBe("");
    expect((await stored())?.status).toBe("redacted");
    expect((await stored(`${CONVERSATION}~r1`))?.status).toBe("redacted");
  });
});

describe("a follow-up on a VM rebuilt without seshi's upload state", () => {
  const rebuild = async () => {
    rmSync(stateDir(vm), { recursive: true, force: true });
    await start(vm);
  };

  it("extends the stored session when the transcript holds the whole conversation", async () => {
    await hook(vm, "stop");
    const first = await stored();
    await rebuild();
    writeFileSync(transcriptFile, turn(1) + turn(2));
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    const after = await stored();
    expect(after?.normalized?.records).toBeGreaterThan(first?.normalized?.records ?? 0);
    expect(after?.traces.length).toBe(2);
  });

  it("continues it as a new session when the transcript holds only the new run", async () => {
    await hook(vm, "stop");
    const first = await stored();
    await rebuild();
    writeFileSync(transcriptFile, turn(2));
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    // The stored session is never shortened or overwritten.
    expect(await stored()).toEqual(first);
    expect(await stored(`${CONVERSATION}~r1`)).toMatchObject({
      status: "stored",
      parent_session_id: CONVERSATION,
    });
    // The next stop on the same VM extends the continuation.
    writeFileSync(transcriptFile, turn(2) + turn(3));
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    expect((await stored(`${CONVERSATION}~r1`))?.traces.length).toBe(2);
  });
});

describe("seshi capture install cursor --project", () => {
  it("writes the repository's hooks and setup script, says what to add, and takes them out", async () => {
    const install = await vm.seshi(["capture", "install", "cursor", "--project", workspace]);
    expect(install.code, install.err).toBe(0);
    expect(install.out).toContain(join(workspace, ".cursor", "hooks.json"));
    expect(install.out).toContain("sh .cursor/seshi-cloud.sh start");
    expect(install.out).toContain("They hold no token or server URL.");
    const status = JSON.parse(
      (await vm.seshi(["capture", "status", "--project", workspace, "--json"])).out,
    );
    expect(status.agents).toEqual([
      expect.objectContaining({
        agent: "cursor",
        cloud_vm: true,
        status: expect.objectContaining({ installed: true }),
      }),
    ]);
    const removed = await vm.seshi(["capture", "uninstall", "cursor", "--project", workspace]);
    expect(removed.code, removed.err).toBe(0);
    expect(existsSync(join(workspace, ".cursor", "seshi-cloud.sh"))).toBe(false);
  });

  it("refuses the home folder, whose .cursor is the user-level config", async () => {
    const run = await vm.seshi(["capture", "install", "cursor", "--project", vm.dir]);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("not the home folder");
    expect(existsSync(join(vm.dir, ".cursor", "hooks.json"))).toBe(false);
  });

  it("unmarks the VM with uninstall --cloud", async () => {
    expect((await vm.seshi(["capture", "uninstall", "cursor", "--cloud"])).code).toBe(0);
    expect(await hook(vm, "stop")).toEqual({ code: 0, out: "", err: "" });
    expect(await stored()).toBeNull();
  });
});
