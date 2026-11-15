import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook, shellWord } from "./hook";
import { type CapturePaths, capturePaths } from "./paths";
import { captureRules } from "./rules-cache";
import { readSpool, spoolCount } from "./spool";
import { updateState } from "./state";
import { statusLine } from "./status";

let dir: string;
let host: CaptureHost;
let paths: CapturePaths;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-hook-")));
  host = { env: { XDG_CONFIG_HOME: join(dir, "config") }, home: dir, platform: "linux" };
  paths = capturePaths(host);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cliConfig(text: string): void {
  mkdirSync(join(dir, "config", "seshi"), { recursive: true });
  writeFileSync(join(dir, "config", "seshi", "config.toml"), text);
}

/** An agent whose hook payload is `{id, cwd, path?}`; `Start` exports env, `Both` captures two. */
const agent: CaptureAgent = {
  name: "fake",
  format: "claude-code",
  encoding: "jsonl",
  chunkable: true,
  hooks: [
    {
      event: "Stop",
      parse: (p) => {
        const { id, cwd, path } = p as { id: string; cwd?: string; path?: string };
        if (!id) throw new Error("no id");
        return {
          captures: [
            { session_id: id, ...(cwd ? { cwd } : {}), ...(path ? { transcript_path: path } : {}) },
          ],
        };
      },
    },
    {
      // A subagent's stop: the parent and the subagent, as Claude Code's SubagentStop.
      event: "SubagentStop",
      parse: (p) => {
        const { id, cwd, sub } = p as { id: string; cwd: string; sub: string };
        return {
          captures: [
            { session_id: id, cwd },
            { session_id: sub, cwd, transcript_path: `/t/${sub}.jsonl`, parent_session_id: id },
          ],
        };
      },
    },
    {
      event: "Start",
      parse: (p, h) => ({
        captures: [],
        exportEnv: {
          file: h.env.ENV_FILE as string,
          vars: { SESHI_SESSION_ID: (p as { id: string }).id },
        },
      }),
    },
  ],
  sweep: [],
  identify: () => null,
};

describe("runHook (F9.1)", () => {
  it("spools a session the rules capture, with what the payload said", async () => {
    const outcome = await runHook({
      agent,
      event: "Stop",
      payload: { id: "s1", cwd: dir, path: "/t/s1.jsonl" },
      host,
      paths,
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(outcome.spooled).toHaveLength(1);
    expect(readSpool(paths).items.map((i) => i.entry)).toEqual([
      {
        v: 1,
        kind: "capture",
        at: "2026-11-01T00:00:00.000Z",
        agent: "fake",
        event: "Stop",
        session_id: "s1",
        transcript_path: "/t/s1.jsonl",
        cwd: dir,
      },
    ]);
  });

  it("skips what the rules exclude, by any level, and says why", async () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", ".seshi"));
    writeFileSync(join(dir, "repo", ".seshi", "config.toml"), "capture = false\n");
    const repo = await runHook({
      agent,
      event: "Stop",
      payload: { id: "a", cwd: join(dir, "repo") },
      host,
      paths,
    });
    expect(repo.skipped[0]?.decision.level).toBe("repo");

    await updateState(paths, (s) => {
      s.sessions["fake:b"] = { agent: "fake", session_id: "b", first_seen: "x", toggle: "off" };
    });
    const off = await runHook({
      agent,
      event: "Stop",
      payload: { id: "b", cwd: dir },
      host,
      paths,
    });
    expect(off.skipped[0]?.decision.level).toBe("session");

    const unknown = await runHook({ agent, event: "Stop", payload: { id: "c" }, host, paths });
    expect(unknown.skipped[0]?.decision.level).toBe("unknown");
    // Only the repo's exclusion is handed on, as a folder seen (no work, no uploader).
    expect(readSpool(paths).items.map((i) => i.entry)).toEqual([
      expect.objectContaining({ kind: "seen", session_id: "a", cwd: join(dir, "repo") }),
    ]);
    expect(spoolCount(paths)).toBe(0);
  });

  it("judges a session by every folder it was seen in, so leaving an excluded repo is not enough", async () => {
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", ".seshi"));
    writeFileSync(join(dir, "repo", ".seshi", "config.toml"), "capture = false\n");
    await updateState(paths, (s) => {
      s.sessions["fake:a"] = {
        agent: "fake",
        session_id: "a",
        first_seen: "x",
        cwd: join(dir, "repo"),
        folders: [join(dir, "repo")],
      };
    });
    const moved = await runHook({
      agent,
      event: "Stop",
      payload: { id: "a", cwd: dir },
      host,
      paths,
    });
    expect(moved.skipped[0]?.decision).toMatchObject({ capture: false, level: "repo" });
    expect(moved.spooled).toEqual([]);
  });

  it("skips a subagent of a session turned off, unless the subagent is turned on itself", async () => {
    await updateState(paths, (s) => {
      s.sessions["fake:main1"] = {
        agent: "fake",
        session_id: "main1",
        first_seen: "x",
        toggle: "off",
      };
    });
    const payload = { id: "main1", cwd: dir, sub: "agent-abc" };
    const off = await runHook({ agent, event: "SubagentStop", payload, host, paths });
    expect(off.spooled).toEqual([]);
    expect(off.skipped.map((s) => [s.session_id, s.decision.level])).toEqual([
      ["main1", "session"],
      ["agent-abc", "session"],
    ]);
    expect(readSpool(paths).items).toHaveLength(0);

    await updateState(paths, (s) => {
      s.sessions["fake:agent-abc"] = {
        agent: "fake",
        session_id: "agent-abc",
        parent_session_id: "main1",
        first_seen: "x",
        toggle: "on",
      };
    });
    const own = await runHook({ agent, event: "SubagentStop", payload, host, paths });
    expect(own.spooled.map((c) => c.session_id)).toEqual(["agent-abc"]);
  });

  it("uses the folder a session was seen in before, when the payload has none", async () => {
    await updateState(paths, (s) => {
      s.sessions["fake:d"] = { agent: "fake", session_id: "d", first_seen: "x", cwd: dir };
    });
    expect(
      (await runHook({ agent, event: "Stop", payload: { id: "d" }, host, paths })).spooled,
    ).toHaveLength(1);
  });

  it("follows the CLI config's rules, read again when the file changes", async () => {
    cliConfig(`[[capture.paths]]\npath = "~/private"\ncapture = false\n`);
    mkdirSync(join(dir, "private"));
    const first = await runHook({
      agent,
      event: "Stop",
      payload: { id: "e", cwd: join(dir, "private") },
      host,
      paths,
    });
    expect(first.skipped[0]?.decision.level).toBe("folder");
    cliConfig(`[capture]\nenabled = true\n`);
    const second = await runHook({
      agent,
      event: "Stop",
      payload: { id: "e", cwd: join(dir, "private") },
      host,
      paths,
    });
    expect(second.spooled).toHaveLength(1);
    cliConfig(`[capture]\nenabled = "yes"\n`);
    const broken = await runHook({
      agent,
      event: "Stop",
      payload: { id: "f", cwd: dir },
      host,
      paths,
    });
    expect(broken.skipped[0]?.decision.level).toBe("config");
  });

  it("writes the variables the handler exports, quoted for a shell", async () => {
    const file = join(dir, "env");
    const outcome = await runHook({
      agent,
      event: "Start",
      payload: { id: "it's" },
      host: { ...host, env: { ...host.env, ENV_FILE: file } },
      paths,
    });
    expect(outcome.exported).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(`export SESHI_SESSION_ID='it'\\''s'\n`);
    expect(shellWord("a b")).toBe("'a b'");
  });

  it("ignores an event it has no handler for, and throws on a payload it cannot read", async () => {
    expect((await runHook({ agent, event: "Other", payload: {}, host, paths })).ignored).toContain(
      "no 'Other'",
    );
    await expect(runHook({ agent, event: "Stop", payload: {}, host, paths })).rejects.toThrow(
      "no id",
    );
  });
});

describe("the rules cache", () => {
  it("serves the cached rules until the file or the env changes", async () => {
    cliConfig("[capture]\nenabled = false\n");
    expect((await captureRules(host, paths)).rules.enabled).toBe(false);
    // Tamper with the cache: a matching key is trusted, so the tampered value comes back.
    const cached = JSON.parse(readFileSync(paths.rules, "utf8"));
    cached.snapshot.rules.enabled = true;
    writeFileSync(paths.rules, JSON.stringify(cached));
    expect((await captureRules(host, paths)).rules.enabled).toBe(true);
    // An env override changes the key, so the config is loaded again.
    const env = { ...host.env, SESHI_CAPTURE__ENABLED: "false" };
    expect((await captureRules({ ...host, env }, paths)).rules.enabled).toBe(false);
  });

  it("expands ~ in folder rules and keeps the org rule and the theme", async () => {
    cliConfig(
      `theme = "light"\n[capture]\nremotes = ["github.com/acme"]\n[[capture.paths]]\npath = "~/x"\ncapture = true\n`,
    );
    const snapshot = await captureRules(host, paths);
    expect(snapshot).toEqual({
      rules: {
        enabled: true,
        paths: [{ path: join(dir, "x"), capture: true }],
        remotes: ["github.com/acme"],
      },
      theme: "light",
    });
  });

  it("is not confused by capture's own SESHI_ variables", async () => {
    const env = {
      ...host.env,
      SESHI_SESSION_ID: "s",
      SESHI_AGENT: "claude-code",
      SESHI_NO_UPLOADER: "1",
    };
    expect((await captureRules({ ...host, env }, paths)).error).toBeUndefined();
  });

  it("never serves one environment's config error to another", async () => {
    cliConfig("[capture]\nenabled = true\n");
    const typo = { ...host.env, SESHI_SERVR: "https://x" };
    expect((await captureRules({ ...host, env: typo }, paths)).error).toBeDefined();
    expect((await captureRules(host, paths)).error).toBeUndefined();
  });
});

describe("the status line's words (B1.6)", () => {
  const capturing = { capture: true, level: "global" as const, reason: "" };
  it("says capturing, or not, with problems after it, at most two", () => {
    const state = {
      schema: "seshi/capture-state/1" as const,
      agents: {},
      sessions: {},
      uploader: { queued: 2 },
      problems: { sign_in: { message: "m", at: "x" }, upload: { message: "m", at: "x" } },
    };
    expect(statusLine({ state, decision: capturing, spooled: 1 })).toEqual({
      capturing: true,
      problems: [
        { text: "sign in", kind: "warn" },
        { text: "upload failing", kind: "error" },
      ],
    });
    expect(
      statusLine({ state: { ...state, problems: {} }, decision: capturing, spooled: 1 }).problems,
    ).toEqual([{ text: "3 queued", kind: "progress" }]);
    expect(statusLine({ state: undefined, decision: capturing, spooled: 0 })).toEqual({
      capturing: false,
      problems: [{ text: "state unreadable", kind: "error" }],
    });
  });
});
