/** The app's capture wiring: the lazy agent registry, CLI config edits, service entries, how
 * the binary starts itself, and `seshi capture`'s argument handling. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUploaderLock, capturePaths } from "@seshi/capture";
import { capturesOf } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allCaptureAgents, CAPTURE_AGENTS, captureAgent } from "./capture-agents";
import { rulePath, setCapturePath, setTableKey } from "./capture-config";
import {
  installService,
  launchdPlist,
  serviceInstalled,
  systemdUnit,
  uninstallService,
  windowsTaskCommand,
} from "./capture-service";
import { hookCommand, inNpxCache, isCompiled, selfCommand } from "./cli/spawn";
import { parseCaptureArgs, resolveSession, splitWords } from "./commands/capture";
import { waitForLock } from "./commands/daemon";
import { INTEGRATIONS } from "./integrations";

describe("the capture agents", () => {
  it("are the integration registry's, loaded one at a time", async () => {
    const fromRegistry = capturesOf(INTEGRATIONS);
    expect(Object.keys(CAPTURE_AGENTS).sort()).toEqual(fromRegistry.map((a) => a.name).sort());
    for (const agent of await allCaptureAgents()) {
      expect(fromRegistry).toContain(agent);
    }
    expect(captureAgent("toString")).toBeUndefined();
    expect((await captureAgent("codex"))?.format).toBe("codex");
  });
});

describe("editing the CLI config", () => {
  it("sets a key in a table, adding the table where it is valid", () => {
    expect(setTableKey("", "capture", "enabled", "false")).toBe("[capture]\nenabled = false\n");
    expect(setTableKey('server = "x"\n', "capture", "enabled", "false")).toBe(
      'server = "x"\n\n[capture]\nenabled = false\n',
    );
    expect(
      setTableKey(
        "[capture]\nenabled = true\n[other]\nenabled = 1\n",
        "capture",
        "enabled",
        "false",
      ),
    ).toBe("[capture]\nenabled = false\n[other]\nenabled = 1\n");
    expect(setTableKey("[capture] # mine\nremotes = []\n", "capture", "enabled", "false")).toBe(
      "[capture] # mine\nenabled = false\nremotes = []\n",
    );
    // Before an array of sub-tables, so [capture] is not defined after [[capture.paths]].
    expect(
      setTableKey(
        '[[capture.paths]]\npath = "/a"\ncapture = false\n',
        "capture",
        "enabled",
        "true",
      ),
    ).toBe('[capture]\nenabled = true\n\n[[capture.paths]]\npath = "/a"\ncapture = false\n');
  });

  it("sets a folder rule in place, or adds one", () => {
    const same = (a: string, b: string) => a === b;
    const text =
      '[[capture.paths]]\npath = "~/a"\ncapture = true\n\n[[capture.paths]]\npath = "~/b"\n';
    expect(setCapturePath(text, "~/a", false, same)).toBe(
      '[[capture.paths]]\npath = "~/a"\ncapture = false\n\n[[capture.paths]]\npath = "~/b"\n',
    );
    expect(setCapturePath(text, "~/b", false, same)).toContain('path = "~/b"\ncapture = false');
    expect(setCapturePath("", "/c", true, same)).toBe(
      '[[capture.paths]]\npath = "/c"\ncapture = true\n',
    );
    expect(rulePath("/home/me/code", "/home/me")).toBe("~/code");
    expect(rulePath("/home/me", "/home/me")).toBe("~");
    expect(rulePath("/srv/x", "/home/me")).toBe("/srv/x");
  });
});

describe("service entries", () => {
  let home: string;
  let calls: string[][];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "seshi-service-"));
    calls = [];
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const context = (platform: NodeJS.Platform, code = 0) => ({
    home,
    platform,
    command: ["/Applications/Se shi/seshi"],
    logFile: "/tmp/log",
    exec: async (words: string[]) => {
      calls.push(words);
      return { code, output: code === 0 ? "" : "boom" };
    },
  });

  it("wait for the running uploader's lock instead of exiting (--keep-alive)", async () => {
    const paths = capturePaths({ env: {}, home, platform: "linux" });
    const held = acquireUploaderLock(paths);
    expect(held).not.toBeNull();
    const waiting = waitForLock(paths, new AbortController().signal, 5);
    setTimeout(() => held?.release(), 30);
    const taken = await waiting;
    expect(taken?.held()).toBe(true);
    // Stopped while waiting: no lock, no hang.
    const stop = new AbortController();
    const stopped = waitForLock(paths, stop.signal, 10_000);
    stop.abort();
    expect(await stopped).toBeNull();
    taken?.release();
  });

  it("writes them for each OS, quoting what needs quoting", () => {
    expect(launchdPlist(["/a&b/seshi"], "/l")).toContain("<string>/a&amp;b/seshi</string>");
    expect(systemdUnit(["/opt/se shi"])).toContain('ExecStart="/opt/se shi" daemon --keep-alive');
    expect(windowsTaskCommand(["C:\\Program Files\\seshi.exe"])).toBe(
      '"C:\\Program Files\\seshi.exe" daemon --keep-alive',
    );
  });

  it("installs and removes a launchd agent", async () => {
    const report = await installService(context("darwin"));
    expect(report).toMatchObject({ changed: true, problems: [] });
    expect(readFileSync(report.entry, "utf8")).toContain(
      "<string>/Applications/Se shi/seshi</string>",
    );
    expect(calls).toEqual([
      ["launchctl", "unload", report.entry],
      ["launchctl", "load", "-w", report.entry],
    ]);
    expect(await serviceInstalled(context("darwin"))).toBe(true);
    await uninstallService(context("darwin"));
    expect(existsSync(report.entry)).toBe(false);
  });

  it("installs and removes a systemd user unit, reporting a failed command", async () => {
    const report = await installService(context("linux", 1));
    expect(report.problems).toEqual([
      "systemctl --user daemon-reload exited 1: boom",
      "systemctl --user enable --now seshi-uploader.service exited 1: boom",
    ]);
    expect(existsSync(join(home, ".config", "systemd", "user", "seshi-uploader.service"))).toBe(
      true,
    );
    expect((await uninstallService(context("linux"))).changed).toBe(true);
    expect((await uninstallService(context("linux"))).changed).toBe(false);
  });

  it("installs and removes a Task Scheduler task", async () => {
    await installService(context("win32"));
    expect(calls[0]?.slice(0, 7)).toEqual([
      "schtasks",
      "/Create",
      "/F",
      "/SC",
      "ONLOGON",
      "/TN",
      "seshi-uploader",
    ]);
    expect(await serviceInstalled(context("win32"))).toBe(true);
    await uninstallService(context("win32"));
    expect(calls.at(-1)).toEqual(["schtasks", "/Delete", "/F", "/TN", "seshi-uploader"]);
  });
});

describe("starting seshi again", () => {
  it("tells the compiled binary from bun running the source", () => {
    expect(isCompiled(["/usr/local/bin/seshi", "/$bunfs/root/seshi"], "/usr/local/bin/seshi")).toBe(
      true,
    );
    expect(isCompiled(["C:\\seshi.exe", "B:\\~BUN\\root\\seshi"], "C:\\seshi.exe")).toBe(true);
    expect(isCompiled(["/opt/bun", "/repo/apps/seshi/src/main.ts"], "/opt/bun")).toBe(false);
    expect(selfCommand(["/opt/bun", "/repo/main.ts"], "/opt/bun")).toEqual([
      "/opt/bun",
      "/repo/main.ts",
    ]);
    expect(selfCommand(["/bin/seshi", "/$bunfs/root/seshi"], "/bin/seshi")).toEqual(["/bin/seshi"]);
  });

  it("writes hooks with the binary's absolute path, or seshi from the PATH", () => {
    expect(hookCommand(["/opt/seshi/seshi", "/$bunfs/root/seshi"], "/opt/seshi/seshi")).toEqual([
      "/opt/seshi/seshi",
    ]);
    expect(hookCommand(["/opt/bun", "/repo/main.ts"], "/opt/bun")).toEqual(["seshi"]);
    // Installed from npm: the platform package's binary, not the Node launcher.
    const npm = "/usr/lib/node_modules/seshi/node_modules/@seshi/cli-linux-x64/bin/seshi";
    expect(hookCommand([npm, "/$bunfs/root/seshi"], npm)).toEqual([npm]);
    const exe = "C:\\npm\\node_modules\\@seshi\\cli-windows-x64\\bin\\seshi.exe";
    expect(hookCommand([exe, "B:\\~BUN\\root\\seshi"], exe)).toEqual([exe]);
  });

  it("knows a binary in npx's cache, which npx may delete", () => {
    expect(
      inNpxCache("/home/me/.npm/_npx/0a1b2c/node_modules/@seshi/cli-linux-x64/bin/seshi"),
    ).toBe(true);
    expect(inNpxCache("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\0a1b\\seshi.exe")).toBe(
      true,
    );
    expect(inNpxCache("/usr/lib/node_modules/@seshi/cli-linux-x64/bin/seshi")).toBe(false);
    expect(inNpxCache("seshi")).toBe(false);
  });
});

describe("seshi capture's arguments", () => {
  it("takes --session with or without an id", () => {
    expect(parseCaptureArgs(["--session"])).toEqual({ positionals: [], session: true });
    expect(parseCaptureArgs(["--session", "s1", "--agent", "codex"])).toEqual({
      positionals: [],
      session: "s1",
      agent: "codex",
    });
    expect(parseCaptureArgs(["--session", "--service"])).toEqual({
      positionals: [],
      session: true,
      service: true,
    });
    expect(parseCaptureArgs(["--agent"])).toBe("--agent needs an agent name");
    expect(parseCaptureArgs(["--bogus"])).toBe("unknown option --bogus");
    expect(splitWords('"/Applications/Se shi/seshi" --x')).toEqual([
      "/Applications/Se shi/seshi",
      "--x",
    ]);
  });

  it("finds the session from the env, the state, or the folder", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    const state = {
      schema: "seshi/capture-state/1" as const,
      agents: {},
      sessions: {
        "codex:t1": {
          agent: "codex",
          session_id: "t1",
          first_seen: "x",
          cwd: "/w/app",
          last_seen: "2026-11-01T11:00:00Z",
        },
        "claude-code:old": {
          agent: "claude-code",
          session_id: "old",
          first_seen: "x",
          cwd: "/w/app",
          last_seen: "2026-10-01T00:00:00Z",
        },
      },
    };
    expect(
      resolveSession(
        { positionals: [], session: true },
        state,
        { SESHI_SESSION_ID: "s9", SESHI_AGENT: "cursor" },
        "/",
        now,
      ),
    ).toEqual({
      agent: "cursor",
      id: "s9",
    });
    expect(resolveSession({ positionals: [], session: "t1" }, state, {}, "/", now)).toEqual({
      agent: "codex",
      id: "t1",
    });
    expect(resolveSession({ positionals: [], session: "zz" }, state, {}, "/", now)).toEqual({
      agent: "claude-code",
      id: "zz",
    });
    expect(
      resolveSession({ positionals: [], session: true }, state, {}, "/w/app/src", now),
    ).toEqual({ agent: "codex", id: "t1" });
    expect(
      resolveSession({ positionals: [], session: true }, state, {}, "/elsewhere", now),
    ).toContain("which session?");

    // Two sessions in the folder: it names them and picks neither. A subagent (same folder,
    // seen at the same moment as its parent) is never a candidate.
    const busy = {
      ...state,
      sessions: {
        ...state.sessions,
        "codex:t2": {
          ...state.sessions["codex:t1"],
          session_id: "t2",
          last_seen: "2026-11-01T11:59:00Z",
        },
        "claude-code:main": {
          agent: "claude-code",
          session_id: "main",
          first_seen: "x",
          cwd: "/w/app",
          last_seen: "2026-11-01T11:30:00Z",
        },
        "claude-code:agent-a": {
          agent: "claude-code",
          session_id: "agent-a",
          parent_session_id: "main",
          first_seen: "x",
          cwd: "/w/app",
          last_seen: "2026-11-01T11:30:00Z",
        },
      },
    };
    const both = resolveSession({ positionals: [], session: true }, busy, {}, "/w/app", now);
    expect(both).toContain("more than one ran here");
    expect(both).toContain("codex t2");
    expect(both).toContain("codex t1");
    expect(both).not.toContain("agent-a");
    expect(
      resolveSession(
        { positionals: [], session: true, agent: "claude-code" },
        busy,
        {},
        "/w/app",
        now,
      ),
    ).toEqual({ agent: "claude-code", id: "main" });
    expect(
      resolveSession({ positionals: [], session: "x", agent: "vim" }, state, {}, "/", now),
    ).toContain("does not capture 'vim'");
  });
});
