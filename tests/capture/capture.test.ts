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
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  addOpencodeTurn,
  type OpencodeExport,
  opencodeSessionAt,
  writeOpencodeDb,
  writeOpencodeDbV2,
} from "@seshi/integration-opencode/testing";
import { VERSION } from "@seshi/model";
import { getSession } from "@seshi/pipeline";
import { compileRuleSet, validatePack } from "@seshi/redact";
import { archiveId, ensureLayout, FsStore, keys, readChanges } from "@seshi/store";
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
/** A stale rebuild waits a random time within a day (26): move its time to now, as if that had
 * passed, keeping what the uploader decided otherwise. */
const rebuildDueNow = (key: string, m = machine) => {
  const s = state(m);
  const rebuild = s.sessions[key].rebuild;
  expect(Date.parse(rebuild.not_before)).toBeGreaterThan(Date.now() - 60_000);
  rebuild.not_before = new Date(0).toISOString();
  writeFileSync(join(stateDir(m), "state.json"), JSON.stringify(s), { mode: 0o600 });
};
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

  it("claims the git identity of the home the command runs in, not the process's", async () => {
    writeFileSync(
      join(machine.dir, ".gitconfig"),
      "[user]\n\temail = dev@machine.test\n\tname = Machine Dev\n",
    );
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await stored())?.claims).toMatchObject({
      git_email: "dev@machine.test",
      git_name: "Machine Dev",
    });
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

  it("tells Codex on SessionStart whether the session is captured, spooling nothing", async () => {
    const start = () =>
      machine.seshi(["hook", "codex", "SessionStart"], {
        stdin: JSON.stringify({
          session_id: "thread-1",
          cwd: project,
          source: "startup",
          hook_event_name: "SessionStart",
        }),
      });
    const on = await start();
    expect(on.code).toBe(0);
    expect(JSON.parse(on.out).systemMessage).toMatch(
      /^Session Capture ◉ · .*\$session-capture off stops it$/,
    );
    expect(spooled()).toBe(0);
    expect(machine.spawned).toEqual([]);
    await machine.seshi(["capture", "pause", "1h"]);
    expect(JSON.parse((await start()).out).systemMessage).toBe(
      "Session Capture ⏸ · capture is paused: the session stops where it is",
    );
  });

  it("does $session-capture off|on|status typed in Codex itself, outside the agent's sandbox", async () => {
    const say = (prompt: string) =>
      machine.seshi(["hook", "codex", "UserPromptSubmit"], {
        stdin: JSON.stringify({ session_id: "thread-2", cwd: project, prompt }),
      });
    expect(await say("fix the tests")).toEqual({ code: 0, out: "", err: "" });
    const off = await say("$session-capture off");
    expect(JSON.parse(off.out).systemMessage).toBe(
      "Session Capture ⏸ · turned off for this session; nothing of it was uploaded",
    );
    expect(state().sessions["codex:thread-2"]).toMatchObject({ toggle: "off" });
    expect(JSON.parse((await say("$session-capture")).out).systemMessage).toBe(
      "Session Capture ⏸ · turned off for this session",
    );
    const on = await say("$session-capture on");
    expect(JSON.parse(on.out).systemMessage).toMatch(
      /^Session Capture ◉ · turned on for this session/,
    );
    expect(state().sessions["codex:thread-2"]).toMatchObject({ toggle: "on" });
  });

  it("does /session-capture typed in Cursor itself, answering in place of the stopped prompt", async () => {
    const say = (prompt: string) =>
      machine.seshi(["hook", "cursor", "beforeSubmitPrompt"], {
        stdin: JSON.stringify({ conversation_id: "conv-1", workspace_roots: [project], prompt }),
      });
    expect(await say("explain this file")).toEqual({ code: 0, out: "", err: "" });
    expect(JSON.parse((await say("/session-capture")).out).user_message).toBe(
      "Session Capture ◉ · this session is uploaded to your team's session store as you work; /session-capture off stops it",
    );
    expect(JSON.parse((await say("/session-capture off")).out)).toEqual({
      continue: false,
      user_message: "Session Capture ⏸ · turned off for this session; nothing of it was uploaded",
    });
    expect(state().sessions["cursor:conv-1"]).toMatchObject({ toggle: "off" });
    // The Cursor CLI's status line reads the same session from its own payload.
    const line = await machine.seshi(["statusline", "--agent", "cursor"], {
      stdin: JSON.stringify({ session_id: "conv-1", cwd: project }),
      env: { NO_COLOR: "1" },
    });
    expect(line.out).toMatch(/^Session Capture ⏸/);
    expect(JSON.parse((await say("/session-capture")).out)).toEqual({
      continue: false,
      user_message: "Session Capture ⏸ · turned off for this session",
    });
    expect(JSON.parse((await say("/session-capture on")).out).user_message).toMatch(
      /^Session Capture ◉ · turned on for this session/,
    );
  });

  it("tells an editor which Cursor conversation its folder is on, and whether it is captured", async () => {
    const prompt = (conversation: string, text: string) =>
      machine.seshi(["hook", "cursor", "beforeSubmitPrompt"], {
        stdin: JSON.stringify({
          conversation_id: conversation,
          workspace_roots: [project],
          prompt: text,
        }),
      });
    const ask = async (...flags: string[]) =>
      JSON.parse(
        (
          await machine.seshi([
            "statusline",
            "--agent",
            "cursor",
            "--json",
            "--folder",
            project,
            ...flags,
          ])
        ).out,
      );
    const none = await ask();
    expect(none).toMatchObject({ session: null, candidates: [], capturing: true });
    expect(none.watch).toEqual([stateDir(), join(stateDir(), "recent"), expect.any(String)]);
    await prompt("conv-a", "fix the tests");
    await prompt("conv-b", "explain this file");
    expect((await ask()).session).toMatchObject({ session_id: "conv-b", by: "prompt" });
    // The editor's own answer wins: the chat with focus, else the only one open.
    expect((await ask("--session", "conv-a", "--selected", "conv-a,conv-b")).session).toEqual({
      session_id: "conv-a",
      by: "focused",
    });
    expect((await ask("--selected", "conv-new")).session).toEqual({
      session_id: "conv-new",
      by: "selected",
    });
    await prompt("conv-a", "/session-capture off");
    const off = await ask("--session", "conv-a");
    expect(off).toMatchObject({ capturing: false, level: "session", attention: null });
    expect(off.session.state).toBe("off");
  });

  it("exports the session for the /session-capture skill on SessionStart", async () => {
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
    // The /session-capture skill runs this inside Claude Code, where SessionStart set the variables.
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

  it("does not call off a retraction still waiting when turned on: it may have landed", async () => {
    // Found by the scenario explorer (33): the tombstone landed but its answer was lost; turned
    // on, the waiting retraction was called off and every later upload met the tombstone
    // (422 redacted) while this machine thought the session live.
    await hook();
    await daemon();
    await machine.seshi(["capture", "off", "--session", SESSION]);
    const on = await machine.seshi(["capture", "on", "--session", SESSION, "--json"]);
    expect(JSON.parse(on.out)).toMatchObject({ capture: true, fresh: true });
    expect(state().sessions[`claude-code:${SESSION}`]).toMatchObject({ retract: "pending" });
    const { summary } = await daemon();
    expect(summary).toMatchObject({ retracted: 1, queued: 1 });
    // The fresh upload goes on the next pass.
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await stored())?.status).toBe("redacted");
    expect((await stored(`${SESSION}~1`))?.status).toBe("stored");
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
    // Only that session: not the folder, the agents or the other sessions.
    expect(status.out).toContain(`session claude-code ${SESSION}: turned off for this session`);
    expect(status.out).not.toContain("here (");
    expect(status.out).not.toContain("agents:");
    expect(status.out).not.toContain("recent sessions:");
    const all = await machine.seshi(["capture", "status"]);
    expect(all.out).toContain("agents:");
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
  it("keeps no copy of an OpenCode session turned off, or once OpenCode is uninstalled", async () => {
    // OpenCode keeps no transcript file: its plugin hands seshi the session, which seshi writes
    // to its own folder and must not keep for a session turned off.
    const opencode = (session: string) =>
      machine.seshi(["hook", "opencode", "Stop"], {
        stdin: JSON.stringify({
          session_id: session,
          cwd: join(machine.dir, "code"),
          export: { info: { id: session, directory: join(machine.dir, "code") }, messages: [] },
        }),
      });
    const copy = (session: string) =>
      join(stateDir(), "transcripts", "opencode", `${session}.json`);
    expect((await opencode("ses_a")).code).toBe(0);
    expect((await opencode("ses_b")).code).toBe(0);
    expect(existsSync(copy("ses_a"))).toBe(true);

    const off = await machine.seshi([
      "capture",
      "off",
      "--session",
      "ses_a",
      "--agent",
      "opencode",
    ]);
    expect(off.code, off.err).toBe(0);
    expect(existsSync(copy("ses_a"))).toBe(false);
    // Its next turn is not written either.
    await opencode("ses_a");
    expect(existsSync(copy("ses_a"))).toBe(false);
    expect(existsSync(copy("ses_b"))).toBe(true);

    expect((await machine.seshi(["capture", "uninstall", "opencode"])).code).toBe(0);
    expect(existsSync(join(stateDir(), "transcripts", "opencode"))).toBe(false);
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

  it.skipIf(process.platform === "win32")(
    "runs the status line it was chained to first, with the same payload",
    async () => {
      const script = join(machine.dir, "theirs.sh");
      writeFileSync(script, '#!/bin/sh\nprintf "dosu: %s" "$(cat | grep -o \'"cwd"\')"\n', {
        mode: 0o755,
      });
      const chain = join(machine.dir, "chain.json");
      const chained = (command: string) => {
        writeFileSync(chain, JSON.stringify({ statusLine: { type: "command", command } }));
        return machine.seshi(["statusline", "--chain", chain], {
          stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
          env: { NO_COLOR: "1" },
        });
      };
      expect((await chained(script)).out).toBe('dosu: "cwd" · Session Capture ◉');
      // Theirs prints nothing, fails, or is gone: seshi's alone.
      expect((await chained("true")).out).toBe("Session Capture ◉");
      expect((await chained("exit 3")).out).toBe("Session Capture ◉");
      expect((await chained("printf 'one\\ntwo'")).out).toBe("one\ntwo\nSession Capture ◉");
      rmSync(chain);
      expect(
        (
          await machine.seshi(["statusline", "--chain", chain], {
            stdin: "{}",
            env: { NO_COLOR: "1" },
          })
        ).out,
      ).toBe("Session Capture ◉");
    },
  );

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
  it("pauses and resumes; a session started during the pause stays off, unretracted", async () => {
    const pause = await machine.seshi(["capture", "pause", "2h", "--json"]);
    expect(JSON.parse(pause.out)).toMatchObject({ paused: true, until: expect.any(String) });
    expect((await machine.seshi(["capture", "pause", "soon"])).code).toBe(2);
    machine.spawned.length = 0;
    await hook();
    // Handed over to be stopped, not to upload: nothing queued, no uploader started.
    expect(spooled()).toBe(1);
    expect(machine.spawned).toEqual([]);
    expect((await daemon()).summary).toMatchObject({ uploaded: 0, queued: 0 });
    expect(state().sessions[`claude-code:${SESSION}`].frozen).toMatchObject({ offset: 0 });
    const resume = await machine.seshi(["capture", "resume"], { env: { NO_COLOR: "1" } });
    expect(resume.out).toContain("resumed");
    expect(resume.out).toContain("1 session a pause stopped stays stopped");
    expect(state().pauses).toHaveLength(1);
    // Still off after the pause: hooks spool nothing for it, nothing is uploaded or retracted.
    await hook();
    expect(spooled()).toBe(1); // the resume's wake-up only
    expect((await daemon()).summary).toMatchObject({ uploaded: 0, retracted: 0 });
    expect(await stored()).toBeNull();
    const line = await machine.seshi(["statusline", "--json"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
    });
    expect(JSON.parse(line.out)).toMatchObject({ capturing: false, level: "pause", frozen_at: 0 });
  });

  it("reports a pause that ran out as over", async () => {
    await machine.seshi(["capture", "pause", "30m"]);
    const st = state();
    st.paused.until = "2026-01-01T00:00:00.000Z";
    writeFileSync(join(stateDir(), "state.json"), JSON.stringify(st));
    const human = await machine.seshi(["capture", "status"], { env: { NO_COLOR: "1" } });
    expect(human.out).toContain("Session Capture: capturing");
    expect(human.out).not.toContain("paused");
    const json = JSON.parse((await machine.seshi(["capture", "status", "--json"])).out);
    expect(json.paused).toBeNull();
    await machine.seshi(["capture", "pause"]);
    expect(JSON.parse((await machine.seshi(["capture", "status", "--json"])).out).paused).toEqual({
      at: expect.any(String),
    });
  });

  it("answers the desktop chip's calls with the fields it reads (F9.4)", async () => {
    // integrations/claude-code/plugin/hooks/register.tsx runs exactly these and reads these
    // fields; a change here is a change to the Session Capture chip.
    const ask = async () =>
      JSON.parse(
        (
          await machine.seshi(["statusline", "--json", "--agent", "claude-code"], {
            stdin: JSON.stringify({ session_id: SESSION }),
          })
        ).out,
      );
    const toggle = async (which: "on" | "off") =>
      JSON.parse(
        (
          await machine.seshi([
            "capture",
            which,
            "--session",
            SESSION,
            "--agent",
            "claude-code",
            "--json",
          ])
        ).out,
      );
    expect(await ask()).toMatchObject({
      capturing: true,
      reason: expect.any(String),
      problems: expect.any(Array),
    });
    expect(await toggle("off")).toMatchObject({
      capture: false,
      retracting: expect.any(Boolean),
      fresh: expect.any(Boolean),
      unfrozen: expect.any(Boolean),
    });
    expect(await ask()).toMatchObject({ capturing: false, reason: "turned off for this session" });
    expect(await toggle("on")).toMatchObject({ capture: true });
    expect(await ask()).toMatchObject({ capturing: true, reason: "turned on for this session" });
  });

  it("stops a running session where it is; resume keeps it stopped, capture on uploads all of it", async () => {
    await hook();
    await daemon();
    const pause = await machine.seshi(["capture", "pause", "1h"], { env: { NO_COLOR: "1" } });
    expect(pause.out).toContain("sessions stop where they are until");
    expect(pause.out).toContain("1 session keeps what was uploaded and sends nothing more");
    expect(pause.out).not.toContain("uploaded when the pause ends");
    const key = `claude-code:${SESSION}`;
    expect(state().sessions[key].frozen).toMatchObject({ offset: Buffer.byteLength(HEAD) });
    // Nothing more goes, during the pause or after it.
    appendFileSync(file, TAIL);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    await machine.seshi(["capture", "resume"]);
    await hook();
    expect((await daemon()).summary).toMatchObject({ uploaded: 0, retracted: 0 });
    expect(state().sessions[key].file_offset).toBe(Buffer.byteLength(HEAD));
    // What it uploaded stays on the server: nothing is retracted.
    expect((await stored())?.status).toBe("stored");
    expect((await stored())?.traces).toHaveLength(1);
    const status = await machine.seshi(["capture", "status", "--session", SESSION], {
      env: { NO_COLOR: "1" },
    });
    expect(status.out).toContain("Session Capture: not capturing");
    expect(status.out).toContain("stopped by a pause");
    expect(JSON.parse((await machine.seshi(["capture", "status", "--json"])).out).stopped).toBe(1);
    const line = await machine.seshi(["statusline"], {
      stdin: JSON.stringify({ session_id: SESSION, cwd: project }),
      env: { NO_COLOR: "1" },
    });
    expect(line.out).toBe("Session Capture ⏸");

    const on = await machine.seshi(["capture", "on", "--session", SESSION, "--json"]);
    expect(JSON.parse(on.out)).toMatchObject({ capture: true, unfrozen: true, fresh: false });
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await stored())?.traces).toHaveLength(2);
    expect(state().sessions[key]).toMatchObject({ file_offset: Buffer.byteLength(HEAD + TAIL) });
    expect(state().sessions[key].frozen).toBeUndefined();
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

  it("never uploads from a place on the org's exclude list, and status names the entry", async () => {
    machine.cliConfig(
      `server = "${server.url}"\nuser = "${OWNER}"\n[capture]\nexclude = ["# client work", "~/code/app"]\n`,
    );
    await hook();
    await machine.seshi(["capture", "on", "--session", SESSION]);
    await hook();
    await daemon();
    expect(await stored()).toBeNull();
    const status = await machine.seshi(["capture", "status", "--session", SESSION, "--json"]);
    expect(JSON.parse(status.out).session).toMatchObject({
      capture: false,
      level: "org",
      reason: "the org excludes ~/code/app (capture.exclude)",
    });
    const human = await machine.seshi(["capture", "status", "--session", SESSION], {
      env: { NO_COLOR: "1" },
    });
    expect(human.out).toContain("the org excludes ~/code/app (capture.exclude) (org)");

    // The same list from the environment, naming the repo by its remote on any host.
    machine.cliConfig(`server = "${server.url}"\nuser = "${OWNER}"\n`);
    mkdirSync(join(project, ".git"));
    writeFileSync(
      join(project, ".git", "config"),
      `[remote "origin"]\n\turl = https://gitlab.example.com/Acme/App.git\n`,
    );
    const line = (env: Record<string, string> = {}) =>
      machine
        .seshi(["statusline", "--json"], { stdin: JSON.stringify({ cwd: project }), env })
        .then((r) => JSON.parse(r.out));
    expect(await line()).toMatchObject({ capturing: true });
    expect(await line({ SESHI_CAPTURE__EXCLUDE: "acme/app" })).toMatchObject({
      capturing: false,
      level: "org",
    });
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
      ["opencode", false],
      ["pi", false],
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

  it("uninstalls the agents it can and reports one whose config it cannot read", async () => {
    const install = await machine.seshi(["capture", "install", "claude-code", "codex", "cursor"]);
    expect(install.code, install.err).toBe(0);
    writeFileSync(join(machine.dir, ".cursor", "hooks.json"), "{ broken");
    const run = await machine.seshi(["capture", "uninstall", "--json"]);
    expect(run.code).toBe(1);
    expect(run.err).toBe("");
    const report = JSON.parse(run.out);
    expect(report.uninstalled.map((r: { agent: string }) => r.agent)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(report.failed).toEqual([
      { agent: "cursor", error: expect.stringContaining("not valid JSON") },
    ]);
    // The agents removed leave the state (the sweep stops); the one that failed stays.
    expect(Object.keys(state().agents)).toEqual(["cursor"]);
    expect(readFileSync(join(machine.dir, ".claude", "settings.json"), "utf8")).not.toContain(
      "seshi hook",
    );
    const human = await machine.seshi(["capture", "uninstall"]);
    expect(human.code).toBe(1);
    expect(human.out).toContain("not removed cursor");
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
    const again = await machine.seshi(["upload", file]);
    expect(again.out).toContain(`up to date claude-code:${SESSION}`);
    expect(again.out).not.toContain("Collected");
    appendFileSync(file, TAIL);
    const grown = await machine.seshi(["upload", file, "--json"]);
    expect(JSON.parse(grown.out).sessions).toEqual([
      { path: file, key: `claude-code:${SESSION}`, result: "uploaded" },
    ]);
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
    // B1.3's state word on the success line.
    expect(backfill.out).toContain("Collected 1 session");
    expect((await stored())?.status).toBe("stored");
    expect((await machine.seshi(["upload"])).code).toBe(2);
    expect((await machine.seshi(["upload", "--since", "lots"])).code).toBe(2);
  });

  it("stops a session it is handed during a pause, as a hook would", async () => {
    await machine.seshi(["capture", "pause"]);
    const during = await machine.seshi(["upload", file, "--json"]);
    expect(JSON.parse(during.out).sessions).toEqual([
      expect.objectContaining({ result: "skipped", reason: expect.stringContaining("paused") }),
    ]);
    expect(state().sessions[`claude-code:${SESSION}`].frozen).toMatchObject({ offset: 0 });
    await machine.seshi(["capture", "resume"]);
    const after = await machine.seshi(["upload", file, "--json"]);
    expect(JSON.parse(after.out).sessions).toEqual([
      expect.objectContaining({ result: "skipped", reason: expect.stringContaining("pause") }),
    ]);
    expect(await stored()).toBeNull();
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

describe("seshi upload --since and the sweep, from OpenCode's database", () => {
  const DAY = 86_400_000;
  const EXPORT = JSON.parse(transcript("opencode-export.opencode.json")) as OpencodeExport;
  const database = () => join(machine.dir, ".local", "share", "opencode", "opencode.db");
  const copy = (id: string) => join(stateDir(), "transcripts", "opencode", `${id}.json`);
  /** The fixture session as `id`, started at `created`, run in the test's project, with an answer
   * long enough to pass the session filter. */
  const session = (id: string, created: number): OpencodeExport => {
    const doc = opencodeSessionAt(EXPORT, id, created);
    const last = doc.messages.at(-1) as OpencodeExport["messages"][number];
    last.parts = last.parts.map((part) =>
      part.type === "text" ? { ...part, text: `The auth flow: ${"details ".repeat(400)}` } : part,
    );
    return { ...doc, info: { ...doc.info, directory: project } };
  };
  const turn = (at: number): OpencodeExport["messages"][number] => ({
    info: { id: `msg_more_${at}`, role: "assistant", time: { created: at, completed: at } },
    parts: [{ id: `prt_more_${at}`, type: "text", text: "One more thing about auth." }],
  });
  const upload = async (...more: string[]) => {
    const run = await machine.seshi([
      "upload",
      "--since",
      "30d",
      "--agent",
      "opencode",
      "--json",
      ...more,
    ]);
    expect(run.code, run.err).toBe(0);
    return JSON.parse(run.out).sessions as { key?: string; result: string; reason?: string }[];
  };
  const storedOpencode = (id: string) => getSession(server.instance.store, OWNER, "opencode", id);

  it("finds sessions from before install within the cutoff, and a later turn", async () => {
    const now = Date.now();
    writeOpencodeDb(database(), [
      session("ses_before", now - 2 * DAY),
      session("ses_ancient", now - 400 * DAY),
    ]);
    expect(await upload()).toEqual([
      { path: copy("ses_before"), key: "opencode:ses_before", result: "uploaded" },
    ]);
    expect((await storedOpencode("ses_before"))?.status).toBe("stored");
    expect(await storedOpencode("ses_ancient")).toBeNull();
    expect(JSON.parse(readFileSync(copy("ses_before"), "utf8")).messages).toHaveLength(3);

    expect(await upload()).toEqual([expect.objectContaining({ result: "up to date" })]);
    addOpencodeTurn(database(), "ses_before", turn(now));
    expect(await upload()).toEqual([
      { path: copy("ses_before"), key: "opencode:ses_before", result: "uploaded" },
    ]);
    expect(JSON.parse(readFileSync(copy("ses_before"), "utf8")).messages).toHaveLength(4);
  });

  it("uploads once a session the plugin handed over that the database also holds", async () => {
    const both = session("ses_both", Date.now() - DAY);
    const handed = await machine.seshi(["hook", "opencode", "Stop"], {
      stdin: JSON.stringify({ session_id: "ses_both", cwd: project, export: both }),
    });
    expect(handed.code, handed.err).toBe(0);
    const plugin = readFileSync(copy("ses_both"), "utf8");
    writeOpencodeDb(database(), [both]);
    expect(await upload()).toEqual([
      { path: copy("ses_both"), key: "opencode:ses_both", result: "uploaded" },
    ]);
    // The plugin's copy was as new as the database: it is what went.
    expect(readFileSync(copy("ses_both"), "utf8")).toBe(plugin);
    expect(await upload()).toEqual([expect.objectContaining({ result: "up to date" })]);
    // A turn the plugin did not hand over (it did not load): the database's is newer.
    addOpencodeTurn(database(), "ses_both", turn(Date.now() + 1000));
    expect(await upload()).toEqual([expect.objectContaining({ result: "uploaded" })]);
    expect(JSON.parse(readFileSync(copy("ses_both"), "utf8")).messages).toHaveLength(4);
  });

  it("writes no copy of a session that is not captured", async () => {
    writeOpencodeDb(database(), [session("ses_off", Date.now() - DAY)]);
    await machine.seshi(["capture", "off", "--session", "ses_off", "--agent", "opencode"]);
    expect(await upload()).toEqual([expect.objectContaining({ result: "skipped" })]);
    expect(existsSync(copy("ses_off"))).toBe(false);
  });

  it("finds nothing quietly without a database, and says why it skips one it cannot read", async () => {
    expect(await upload()).toEqual([]);
    mkdirSync(join(database(), ".."), { recursive: true });
    writeFileSync(database(), "");
    const { Database } = await import("bun:sqlite");
    const other = new Database(database());
    other.run("CREATE TABLE session_v2 (id text PRIMARY KEY)");
    other.close();
    expect(await upload()).toEqual([
      {
        path: "opencode",
        result: "skipped",
        reason: expect.stringContaining("not an OpenCode database seshi can read"),
      },
    ]);
  });

  it("takes an OpenCode 2.x session its plugin only names, from the database, once captured", async () => {
    const at = Date.now() - 60_000;
    const v2 = (id: string) => ({
      session: { id, directory: project, time: { created: at, updated: at + 2000 } },
      rows: [
        {
          id: `msg_${id}_1`,
          type: "user",
          time: at + 100,
          data: { text: "How does auth work?", time: { created: at + 100 } },
        },
        {
          id: `msg_${id}_2`,
          type: "assistant",
          time: at + 1000,
          data: {
            agent: "build",
            model: { id: "fake-1", providerID: "fake" },
            content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
            time: { created: at + 1000, completed: at + 2000 },
          },
        },
      ],
    });
    writeOpencodeDbV2(database(), [v2("ses_two"), v2("ses_quiet")]);
    const stop = (session: string) =>
      machine.seshi(["hook", "opencode", "Stop"], {
        stdin: JSON.stringify({ session_id: session, cwd: project, opencode_channel: "latest" }),
      });
    expect((await stop("ses_two")).code).toBe(0);
    const doc = JSON.parse(readFileSync(copy("ses_two"), "utf8"));
    expect(doc.info.id).toBe("ses_two");
    expect(doc.messages.map((m: { info: { role: string } }) => m.info.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await storedOpencode("ses_two"))?.status).toBe("stored");

    // OpenCode then marks the run idle and totals the session: the sweep reads it again and
    // finds nothing new to send.
    const idle = Date.now() + 1000;
    const { Database } = await import("bun:sqlite");
    const write = new Database(database());
    write
      .query(
        `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
           VALUES ('msg_ses_two_idle', 'ses_two', 'idle', 2, ?1, ?1, ?2)`,
      )
      .run(idle, JSON.stringify({ outcome: "succeeded", time: { created: idle } }));
    write
      .query(
        `UPDATE session_v2 SET time_updated = ?1, time_idle = ?1, idle_outcome = 'succeeded',
           cost = 0.01, tokens_input = 50 WHERE id = 'ses_two'`,
      )
      .run(idle);
    write.close();
    const kept = readFileSync(copy("ses_two"), "utf8");
    const s = state();
    delete s.uploader.last_sweep;
    writeFileSync(join(stateDir(), "state.json"), JSON.stringify(s), { mode: 0o600 });
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    expect(statSync(copy("ses_two")).mtimeMs).toBe(idle);
    expect(readFileSync(copy("ses_two"), "utf8")).toBe(kept);

    // Turned off: seshi neither reads it nor keeps a copy.
    await machine.seshi(["capture", "off", "--session", "ses_quiet", "--agent", "opencode"]);
    expect((await stop("ses_quiet")).code).toBe(0);
    expect(existsSync(copy("ses_quiet"))).toBe(false);
  });

  it("the uploader's sweep catches up a session whose turn its 2.x hook could not read", async () => {
    // The plugin handing one session over records OpenCode as installed now.
    const first = session("ses_first", Date.now() - 1000);
    await machine.seshi(["hook", "opencode", "Stop"], {
      stdin: JSON.stringify({ session_id: "ses_first", cwd: project, export: first }),
    });
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    // A session started before that, resumed, whose turn was not in the database yet when the
    // hook ran.
    const at = Date.now() + 1000;
    const late = {
      session: {
        id: "ses_late",
        directory: project,
        time: { created: at - 60 * DAY, updated: at + 2000 },
      },
      rows: [
        {
          id: "msg_late_1",
          type: "user",
          time: at + 100,
          data: { text: "How does auth work?", time: { created: at + 100 } },
        },
        {
          id: "msg_late_2",
          type: "assistant",
          time: at + 1000,
          data: {
            agent: "build",
            model: { id: "fake-1", providerID: "fake" },
            content: [{ type: "text", text: `The auth flow: ${"details ".repeat(400)}` }],
            time: { created: at + 1000, completed: at + 2000 },
          },
        },
      ],
    };
    writeOpencodeDbV2(database(), []);
    const stop = await machine.seshi(["hook", "opencode", "Stop"], {
      stdin: JSON.stringify({ session_id: "ses_late", cwd: project, opencode_channel: "latest" }),
    });
    expect(stop.code).toBe(0);
    expect(existsSync(copy("ses_late"))).toBe(false);
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    // The turn lands in the database; the next sweep reads it, though it started before install.
    for (const file of [database(), `${database()}-wal`, `${database()}-shm`]) {
      rmSync(file, { force: true });
    }
    writeOpencodeDbV2(database(), [late]);
    const s = state();
    delete s.uploader.last_sweep;
    writeFileSync(join(stateDir(), "state.json"), JSON.stringify(s), { mode: 0o600 });
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    expect((await storedOpencode("ses_late"))?.status).toBe("stored");
  });

  it("the uploader's sweep finds a session the plugin never handed over", async () => {
    // The plugin handing one session over records OpenCode as installed now.
    const handed = session("ses_handed", Date.now() - 1000);
    await machine.seshi(["hook", "opencode", "Stop"], {
      stdin: JSON.stringify({ session_id: "ses_handed", cwd: project, export: handed }),
    });
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    writeOpencodeDb(database(), [handed, session("ses_missed", Date.now())]);
    const s = state();
    delete s.uploader.last_sweep;
    writeFileSync(join(stateDir(), "state.json"), JSON.stringify(s), { mode: 0o600 });
    expect((await daemon()).summary).toMatchObject({ found: 1, uploaded: 1 });
    expect((await storedOpencode("ses_missed"))?.status).toBe("stored");
    expect(existsSync(copy("ses_missed"))).toBe(true);
  });
});

describe("serverless mode, by its old name [local] (F11)", () => {
  it("uploads to your own bucket and retracts there", async () => {
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

      // Stale in the bucket (no format version recorded): the uploader resends it (X4.9).
      const bucket = new FsStore(join(local.dir, "bucket"));
      const metadata = (await getSession(bucket, "me", "claude-code", "l1")) as NonNullable<
        Awaited<ReturnType<typeof getSession>>
      >;
      const { format_version: _gone, ...normalizer } = metadata.normalizer ?? {
        name: "x",
        version: "0",
      };
      await bucket.put(
        keys.metadata("me", archiveId("me", "claude-code", "l1")),
        new TextEncoder().encode(JSON.stringify({ ...metadata, normalizer })),
      );
      const localState = join(stateDir(local), "state.json");
      const s = state(local);
      delete s.uploader.last_stale_check;
      writeFileSync(localState, JSON.stringify(s), { mode: 0o600 });
      await daemon(local);
      expect(state(local).sessions["claude-code:l1"].rebuild).toBeDefined();
      // It waits its turn within the day (26), then goes.
      expect((await daemon(local)).summary).toMatchObject({ uploaded: 0 });
      rebuildDueNow("claude-code:l1", local);
      expect((await daemon(local)).summary).toMatchObject({ uploaded: 1, failed: 0 });
      expect(
        (await getSession(bucket, "me", "claude-code", "l1"))?.normalizer?.format_version,
      ).toBeDefined();

      await local.seshi(["capture", "off", "--session", "l1"]);
      expect((await daemon(local)).summary).toMatchObject({ retracted: 1 });
      const show = await local.seshi(["sessions", "show", "claude-code/l1", "--json"]);
      expect(JSON.parse(show.out).status).toBe("redacted");
    } finally {
      local.cleanup();
    }
  });
});

describe("the org's exclude list in serverless mode", () => {
  it("applies the bucket's [capture] exclude before anything is written, and names it", async () => {
    const local = new Machine();
    try {
      const code = join(local.dir, "code");
      const payroll = join(local.dir, "payroll");
      mkdirSync(code);
      mkdirSync(payroll);
      const toml = join(local.dir, "seshi.toml");
      writeFileSync(
        toml,
        `[store]\nurl = "file://${join(local.dir, "bucket")}"\n[capture]\nexclude = ["${payroll}"]\n`,
        { mode: 0o600 },
      );
      local.cliConfig(`[local]\nconfig = "${toml}"\nowner = "me"\n`);
      await ensureLayout(new FsStore(join(local.dir, "bucket")), {
        createdBy: "test",
        mode: "serverless",
      });
      for (const [id, cwd] of [
        ["x1", payroll],
        ["x2", code],
      ] as const) {
        const file = join(local.dir, `${id}.jsonl`);
        writeFileSync(file, HEAD);
        await local.seshi(["hook", "claude-code", "Stop"], {
          stdin: JSON.stringify({ session_id: id, transcript_path: file, cwd }),
        });
      }
      const { summary } = await daemon(local);
      expect(summary).toMatchObject({ uploaded: 1 });
      const ls = await local.seshi(["sessions", "ls"]);
      expect(ls.out).toContain("claude-code/x2");
      expect(ls.out).not.toContain("claude-code/x1");

      const status = await local.seshi([
        "capture",
        "status",
        "--session",
        "x1",
        "--agent",
        "claude-code",
        "--json",
      ]);
      expect(JSON.parse(status.out).session).toMatchObject({
        capture: false,
        level: "org",
        excluded: { entry: payroll, from: "server" },
      });
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
    // The uploader names itself as the CLI does, not as the client library's default.
    expect(first?.headers["user-agent"]).toBe(`seshi/${VERSION}`);
    expect(rulesFetches()[0]?.headers["user-agent"]).toBe(`seshi/${VERSION}`);
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
      await ensureLayout(new FsStore(join(local.dir, "bucket")), {
        createdBy: "test",
        mode: "serverless",
      });
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

describe("resending uploaded sessions (X4.9)", () => {
  const KEY = `claude-code:${SESSION}`;
  /** The server's session as an older normalizer left it: no format version recorded. */
  async function makeStale(id = SESSION) {
    const store = server.instance.store;
    const metadata = (await stored(id)) as NonNullable<Awaited<ReturnType<typeof stored>>>;
    const { format_version: _gone, ...normalizer } = metadata.normalizer ?? {
      name: "x",
      version: "0",
    };
    await store.put(
      keys.metadata(OWNER, archiveId(OWNER, "claude-code", id)),
      new TextEncoder().encode(JSON.stringify({ ...metadata, normalizer })),
    );
  }
  /** As if the uploader last asked the server more than an hour ago. */
  function forgetStaleCheck() {
    const path = join(stateDir(), "state.json");
    const s = state();
    delete s.uploader.last_stale_check;
    writeFileSync(path, JSON.stringify(s), { mode: 0o600 });
  }

  it("resends a session the server marks stale by itself, once, rebuilt from the whole log", async () => {
    await hook();
    await daemon();
    appendFileSync(file, TAIL);
    await hook();
    await daemon();
    expect((await stored())?.traces).toHaveLength(2);
    expect((await stored())?.normalizer?.format_version).toMatch(/^\d+\+trajectory\./);
    await makeStale();
    forgetStaleCheck();
    // One pass learns it is stale; the next sends it whole with rebuild (the org key proves
    // the machine with the retraction secret).
    await daemon();
    expect(state().sessions[KEY].rebuild).toMatchObject({ key: expect.any(String) });
    // It waits its turn within the day (26): nothing goes until then.
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    rebuildDueNow(KEY);
    const { summary } = await daemon();
    expect(summary).toMatchObject({ uploaded: 1, failed: 0 });
    const rebuilt = await stored();
    expect(rebuilt?.normalizer?.format_version).toMatch(/^\d+\+trajectory\./);
    // Built again whole: one trace in place of the head and its continuation.
    expect(rebuilt?.traces).toHaveLength(1);
    const { entries } = await readChanges(server.instance.store, OWNER);
    expect(entries.at(-1)?.entry).toMatchObject({ kind: "published", replace: true });
    // No longer stale; nothing more is sent.
    forgetStaleCheck();
    await daemon();
    expect((await daemon()).summary).toMatchObject({ uploaded: 0 });
    expect(state().sessions[KEY].rebuild).toBeUndefined();
  });

  it("resends one session by hand with --session", async () => {
    await hook();
    await daemon();
    const before = (await readChanges(server.instance.store, OWNER)).entries.length;
    machine.spawned.length = 0;
    const run = await machine.seshi(["capture", "resend", "--session", SESSION, "--json"]);
    expect(run.code, run.err).toBe(0);
    expect(JSON.parse(run.out)).toEqual({ resending: [KEY], skipped: [] });
    expect(machine.spawned).toEqual([{ words: ["daemon"], self: true }]);
    const status = await machine.seshi(["capture", "status", "--session", SESSION, "--json"]);
    expect(JSON.parse(status.out).session.state).toBe("resending");
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
    // The log only repeats what is stored, yet it was built and reviewed again: no `unchanged`.
    expect(state().sessions[KEY].last_status).toBe("duplicate");
    expect(state().sessions[KEY].rebuild).toBeUndefined();
    const after = await stored();
    expect(after?.applied?.at(-1)?.idempotency_key).toMatch(/^rebuild-/);
    expect((await readChanges(server.instance.store, OWNER)).entries.length).toBe(before);
  });

  it("resends every session uploaded from here with --all, but never one turned off", async () => {
    const second = "2a3b4c5d-6e7f-4089-9abc-def012345678";
    const other = join(file, "..", `${second}.jsonl`);
    writeFileSync(other, HEAD);
    await hook();
    await hook("Stop", { session_id: second, transcript_path: other });
    // Seen but never uploaded: nothing to resend.
    await hook("Stop", {
      session_id: "never-sent",
      transcript_path: join(file, "..", "nope.jsonl"),
    });
    await daemon();
    expect((await stored(second))?.status).toBe("stored");
    await machine.seshi(["capture", "off", "--session", second]);

    const run = await machine.seshi(["capture", "resend", "--all", "--json"]);
    expect(run.code, run.err).toBe(0);
    const answer = JSON.parse(run.out);
    expect(answer.resending).toEqual([KEY]);
    expect(answer.skipped).toEqual(
      expect.arrayContaining([{ key: `claude-code:${second}`, reason: "turned off" }]),
    );
    const { summary } = await daemon();
    expect(summary).toMatchObject({ uploaded: 1, retracted: 1 });
    expect((await stored(second))?.status).toBe("redacted");
    expect(state().sessions[`claude-code:${second}`].rebuild).toBeUndefined();

    const text = await machine.seshi(["capture", "resend", "--all"]);
    expect(text.out).toContain("1 session(s)");
    expect(text.out).toContain("not resent, turned off");
  });

  it("resends a session the server excluded only when asked for by name", async () => {
    await hook();
    await daemon();
    const st = state();
    st.sessions[KEY].excluded = { at: "2026-11-01T00:00:00Z", message: "excluded" };
    writeFileSync(join(stateDir(), "state.json"), JSON.stringify(st), { mode: 0o600 });
    const all = JSON.parse((await machine.seshi(["capture", "resend", "--all", "--json"])).out);
    expect(all).toEqual({
      resending: [],
      skipped: [{ key: KEY, reason: "excluded by the server" }],
    });
    const one = await machine.seshi(["capture", "resend", "--session", SESSION, "--json"]);
    expect(JSON.parse(one.out)).toEqual({ resending: [KEY], skipped: [] });
    expect(state().sessions[KEY].excluded).toBeUndefined();
    expect((await daemon()).summary).toMatchObject({ uploaded: 1 });
  });

  it("refuses bad usage, a session it has not seen, and one turned off", async () => {
    expect((await machine.seshi(["capture", "resend"])).code).toBe(2);
    expect((await machine.seshi(["capture", "resend", "--all", "--session", "x"])).code).toBe(2);
    expect((await machine.seshi(["capture", "resend", "--all", "--path", "/y"])).code).toBe(2);
    expect((await machine.seshi(["capture", "resend", "--all", "extra"])).code).toBe(2);
    const unseen = await machine.seshi([
      "capture",
      "resend",
      "--session",
      "nope",
      "--agent",
      "claude-code",
    ]);
    expect(unseen.code).toBe(4);
    await hook();
    await daemon();
    await machine.seshi(["capture", "off", "--session", SESSION]);
    const off = await machine.seshi(["capture", "resend", "--session", SESSION]);
    expect(off.code).toBe(6);
    expect(off.out).toContain("turned off");
    expect(state().sessions[KEY].rebuild).toBeUndefined();
  });
});
