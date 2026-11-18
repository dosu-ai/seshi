import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CaptureHost, commandLine, hookHandler } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOUD_FLAG,
  CURSOR_CAPTURE,
  cloudMarkerPath,
  cursorCloud,
  cursorInstaller,
  cursorProjectInstaller,
  identifyCursorTranscript,
  locateCursorTranscript,
  PROJECT_TIMEOUTS,
  projectHookCommand,
  SETUP_SCRIPT,
  setupScript,
} from "./capture";

const HOOKS = join(import.meta.dirname, "../../testdata/hooks");
const payload = (name: string) => JSON.parse(readFileSync(join(HOOKS, `${name}.json`), "utf8"));

let home: string;
let host: CaptureHost;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "seshi-cursor-"));
  host = { env: {}, home, platform: "linux" };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("Cursor's hooks (F9.2)", () => {
  it("keys a session by its conversation, in the first workspace root", () => {
    expect(hookHandler(CURSOR_CAPTURE, "stop")?.parse(payload("stop"), host)).toEqual({
      captures: [
        {
          session_id: "c0ffee00-1111-4222-8333-444455556666",
          transcript_path:
            "/Users/dev/.cursor/projects/Users-dev-code-app/agent-transcripts/c0ffee00-1111-4222-8333-444455556666.jsonl",
          cwd: "/Users/dev/code/app",
        },
      ],
    });
  });

  it("goes without a transcript on the first prompt (found later), and ends the session", () => {
    const first = hookHandler(CURSOR_CAPTURE, "stop")?.parse(payload("stop-first-prompt"), host);
    expect(first?.captures[0]?.transcript_path).toBeUndefined();
    const end = hookHandler(CURSOR_CAPTURE, "sessionEnd")?.parse(payload("sessionEnd"), host);
    expect(end?.captures[0]).toMatchObject({ final: true, cwd: "/Users/dev/code/app" });
    expect(() => hookHandler(CURSOR_CAPTURE, "stop")?.parse({}, host)).toThrow("conversation_id");
  });
});

describe("/session-capture typed in Cursor", () => {
  const prompt = (text: string) =>
    hookHandler(CURSOR_CAPTURE, "beforeSubmitPrompt")?.parse(
      { conversation_id: "c1", workspace_roots: ["/w/app"], prompt: text },
      host,
    );

  it("is a request for the hook, and any other prompt passes untouched", () => {
    const which = { session_id: "c1", cwd: "/w/app" };
    expect(prompt("/session-capture off")).toEqual({
      captures: [],
      active: which,
      request: { action: "off", session: which },
    });
    expect(prompt("/session-capture")).toEqual({ captures: [], active: which, announce: which });
    // Every prompt marks its conversation as the folder's current one, for the editor.
    expect(prompt("/session-capture off and then fix the tests")).toEqual({
      captures: [],
      active: which,
    });
    expect(prompt("fix the tests")).toEqual({ captures: [], active: which });
  });

  it("answers by stopping the prompt, the only way Cursor shows a hook's message", () => {
    expect(hookHandler(CURSOR_CAPTURE, "beforeSubmitPrompt")?.reply?.("hi")).toEqual({
      continue: false,
      user_message: "hi",
    });
  });
});

describe("Cursor's transcripts", () => {
  it("are known by their name and found under any project", () => {
    const dir = join(home, ".cursor", "projects", "Users-dev-app", "agent-transcripts");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "conv-1.jsonl");
    writeFileSync(file, '{"role":"user","message":{"content":"hi"}}\n');
    expect(identifyCursorTranscript(file, readFileSync(file, "utf8"))).toEqual({
      session_id: "conv-1",
    });
    expect(identifyCursorTranscript(file, '{"type":"user"}\n')).toBeNull();
    expect(locateCursorTranscript("conv-1", host)).toBe(file);
    expect(locateCursorTranscript("conv-2", host)).toBeUndefined();
    expect(CURSOR_CAPTURE.sweep[0]?.match("Users-dev-app/agent-transcripts/conv-1.jsonl")).toBe(
      true,
    );
  });

  it("are found in Cursor 3's folder per conversation too", () => {
    const dir = join(home, ".cursor", "projects", "Users-dev-app", "agent-transcripts", "conv-3");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "conv-3.jsonl");
    writeFileSync(file, '{"role":"user","message":{"content":"hi"}}\n');
    expect(identifyCursorTranscript(file, readFileSync(file, "utf8"))).toEqual({
      session_id: "conv-3",
    });
    expect(locateCursorTranscript("conv-3", host)).toBe(file);
    const match = CURSOR_CAPTURE.sweep[0]?.match;
    expect(match?.("Users-dev-app/agent-transcripts/conv-3/conv-3.jsonl")).toBe(true);
    expect(match?.("Users-dev-app/agent-transcripts/conv-3/other.jsonl")).toBe(false);
    expect(CURSOR_CAPTURE.sweep[0]?.depths).toContain(4);
  });
});

describe("the installer (F9.6)", () => {
  const file = () => join(home, ".cursor", "hooks.json");
  const context = () => ({ ...host, command: ["seshi"] });

  it("merges into hooks.json, keeping other hooks, and removes only its own", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "./audit.sh" }],
          beforeShellExecution: [{ command: "./guard.sh" }],
        },
      }),
    );
    expect(cursorInstaller.detect(host)).toBe(true);
    await cursorInstaller.install(context());
    await cursorInstaller.install(context());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }, { command: "seshi hook cursor stop" }],
        beforeShellExecution: [{ command: "./guard.sh" }],
        sessionEnd: [{ command: "seshi hook cursor sessionEnd" }],
        beforeSubmitPrompt: [{ command: "seshi hook cursor beforeSubmitPrompt" }],
      },
    });
    expect((await cursorInstaller.status(context())).installed).toBe(true);
    await cursorInstaller.uninstall(context());
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }],
        beforeShellExecution: [{ command: "./guard.sh" }],
      },
    });
    expect((await cursorInstaller.uninstall(context())).changed).toEqual([]);
  });

  it("writes a new hooks.json with version 1", async () => {
    await cursorInstaller.install(context());
    expect(JSON.parse(readFileSync(file(), "utf8")).version).toBe(1);
  });

  it("adds the session-capture skill to Cursor's skills, naming itself as cursor, and removes it", async () => {
    const skill = join(home, ".cursor", "skills", "session-capture", "SKILL.md");
    const cli = join(home, ".cursor", "cli-config.json");
    const report = await cursorInstaller.install(context());
    expect(report.changed).toEqual([file(), cli, skill]);
    expect(readFileSync(skill, "utf8")).toContain("`cursor` in Cursor");
    expect((await cursorInstaller.status(context())).files[1]).toMatchObject({ ours: true });
    expect((await cursorInstaller.uninstall(context())).changed).toEqual([file(), cli, skill]);
    expect(existsSync(skill)).toBe(false);
  });

  it("sets the Cursor CLI's status line, running one someone else set up first", async () => {
    const cli = join(home, ".cursor", "cli-config.json");
    const chain = join(home, ".cursor", "seshi-statusline.json");
    mkdirSync(join(home, ".cursor"));
    const theirs = { type: "command", command: "dosu knowledge statusline render --agent cursor" };
    writeFileSync(cli, JSON.stringify({ statusLine: theirs, editor: { vimMode: false } }));
    const report = await cursorInstaller.install(context());
    expect(report.notes[0]).toContain(`yours is kept in ${chain}`);
    const config = JSON.parse(readFileSync(cli, "utf8"));
    expect(config.editor).toEqual({ vimMode: false });
    expect(config.statusLine).toEqual({
      type: "command",
      command: commandLine(["seshi", "statusline", "--agent", "cursor", "--chain", chain]),
      padding: 0,
    });
    expect(JSON.parse(readFileSync(chain, "utf8"))).toEqual({ statusLine: theirs });
    await cursorInstaller.install(context());
    expect(JSON.parse(readFileSync(chain, "utf8"))).toEqual({ statusLine: theirs });
    await cursorInstaller.uninstall(context());
    expect(JSON.parse(readFileSync(cli, "utf8"))).toEqual({
      statusLine: theirs,
      editor: { vimMode: false },
    });
    expect(existsSync(chain)).toBe(false);
  });

  it("suggests the status bar extension until it is installed", async () => {
    const note = (await cursorInstaller.install(context())).notes;
    expect(note).toEqual([expect.stringContaining("dosu.seshi-cursor")]);
    mkdirSync(join(home, ".cursor", "extensions", "dosu.seshi-cursor-0.9.0"), { recursive: true });
    expect((await cursorInstaller.install(context())).notes).toEqual([]);
  });

  it("gives the Cursor CLI seshi's own status line when it has none", async () => {
    await cursorInstaller.install(context());
    const cli = join(home, ".cursor", "cli-config.json");
    expect(JSON.parse(readFileSync(cli, "utf8")).statusLine).toEqual({
      type: "command",
      command: "seshi statusline --agent cursor",
      padding: 0,
    });
    await cursorInstaller.uninstall(context());
    expect(JSON.parse(readFileSync(cli, "utf8"))).toEqual({});
  });
});

describe("the hooks committed to a repository, for Cursor Cloud", () => {
  let repo: string;
  beforeEach(() => {
    repo = join(home, "repo");
    mkdirSync(repo);
  });
  const file = () => join(repo, ".cursor", "hooks.json");
  const script = () => join(repo, ".cursor", SETUP_SCRIPT);
  const context = () => ({ dir: repo, version: "1.2.3" });
  const ours = (event: "stop" | "sessionEnd" | "beforeSubmitPrompt") => ({
    command: projectHookCommand(event),
    timeout: PROJECT_TIMEOUTS[event],
  });

  it("merge into an existing file, keeping everyone's hooks, and come out again", async () => {
    mkdirSync(join(repo, ".cursor"));
    writeFileSync(
      file(),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "./audit.sh" }],
          afterFileEdit: [{ command: "npx prettier --write" }],
        },
      }),
    );
    const report = await cursorProjectInstaller.install(context());
    expect(report.changed).toEqual([file(), script()]);
    expect(report.notes.at(-1)).toContain(`"start": "sh .cursor/${SETUP_SCRIPT} start"`);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }, ours("stop")],
        afterFileEdit: [{ command: "npx prettier --write" }],
        sessionEnd: [ours("sessionEnd")],
        beforeSubmitPrompt: [ours("beforeSubmitPrompt")],
      },
    });
    expect((await cursorProjectInstaller.status(context())).installed).toBe(true);

    expect((await cursorProjectInstaller.uninstall(context())).changed).toEqual([file(), script()]);
    expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({
      version: 1,
      hooks: {
        stop: [{ command: "./audit.sh" }],
        afterFileEdit: [{ command: "npx prettier --write" }],
      },
    });
    expect(existsSync(script())).toBe(false);
    expect((await cursorProjectInstaller.uninstall(context())).changed).toEqual([]);
  });

  it("write a new file when there is none, and change nothing on a second install", async () => {
    await cursorProjectInstaller.install(context());
    const first = readFileSync(file(), "utf8");
    expect(JSON.parse(first).version).toBe(1);
    expect((await cursorProjectInstaller.install(context())).changed).toEqual([]);
    expect(readFileSync(file(), "utf8")).toBe(first);
    // A new version rewrites only the setup script; an edited hook entry is put back once.
    expect((await cursorProjectInstaller.install({ dir: repo, version: "1.2.4" })).changed).toEqual(
      [script()],
    );
    const edited = JSON.parse(first);
    edited.hooks.stop = [{ command: "seshi hook cursor stop --cloud" }, ours("stop")];
    writeFileSync(file(), JSON.stringify(edited));
    await cursorProjectInstaller.install(context());
    expect(JSON.parse(readFileSync(file(), "utf8")).hooks.stop).toEqual([ours("stop")]);
  });

  it("run seshi from the PATH with --cloud, and hold no token, server or machine path", async () => {
    await cursorProjectInstaller.install(context());
    const text = `${readFileSync(file(), "utf8")}${readFileSync(script(), "utf8")}`;
    expect(projectHookCommand("stop")).toContain(`exec "$s" hook cursor stop ${CLOUD_FLAG}`);
    expect(text).not.toContain(home.replace(/[/\\]repo$/, ""));
    expect(text).not.toMatch(/https?:\/\/(?!github\.com\/dosu-ai\/sessiondb)/);
    // The setup script reads the secrets from Cursor's environment only, and pins the release.
    const setup = setupScript("1.2.3");
    expect(setup).toContain('version="1.2.3"');
    expect(setup).toContain(
      'printf %s "$SESHI_TOKEN" | seshi login --server "$SESHI_SERVER" --token -',
    );
    expect(setup).toContain("seshi capture install cursor --cloud");
  });

  it("leave a setup script that is not seshi's alone", async () => {
    mkdirSync(join(repo, ".cursor"));
    writeFileSync(script(), "#!/bin/sh\necho mine\n");
    const report = await cursorProjectInstaller.install(context());
    expect(report.changed).toEqual([file()]);
    expect(report.notes[0]).toContain("is not seshi's");
    expect(readFileSync(script(), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect((await cursorProjectInstaller.status(context())).installed).toBe(false);
  });
});

describe("the Cursor Cloud marker", () => {
  it("is seshi's own file, and the user-level installer offers it", () => {
    expect(cursorInstaller.cloud).toBe(cursorCloud);
    expect(cursorCloud.is(host)).toBe(false);
    expect(cursorCloud.mark(host).changed).toEqual([cloudMarkerPath(host)]);
    expect(cursorCloud.is(host)).toBe(true);
    expect(cursorCloud.mark(host).changed).toEqual([]);
    expect(cursorCloud.unmark(host).changed).toEqual([cloudMarkerPath(host)]);
    expect(cursorCloud.is(host)).toBe(false);
  });

  it("goes with a transcript Cursor names only in the hook's environment", () => {
    const cloud = { ...host, env: { CURSOR_TRANSCRIPT_PATH: "/home/ubuntu/t.jsonl" } };
    const parsed = hookHandler(CURSOR_CAPTURE, "stop")?.parse(
      { conversation_id: "c1", workspace_roots: ["/workspace"], transcript_path: null },
      cloud,
    );
    expect(parsed?.captures[0]).toEqual({
      session_id: "c1",
      transcript_path: "/home/ubuntu/t.jsonl",
      cwd: "/workspace",
    });
  });
});
