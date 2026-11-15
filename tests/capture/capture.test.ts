/** Capture end to end (F9): `seshi hook` spools, `seshi daemon` uploads to a seshi server served
 * on 127.0.0.1 over its own Instance and temporary folder store, signed in with the org key; a
 * session turned off is retracted with its secret (F9.7); the status line reads only local
 * state (B1.6); `seshi capture` installs into temporary home folders; `seshi upload` sends by
 * hand. Nothing touches the real home folder, keychain or network, and no uploader process is
 * started: the Machine records what would have been spawned, and the test runs the uploader's
 * passes itself (`seshi daemon --once`). */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSession } from "@seshi/pipeline";
import { compileRuleSet, validatePack } from "@seshi/redact";
import { readChanges } from "@seshi/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Machine, startServer, type TestServer } from "../tooling/cli";
import { transcript } from "../tooling/testdata";

const OWNER = "alice@acme.com";
const SESSION = "1f2e3d4c-5b6a-4789-9abc-def012345678";

/** A Claude Code transcript long enough to pass the session filter. */
const HEAD = `${transcript("claude-basic.claude-code.jsonl").trim()}\n${JSON.stringify({
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
/** A short, agent-only tail: the session filter must never judge it (the known gotcha). */
const TAIL = `${JSON.stringify({
  type: "assistant",
  uuid: "a4",
  timestamp: "2026-09-01T00:00:09.000Z",
  sessionId: "sess1",
  message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "Done." }] },
})}\n`;

let server: TestServer;
let machine: Machine;
let orgKey: string;
let project: string;
let file: string;

async function signIn(m: Machine, url: string, key: string, user = OWNER) {
  const login = await m.seshi(["login", "--server", url, "--key", "-", "--user", user], {
    stdin: key,
  });
  expect(login.code, login.err).toBe(0);
}

beforeEach(async () => {
  server = await startServer();
  orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
  machine = new Machine();
  await signIn(machine, server.url, orgKey);
  project = join(machine.dir, "code", "app");
  mkdirSync(project, { recursive: true });
  file = join(machine.dir, ".claude", "projects", "-code-app", `${SESSION}.jsonl`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, HEAD);
});
afterEach(async () => {
  await server.stop();
  machine.cleanup();
});

const stateDir = (m = machine) => join(m.dir, ".local", "state", "seshi");
const state = (m = machine) => JSON.parse(readFileSync(join(stateDir(m), "state.json"), "utf8"));
const spooled = (m = machine) => {
  try {
    return readdirSync(join(stateDir(m), "spool")).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
};

function hook(event = "Stop", extra: Record<string, unknown> = {}, m = machine) {
  return m.seshi(["hook", "claude-code", event], {
    stdin: JSON.stringify({
      session_id: SESSION,
      transcript_path: file,
      cwd: project,
      hook_event_name: event,
      ...extra,
    }),
  });
}

async function daemon(m = machine) {
  const run = await m.seshi(["daemon", "--once", "--json"]);
  return { ...run, summary: run.out ? JSON.parse(run.out) : undefined };
}

const stored = (id = SESSION, owner = OWNER, s = server) =>
  getSession(s.instance.store, owner, "claude-code", id);

describe("hooks and the uploader (F9.1)", () => {
  it("spools, starts the uploader, and the uploader stores the session with its retraction hash", async () => {
    const run = await hook();
    expect(run).toEqual({ code: 0, out: "", err: "" });
    expect(spooled()).toBe(1);
    expect(machine.spawned).toEqual([{ words: ["daemon"], self: true }]);

    const { code, summary } = await daemon();
    expect(code).toBe(0);
    expect(summary).toMatchObject({ taken: 1, uploaded: 1, queued: 0 });
    const metadata = await stored();
    const secret = state().sessions[`claude-code:${SESSION}`].secret as string;
    expect(metadata).toMatchObject({
      owner: OWNER,
      owner_basis: "claimed",
      status: "stored",
      project: "app",
      retract_hash: createHash("sha256").update(secret).digest("hex"),
    });
    expect(state().agents["claude-code"]).toBeDefined();
  });

  it("sends a short agent-only tail as a continuation, never filtered", async () => {
    await hook();
    await daemon();
    appendFileSync(file, TAIL);
    await hook();
    const { summary } = await daemon();
    expect(summary.uploaded).toBe(1);
    const metadata = await stored();
    expect(metadata?.traces).toHaveLength(2);
    expect(metadata?.traces[1]?.continuation).toBeDefined();
    expect(state().sessions[`claude-code:${SESSION}`].file_offset).toBe(
      Buffer.byteLength(HEAD + TAIL),
    );
  });

  it("keeps a short session on the machine until it passes the filter", async () => {
    writeFileSync(file, transcript("claude-basic.claude-code.jsonl"));
    await hook();
    await daemon();
    expect(await stored()).toBeNull();
    expect(state().sessions[`claude-code:${SESSION}`]).toMatchObject({
      stored: false,
      last_status: "filtered",
    });
    writeFileSync(file, HEAD);
    await hook();
    await daemon();
    expect((await stored())?.status).toBe("stored");
  });

  it("does not start a second uploader, and says sign in without a credential", async () => {
    const other = new Machine();
    try {
      mkdirSync(join(other.dir, "code"));
      const run = await hook("Stop", { cwd: join(other.dir, "code") }, other);
      expect(run.code).toBe(0);
      const { code, summary } = await daemon(other);
      expect(code).toBe(5);
      expect(summary.signIn).toContain("not signed in");
      const line = await other.seshi(["statusline"], {
        stdin: JSON.stringify({ session_id: SESSION, cwd: join(other.dir, "code") }),
        env: { NO_COLOR: "1" },
      });
      expect(line.out).toBe("Session Capture ◉ · sign in · 1 queued");
    } finally {
      other.cleanup();
    }
  });

  it("never fails the agent: bad input, unknown agents and events go to the log", async () => {
    expect(await machine.seshi(["hook", "claude-code", "Stop"], { stdin: "not json" })).toEqual({
      code: 0,
      out: "",
      err: "",
    });
    expect((await machine.seshi(["hook", "nope", "Stop"], { stdin: "{}" })).code).toBe(0);
    expect((await machine.seshi(["hook", "claude-code", "Other"], { stdin: "{}" })).code).toBe(0);
    expect((await machine.seshi(["hook"], { stdin: "" })).code).toBe(0);
    const log = readFileSync(join(stateDir(), "capture.log"), "utf8");
    expect(log).toContain("not JSON");
    expect(log).toContain("does not capture 'nope'");
    expect(log).toContain("no 'Other' hook");
    expect(spooled()).toBe(0);
  });

  it("takes Codex's payload from its last argument and runs the notify program that was there", async () => {
    const thread = "01a0ff74-a68d-7ad0-83ee-80cf02c29b14";
    const json = JSON.stringify({ type: "agent-turn-complete", "thread-id": thread, cwd: project });
    const run = await machine.seshi([
      "hook",
      "codex",
      "notify",
      "--",
      "notify-send",
      "Codex",
      json,
    ]);
    expect(run.code).toBe(0);
    expect(machine.spawned[0]).toEqual({ words: ["notify-send", "Codex", json], self: false });
    expect(spooled()).toBe(1);
  });

  it("exports the session for the /seshi skill on SessionStart", async () => {
    const envFile = join(machine.dir, "claude-env");
    await machine.seshi(["hook", "claude-code", "SessionStart"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env: { CLAUDE_ENV_FILE: envFile },
    });
    expect(readFileSync(envFile, "utf8")).toBe(
      `export SESHI_SESSION_ID='${SESSION}'\nexport SESHI_AGENT='claude-code'\n`,
    );
    expect(spooled()).toBe(0);
  });
});

describe("turning a session off (F9.5, F9.7)", () => {
  it("retracts what was uploaded, then uploads it again as a new session when turned on", async () => {
    await hook();
    await daemon();
    machine.spawned.length = 0;
    // The /seshi skill runs this inside Claude Code, where SessionStart set the variables.
    const off = await machine.seshi(["capture", "off", "--session"], {
      env: { SESHI_SESSION_ID: SESSION, SESHI_AGENT: "claude-code" },
    });
    expect(off.code, off.err).toBe(0);
    expect(off.out).toContain("being retracted");
    expect(machine.spawned).toEqual([{ words: ["daemon"], self: true }]);
    // Hooks and the sweep send nothing more of it.
    appendFileSync(file, TAIL);
    await hook();
    expect(spooled()).toBe(1); // the retraction itself, waiting for the uploader

    const { summary } = await daemon();
    expect(summary).toMatchObject({ retracted: 1, uploaded: 0 });
    expect((await stored())?.status).toBe("redacted");
    const { entries } = await readChanges(server.instance.store, OWNER);
    expect(entries.at(-1)?.entry).toMatchObject({
      kind: "tombstone",
      reason: "retracted",
      writer: { kind: "person" },
    });

    const line = await machine.seshi(["statusline"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env: { NO_COLOR: "1" },
    });
    expect(line.out).toBe("Session Capture ⏸");

    const on = await machine.seshi(["capture", "on", "--session", SESSION, "--json"]);
    expect(JSON.parse(on.out)).toMatchObject({ capture: true, fresh: true });
    await daemon();
    expect((await stored(`${SESSION}~1`))?.status).toBe("stored");
  });

  it("covers the session's subagents: retracts what they uploaded and sends nothing more", async () => {
    const sub = join(file.replace(/\.jsonl$/, ""), "subagents", "agent-abc.jsonl");
    mkdirSync(join(sub, ".."), { recursive: true });
    writeFileSync(sub, HEAD);
    const subagentStop = () =>
      hook("SubagentStop", { agent_id: "abc", agent_transcript_path: sub });
    await subagentStop();
    await daemon();
    expect((await stored("agent-abc"))?.status).toBe("stored");

    const off = await machine.seshi(["capture", "off", "--session", SESSION, "--json"]);
    expect(JSON.parse(off.out)).toMatchObject({ capture: false, retracting: true });
    const { summary } = await daemon();
    expect(summary).toMatchObject({ retracted: 2, uploaded: 0 });
    expect((await stored())?.status).toBe("redacted");
    expect((await stored("agent-abc"))?.status).toBe("redacted");

    // A later subagent, and the old one growing: neither hooks nor the sweep send them.
    appendFileSync(sub, TAIL);
    const later = join(sub, "..", "agent-def.jsonl");
    writeFileSync(later, HEAD);
    await subagentStop();
    await hook("SubagentStop", { agent_id: "def", agent_transcript_path: later });
    expect(spooled()).toBe(0);
    // `--once` sweeps too.
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    expect(await stored("agent-def")).toBeNull();
    expect(state().sessions["claude-code:agent-abc"]).toMatchObject({ retract: "done" });
  });

  it("records a retraction the server refuses, and the status line says so", async () => {
    await server.stop();
    server = await startServer({ config: "[capture]\nallow_retract = false\n" });
    orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
    await signIn(machine, server.url, orgKey);
    await hook();
    await daemon();
    await machine.seshi(["capture", "off", "--session", SESSION]);
    await daemon();
    expect(state().sessions[`claude-code:${SESSION}`]).toMatchObject({ retract: "failed" });
    expect((await stored())?.status).toBe("stored");
    const status = await machine.seshi(["capture", "status", "--session", SESSION]);
    expect(status.out).toContain("retraction refused");
    const line = await machine.seshi(["statusline"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env: { NO_COLOR: "1" },
    });
    expect(line.out).toBe("Session Capture ⏸ · retraction refused");
    // Turned back on: the refused retraction is called off, capture goes on.
    await machine.seshi(["capture", "on", "--session", SESSION]);
    const after = state().sessions[`claude-code:${SESSION}`];
    expect(after.retract).toBeUndefined();
    expect(after.retract_error).toBeUndefined();
    const on = await machine.seshi(["statusline"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env: { NO_COLOR: "1" },
    });
    expect(on.out).toBe("Session Capture ◉");
  });

  it("finds the session from the folder when the agent named none, and says when it cannot", async () => {
    await hook();
    await daemon();
    const none = await machine.seshi(["capture", "off", "--session"]);
    // The test runs from the repository, where no session was seen.
    expect(none.code).toBe(2);
    expect(none.err).toContain("which session?");
    const unknown = await machine.seshi(["capture", "off", "--session", "x", "--agent", "vim"]);
    expect(unknown.code).toBe(2);
  });

  it("turns off a session never uploaded without asking the server", async () => {
    const off = await machine.seshi([
      "capture",
      "off",
      "--session",
      "never-seen",
      "--agent",
      "claude-code",
    ]);
    expect(off.out).toContain("Nothing of it was uploaded");
    await daemon();
    expect(state().sessions["claude-code:never-seen"]).toMatchObject({ toggle: "off" });
  });

  it("keeps the transcript of a session turned off before any hook, so a later hook skips it", async () => {
    const off = await machine.seshi(["capture", "off", "--session", SESSION], {
      env: { SESHI_AGENT: "claude-code" },
    });
    expect(off.code, off.err).toBe(0);
    expect(state().sessions[`claude-code:${SESSION}`]).toMatchObject({ toggle: "off", path: file });
    await hook();
    expect(spooled()).toBe(1); // the retract entry only
    await daemon();
    expect(await stored()).toBeNull();
  });
});

describe("the status line (F9.4, B1.6)", () => {
  const status = (env: Record<string, string> = { NO_COLOR: "1" }) =>
    machine.seshi(["statusline"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env,
    });

  it("says Session Capture with ◉ or ⏸, and what needs action after a separator", async () => {
    expect((await status()).out).toBe("Session Capture ◉");
    await hook();
    expect((await status()).out).toBe("Session Capture ◉ · 1 queued");
    await daemon();
    expect((await status()).out).toBe("Session Capture ◉");
    await machine.seshi(["capture", "pause", "2h"]);
    expect((await status()).out).toBe("Session Capture ⏸");
    await machine.seshi(["capture", "resume"]);
    const json = JSON.parse((await machine.seshi(["statusline", "--json"], { stdin: "" })).out);
    expect(json).toMatchObject({ capturing: true, level: "global", problems: [] });
  });

  it("paints the glyph and problems, never only colour", async () => {
    await hook();
    const painted = (await status({})).out;
    expect(painted).toContain("\x1b[");
    const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    expect(painted.replace(sgr, "")).toBe("Session Capture ◉ · 1 queued");
    expect((await machine.seshi(["statusline", "--no-color"], { stdin: "" })).out).not.toContain(
      "\x1b[",
    );
  });

  it("follows a repo that turns capture off", async () => {
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".seshi"));
    writeFileSync(join(project, ".seshi", "config.toml"), "capture = false\n");
    expect((await status()).out).toBe("Session Capture ⏸");
    machine.spawned.length = 0;
    await hook();
    // Only the folder it was seen in, for the uploader to keep: nothing to upload, so no uploader.
    expect(spooled()).toBe(1);
    expect(machine.spawned).toEqual([]);
    await daemon();
    expect(await stored()).toBeNull();
    expect(state().sessions[`claude-code:${SESSION}`]).toMatchObject({ folders: [project] });
    const why = JSON.parse(
      (await machine.seshi(["statusline", "--json"], { stdin: JSON.stringify({ cwd: project }) }))
        .out,
    );
    expect(why).toMatchObject({ capturing: false, level: "repo" });
  });
});

describe("capture rules from the CLI (F9.5)", () => {
  it("pauses and resumes", async () => {
    const pause = await machine.seshi(["capture", "pause", "2h", "--json"]);
    expect(JSON.parse(pause.out).until).toBeDefined();
    await hook();
    expect(spooled()).toBe(0);
    expect((await machine.seshi(["capture", "pause", "soon"])).code).toBe(2);
    expect((await machine.seshi(["capture", "resume"])).out).toContain("resumed");
    await hook();
    expect(spooled()).toBe(2); // the resume's wake-up, and the hook
  });

  it("says a pause holds uploads back, and that what is written meanwhile goes up after", async () => {
    const pause = await machine.seshi(["capture", "pause", "1h"]);
    expect(pause.out).toContain("nothing is uploaded until");
    expect(pause.out).toContain("uploaded when the pause ends");
    expect(pause.out).not.toContain("nothing is captured");
    // Nothing goes while it lasts; the next hook after it sends what was written meanwhile.
    appendFileSync(file, TAIL);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    expect(await stored()).toBeNull();
    await machine.seshi(["capture", "resume"]);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await stored())?.status).toBe("stored");
  });

  it("sets a folder rule and the global level in the CLI config, keeping the rest", async () => {
    machine.cliConfig(`# mine\nserver = "${server.url}"\nuser = "${OWNER}"\n`);
    const off = await machine.seshi(["capture", "off", "--path", project]);
    expect(off.code, off.err).toBe(0);
    const config = () => readFileSync(join(machine.configDir, "config.toml"), "utf8");
    expect(config()).toBe(
      `# mine\nserver = "${server.url}"\nuser = "${OWNER}"\n\n[[capture.paths]]\npath = "~/code/app"\ncapture = false\n`,
    );
    await hook();
    expect(spooled()).toBe(0);
    await machine.seshi(["capture", "on", "--path", "~/code/app"]);
    expect(config()).toContain("capture = true");
    expect(config().match(/\[\[capture\.paths\]\]/g)).toHaveLength(1);
    await machine.seshi(["capture", "off"]);
    expect(config()).toContain("[capture]\nenabled = false\n\n[[capture.paths]]");
    const json = JSON.parse(
      (
        await machine.seshi(["statusline", "--json"], {
          stdin: JSON.stringify({ cwd: machine.dir }),
        })
      ).out,
    );
    expect(json).toMatchObject({ capturing: false, level: "global" });
    await machine.seshi(["capture", "on"]);
    expect(config()).toContain("[capture]\nenabled = true\n");
  });

  it("refuses bad usage", async () => {
    expect((await machine.seshi(["capture"])).code).toBe(2);
    expect((await machine.seshi(["capture", "bogus"])).code).toBe(2);
    expect((await machine.seshi(["capture", "off", "--session", "x", "--path", "/y"])).code).toBe(
      2,
    );
    expect((await machine.seshi(["capture", "off", "--wat"])).code).toBe(2);
  });
});

describe("seshi capture install|uninstall|status (F9.6)", () => {
  it("installs for the agents found here, reports, and removes only its own", async () => {
    mkdirSync(join(machine.dir, ".cursor"), { recursive: true });
    const install = await machine.seshi(["capture", "install", "--json"]);
    expect(install.code, install.err).toBe(0);
    expect(JSON.parse(install.out).installed.map((r: { agent: string }) => r.agent)).toEqual([
      "claude-code",
      "cursor",
    ]);
    const settings = JSON.parse(
      readFileSync(join(machine.dir, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("seshi hook claude-code Stop");
    expect(existsSync(join(machine.dir, ".codex"))).toBe(false);

    const status = JSON.parse((await machine.seshi(["capture", "status", "--json"])).out);
    expect(
      status.agents.map((a: { agent: string; installed: boolean }) => [a.agent, a.installed]),
    ).toEqual([
      ["claude-code", true],
      ["codex", false],
      ["cursor", true],
    ]);
    expect(status.target).toBe(server.url);

    const human = await machine.seshi(["capture", "status"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("Session Capture: capturing");
    expect(human.out).toMatch(/claude-code\s+installed/);

    const uninstall = await machine.seshi(["capture", "uninstall"]);
    expect(uninstall.code).toBe(0);
    expect(JSON.parse(readFileSync(join(machine.dir, ".claude", "settings.json"), "utf8"))).toEqual(
      {},
    );
    expect(state().agents).toEqual({});
  });

  it("installs the agents it can and reports one whose config it cannot read", async () => {
    mkdirSync(join(machine.dir, ".cursor"));
    writeFileSync(join(machine.dir, ".cursor", "hooks.json"), "{ broken");
    const run = await machine.seshi(["capture", "install", "--json"]);
    expect(run.code).toBe(1);
    const report = JSON.parse(run.out);
    expect(report.installed.map((r: { agent: string }) => r.agent)).toEqual(["claude-code"]);
    expect(report.failed[0]).toMatchObject({ agent: "cursor" });
    expect(report.failed[0].error).toContain("not valid JSON");
    expect(readFileSync(join(machine.dir, ".cursor", "hooks.json"), "utf8")).toBe("{ broken");
  });

  it("installs a named agent, refuses an unknown one, and says when it finds none", async () => {
    const fresh = new Machine();
    try {
      expect((await fresh.seshi(["capture", "install"])).code).toBe(4);
      expect((await fresh.seshi(["capture", "install", "vim"])).code).toBe(2);
      const codex = await fresh.seshi(["capture", "install", "codex", "--command", "/opt/seshi"]);
      expect(codex.code, codex.err).toBe(0);
      expect(codex.out).toContain("Not signed in yet");
      expect(readFileSync(join(fresh.dir, ".codex", "config.toml"), "utf8")).toContain(
        'notify = ["/opt/seshi","hook","codex","notify"]',
      );
    } finally {
      fresh.cleanup();
    }
  });

  it("adds and removes the service entry through the OS's service manager", async () => {
    const install = await machine.seshi([
      "capture",
      "install",
      "claude-code",
      "--service",
      "--command",
      "/opt/seshi",
    ]);
    expect(install.code, install.err).toBe(0);
    const programs = machine.executed.map((w) => w[0]);
    if (process.platform === "darwin") {
      expect(programs).toContain("launchctl");
      expect(
        readFileSync(
          join(machine.dir, "Library", "LaunchAgents", "dev.seshi.uploader.plist"),
          "utf8",
        ),
      ).toContain("<string>--keep-alive</string>");
    } else if (process.platform === "linux") {
      expect(programs).toContain("systemctl");
      expect(
        readFileSync(
          join(machine.dir, ".config", "systemd", "user", "seshi-uploader.service"),
          "utf8",
        ),
      ).toContain("ExecStart=/opt/seshi daemon --keep-alive");
    }
    const status = JSON.parse((await machine.seshi(["capture", "status", "--json"])).out);
    if (process.platform !== "win32") expect(status.uploader.service).toBe(true);
    expect((await machine.seshi(["capture", "uninstall", "--service"])).code).toBe(0);
  });
});

describe("seshi upload (F8.1)", () => {
  it("sends a transcript by hand, through the same rules and state", async () => {
    const run = await machine.seshi(["upload", file, "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(JSON.parse(run.out).sessions).toEqual([
      { path: file, key: `claude-code:${SESSION}`, result: "uploaded" },
    ]);
    expect((await stored())?.status).toBe("stored");
    // It can be retracted like a hooked one.
    await machine.seshi(["capture", "off", "--session", SESSION]);
    await daemon();
    expect((await stored())?.status).toBe("redacted");
  });

  it("backfills on purpose with --since, and skips what is not a transcript", async () => {
    const other = join(machine.dir, "notes.json");
    writeFileSync(other, "{}");
    const skipped = await machine.seshi(["upload", other]);
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain("skipped");
    const backfill = await machine.seshi(["upload", "--since", "3650d", "--agent", "claude-code"]);
    expect(backfill.code, backfill.err).toBe(0);
    expect(backfill.out).toContain("uploaded");
    expect((await stored())?.status).toBe("stored");
    expect((await machine.seshi(["upload"])).code).toBe(2);
    expect((await machine.seshi(["upload", "--since", "lots"])).code).toBe(2);
  });

  it("exits 5 when not signed in", async () => {
    const other = new Machine();
    try {
      const run = await other.seshi(["upload", file]);
      expect(run.code).toBe(5);
      expect(run.out).toContain("sign in");
    } finally {
      other.cleanup();
    }
  });
});

describe("local mode (X3.5)", () => {
  it("uploads to your own bucket and retracts there", async () => {
    const local = new Machine();
    try {
      const toml = join(local.dir, "seshi.toml");
      writeFileSync(toml, `[store]\nurl = "file://${join(local.dir, "bucket")}"\n`, {
        mode: 0o600,
      });
      local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
      const code = join(local.dir, "code");
      mkdirSync(code);
      const localFile = join(local.dir, "l1.jsonl");
      writeFileSync(localFile, HEAD);
      await local.seshi(["hook", "claude-code", "Stop"], {
        stdin: JSON.stringify({ session_id: "l1", transcript_path: localFile, cwd: code }),
      });
      const { summary } = await daemon(local);
      expect(summary).toMatchObject({ uploaded: 1 });
      const ls = await local.seshi(["sessions", "ls"]);
      expect(ls.out).toContain("claude-code/l1");
      await local.seshi(["capture", "off", "--session", "l1"]);
      expect((await daemon(local)).summary).toMatchObject({ retracted: 1 });
      const show = await local.seshi(["sessions", "show", "claude-code/l1", "--json"]);
      expect(JSON.parse(show.out).status).toBe("redacted");
    } finally {
      local.cleanup();
    }
  });
});

describe("pre-redaction before upload (F2.4)", () => {
  const acme = compileRuleSet({
    packs: [
      validatePack(
        { id: "acme", rules: [{ id: "acme-key", pattern: "ACME-\\d{4}" }] },
        { source: "acme.toml" },
      ),
    ],
  });
  const line = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`;
  /** A head with an org-rule secret in a prompt and a call reading `.env`, whose result only
   * comes in the next piece. */
  const head = `${HEAD}${line({
    type: "user",
    uuid: "u9",
    parentUuid: "a3",
    timestamp: "2026-09-01T00:00:08.500Z",
    sessionId: "sess1",
    message: { role: "user", content: "deploy with ACME-1234 please" },
  })}${line({
    type: "assistant",
    uuid: "a9",
    parentUuid: "u9",
    timestamp: "2026-09-01T00:00:08.600Z",
    sessionId: "sess1",
    message: {
      role: "assistant",
      model: "claude-x",
      content: [{ type: "tool_use", id: "toolu_env", name: "Read", input: { file_path: ".env" } }],
    },
  })}`;
  const tail = `${line({
    type: "user",
    uuid: "u10",
    parentUuid: "a9",
    timestamp: "2026-09-01T00:00:09.000Z",
    sessionId: "sess1",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_env", content: "API_PASS=hunter2hunter2" },
      ],
    },
  })}${line({
    type: "assistant",
    uuid: "a10",
    parentUuid: "u10",
    timestamp: "2026-09-01T00:00:09.500Z",
    sessionId: "sess1",
    message: { role: "assistant", model: "claude-x", content: "Rotated ACME-5678 too." },
  })}`;

  const uploads = () =>
    server.requests.filter((r) => r.method === "POST" && r.path === "/v1/sessions");
  const rulesFetches = () => server.requests.filter((r) => r.path === "/v1/redaction/rules");

  it("redacts every piece with the org's rules before it leaves, and fetches them again only when changed", async () => {
    await server.stop();
    server = await startServer({ redaction: acme });
    orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
    await signIn(machine, server.url, orgKey);
    writeFileSync(file, head);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });

    const first = uploads()[0];
    expect(first?.body).not.toContain("ACME-1234");
    expect(first?.body).toContain("[redacted:acme-key]");
    expect(rulesFetches()).toMatchObject([{ status: 200 }]);
    expect(rulesFetches()[0]?.headers["if-none-match"]).toBeUndefined();
    expect(existsSync(join(stateDir(), "redaction-rules.json"))).toBe(true);
    // The withheld call stays with the session for the next piece, and the server's offset is
    // counted in redacted bytes.
    const key = `claude-code:${SESSION}`;
    expect(state().sessions[key]).toMatchObject({
      carried: { toolu_env: "sensitive-file" },
      aligned: false,
      file_offset: Buffer.byteLength(head),
    });
    // The server found nothing more of the org's rules to take out: the client already had.
    const metadata = await stored();
    expect(metadata?.redaction?.rule_set).toBe(acme.hash);
    expect(metadata?.redaction?.counts["acme-key"]).toBeUndefined();

    // The next run asks with the ETag (304), and the chunk withholds the .env call's result.
    appendFileSync(file, tail);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect(rulesFetches().map((r) => r.status)).toEqual([200, 304]);
    expect(rulesFetches()[1]?.headers["if-none-match"]).toBe(`"${acme.hash}"`);
    const chunk = JSON.parse(uploads()[1]?.body ?? "{}");
    expect(chunk.offset).toBe(Buffer.byteLength(JSON.parse(first?.body ?? "{}").transcript));
    expect(chunk.transcript).not.toContain("hunter2");
    expect(chunk.transcript).not.toContain("ACME-5678");
    const after = await stored();
    expect(after?.traces).toHaveLength(2);
    expect(after?.traces[1]?.continuation).toBeDefined();
    expect(state().sessions[key].file_offset).toBe(Buffer.byteLength(head + tail));
  });

  it("fetches a server's rules once per run, and none in local mode (the Instance redacts)", async () => {
    await hook();
    await daemon();
    expect(rulesFetches()).toHaveLength(1);
    const local = new Machine();
    try {
      const toml = join(local.dir, "seshi.toml");
      writeFileSync(toml, `[store]\nurl = "file://${join(local.dir, "bucket")}"\n`);
      local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
      const localFile = join(local.dir, "l1.jsonl");
      writeFileSync(localFile, head);
      await local.seshi(["hook", "claude-code", "Stop"], {
        stdin: JSON.stringify({ session_id: "l1", transcript_path: localFile, cwd: local.dir }),
      });
      expect((await daemon(local)).summary).toMatchObject({ uploaded: 1 });
      expect(existsSync(join(stateDir(local), "redaction-rules.json"))).toBe(false);
    } finally {
      local.cleanup();
    }
  });

  /** The served instance behind a proxy that answers the rules route itself when told to: a
   * server from before the route (404), or one that cannot serve it for now (503). */
  async function behindProxy() {
    const mode: { rules: "pass" | 404 | 503; seen: number[] } = { rules: "pass", seen: [] };
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/v1/redaction/rules" && mode.rules !== "pass") {
          mode.seen.push(mode.rules);
          return Response.json({ error: { code: "x", message: "no" } }, { status: mode.rules });
        }
        const body = ["GET", "HEAD"].includes(request.method)
          ? undefined
          : await request.arrayBuffer();
        const answer = await fetch(`${server.url}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body,
        });
        if (url.pathname === "/v1/redaction/rules") mode.seen.push(answer.status);
        return answer;
      },
    });
    await server.stop();
    server = await startServer({ redaction: acme });
    orgKey = (await server.auth.initAdmin({ owner: "ops" })).org_key?.token as string;
    await signIn(machine, `http://127.0.0.1:${proxy.port}`, orgKey);
    return { mode, stop: () => proxy.stop(true) };
  }

  it("pre-redacts with the built-in pack against a server without the rules route", async () => {
    const proxy = await behindProxy();
    try {
      proxy.mode.rules = 404;
      writeFileSync(file, head);
      await hook();
      expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
      // The built-in pack withheld the .env call; the org's own rule was not known here.
      expect(state().sessions[`claude-code:${SESSION}`].carried).toEqual({
        toolu_env: "sensitive-file",
      });
      expect(uploads()[0]?.body).toContain("ACME-1234");
      expect(existsSync(join(stateDir(), "redaction-rules.json"))).toBe(false);
    } finally {
      proxy.stop();
    }
  });

  it("uses the rules fetched before when the server cannot serve them, and waits with none", async () => {
    const proxy = await behindProxy();
    try {
      proxy.mode.rules = 503;
      writeFileSync(file, head);
      await hook();
      // No rules yet and none kept: nothing is sent, as when an upload fails for a while.
      expect((await daemon()).summary).toMatchObject({ uploaded: 0, failed: 1 });
      expect(uploads()).toHaveLength(0);
      expect(state().sessions[`claude-code:${SESSION}`].failures).toBe(1);

      // Fetched once, then unavailable: the next run redacts with the kept document.
      const other = join(machine.dir, ".claude", "projects", "-code-app", "s2.jsonl");
      writeFileSync(other, head.replaceAll("sess1", "s2"));
      await hook("Stop", { session_id: "s2", transcript_path: other });
      proxy.mode.rules = "pass";
      expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
      proxy.mode.rules = 503;
      appendFileSync(other, tail.replaceAll("sess1", "s2"));
      await hook("Stop", { session_id: "s2", transcript_path: other });
      expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
      expect(proxy.mode.seen).toEqual([503, 200, 503]);
      const chunk = JSON.parse(uploads()[1]?.body ?? "{}");
      expect(chunk.session_id).toBe("s2");
      expect(chunk.transcript).not.toContain("ACME-5678");
      expect(chunk.transcript).not.toContain("hunter2");
    } finally {
      proxy.stop();
    }
  });
});
