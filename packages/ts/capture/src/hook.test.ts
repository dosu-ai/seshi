import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureAgent, CaptureHost } from "@seshi/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook, shellWord } from "./hook";
import { type CapturePaths, capturePaths } from "./paths";
import { captureRules, excludeRule } from "./rules-cache";
import { readSpool, spoolCount } from "./spool";
import { updateState } from "./state";
import { statusLine } from "./status";

let dir: string;
let host: CaptureHost;
let paths: CapturePaths;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-hook-")));
  // The CLI config under dir/config on every platform (%APPDATA% on Windows, else XDG), and
  // this machine's platform, so folder rules compare paths as they are written here.
  const config = join(dir, "config");
  host = {
    env: { XDG_CONFIG_HOME: config, APPDATA: config },
    home: dir,
    platform: process.platform,
  };
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
        // Resolved at first sight: none configured, so none, pinned.
        labels: {},
      },
    ]);
  });

  it("records the commit HEAD names as the hook fires", async () => {
    const sha = "c".repeat(40);
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    writeFileSync(join(dir, "repo", ".git", "HEAD"), `${sha}\n`);
    await runHook({
      agent,
      event: "Stop",
      payload: { id: "s1", cwd: join(dir, "repo"), path: "/t/s1.jsonl" },
      host,
      paths,
      now: new Date("2026-11-01T00:00:00Z"),
    });
    expect(readSpool(paths).items[0]?.entry).toMatchObject({ session_id: "s1", commit: sha });
  });

  it("resolves labels in the agent's environment at first sight, and only then", async () => {
    cliConfig(
      `[labels]\n"dosu.project" = { env = "DOSU_PROJECT" }\nteam = "platform"\nBad = "x"\n[[labels.paths]]\npath = ${JSON.stringify(dir)}\nfolder = "here"\n`,
    );
    const stop = (env: Record<string, string>) =>
      runHook({
        agent,
        event: "Stop",
        payload: { id: "s1", cwd: dir, path: "/t/s1.jsonl" },
        host: { ...host, env: { ...host.env, ...env } },
        paths,
      });
    const first = await stop({ DOSU_PROJECT: "github.com/acme/app" });
    expect(readSpool(paths).items[0]?.entry).toMatchObject({
      labels: { "dosu.project": "github.com/acme/app", team: "platform", folder: "here" },
    });
    // A label out of the limits is left out and said, never a failure.
    expect(first.problems).toEqual([expect.stringContaining("labels: left out label key 'Bad'")]);
    // Once the session's labels are in its state, a later hook resolves none.
    await updateState(paths, (st) => {
      st.sessions["fake:s1"] = {
        agent: "fake",
        session_id: "s1",
        cwd: dir,
        first_seen: "2026-11-01T00:00:00Z",
        labels: { "dosu.project": "github.com/acme/app" },
      };
    });
    const later = await stop({ DOSU_PROJECT: "github.com/acme/other" });
    expect(readSpool(paths).items[1]?.entry).not.toHaveProperty("labels");
    expect(later.problems).toBeUndefined();
  });

  it("writes a transcript the hook was handed whole, for a captured session only", async () => {
    // OpenCode keeps no transcript file: its plugin hands seshi the session itself.
    const handed: CaptureAgent = {
      ...agent,
      name: "handed",
      encoding: "json",
      chunkable: false,
      hooks: [
        {
          event: "Stop",
          parse: (p) => {
            const { id, cwd } = p as { id: string; cwd: string };
            return { captures: [{ session_id: id, cwd, transcript: `{"id":"${id}"}` }] };
          },
        },
      ],
    };
    const run = (id: string) =>
      runHook({ agent: handed, event: "Stop", payload: { id, cwd: dir }, host, paths });
    const file = join(paths.dir, "transcripts", "handed", "s1.json");
    const outcome = await run("s1");
    expect(outcome.spooled).toEqual([{ session_id: "s1", cwd: dir, transcript_path: file }]);
    expect(readFileSync(file, "utf8")).toBe('{"id":"s1"}');
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readSpool(paths).items[0]?.entry).toMatchObject({ transcript_path: file });

    await updateState(paths, (s) => {
      s.sessions["handed:s2"] = {
        agent: "handed",
        session_id: "s2",
        first_seen: "x",
        toggle: "off",
      };
    });
    // A copy from before it was turned off goes too.
    mkdirSync(join(paths.dir, "transcripts", "handed"), { recursive: true });
    writeFileSync(join(paths.dir, "transcripts", "handed", "s2.json"), '{"id":"s2"}');
    expect((await run("s2")).skipped).toHaveLength(1);
    expect(existsSync(join(paths.dir, "transcripts", "handed", "s2.json"))).toBe(false);
    await expect(run("../escape")).rejects.toThrow("unusable session id");
  });

  it("spools a captured session whose transcript cannot be read yet, and says why", async () => {
    // OpenCode 2.x's plugin names only the session; seshi reads it from OpenCode's database.
    const named: CaptureAgent = {
      ...agent,
      name: "named",
      encoding: "json",
      chunkable: false,
      hooks: [
        {
          event: "Stop",
          parse: (p) => {
            const { id, cwd } = p as { id: string; cwd: string };
            return {
              captures: [
                {
                  session_id: id,
                  cwd,
                  read: async () => {
                    if (id === "busy") throw new Error("database is locked");
                    return { transcript: `{"id":"${id}"}`, changedMs: 1_700_000_000_000 };
                  },
                },
              ],
            };
          },
        },
      ],
    };
    const run = (id: string) =>
      runHook({ agent: named, event: "Stop", payload: { id, cwd: dir }, host, paths });
    const busy = await run("busy");
    expect(busy.spooled).toEqual([{ session_id: "busy", cwd: dir }]);
    expect(busy.problems).toEqual(["named: could not read session busy yet: database is locked"]);
    expect(existsSync(join(paths.dir, "transcripts", "named", "busy.json"))).toBe(false);
    const read = await run("s1");
    const file = join(paths.dir, "transcripts", "named", "s1.json");
    expect(read.spooled).toEqual([{ session_id: "s1", cwd: dir, transcript_path: file }]);
    expect(read.problems).toBeUndefined();
    expect(statSync(file).mtimeMs).toBe(1_700_000_000_000);
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

  it("hands a session seen during a pause to the uploader to stop, and nothing to upload", async () => {
    const now = new Date("2026-11-01T00:00:00Z");
    await updateState(paths, (s) => {
      s.paused = { at: now.toISOString() };
      s.sessions["fake:old"] = {
        agent: "fake",
        session_id: "old",
        first_seen: "x",
        path: "/t/old.jsonl",
        frozen: { at: "x", offset: 10 },
      };
    });
    const run = (id: string, at = now, path = `/t/${id}.jsonl`) =>
      runHook({
        agent,
        event: "Stop",
        payload: { id, cwd: dir, path },
        host,
        paths,
        now: at,
      });
    const outcome = await run("new");
    expect(outcome.spooled).toEqual([]);
    expect(outcome.skipped[0]?.decision).toMatchObject({ level: "pause", frozen: 0 });
    // One already stopped needs nothing more.
    expect((await run("old")).skipped[0]?.decision).toMatchObject({ frozen: 10 });
    expect(readSpool(paths).items.map((i) => i.entry)).toEqual([
      {
        v: 1,
        kind: "paused",
        at: now.toISOString(),
        agent: "fake",
        session_id: "new",
        cwd: dir,
        transcript_path: "/t/new.jsonl",
      },
    ]);
    expect(spoolCount(paths)).toBe(0);
    // Unless its transcript moved (33): the uploader is told the new path, or its sweep would
    // forget the session, its stop and its retraction secret.
    await run("old", now, "/t/moved/old.jsonl");
    expect(
      readSpool(paths).items.find((i) => i.entry.kind === "paused" && i.entry.session_id === "old")
        ?.entry,
    ).toMatchObject({
      kind: "paused",
      session_id: "old",
      transcript_path: "/t/moved/old.jsonl",
    });
    // Once the pause is over, a stopped session is still skipped; a new one is captured.
    await updateState(paths, (s) => {
      delete s.paused;
    });
    expect((await run("old")).skipped[0]?.decision).toMatchObject({ level: "pause" });
    expect((await run("later")).spooled).toHaveLength(1);
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

  it("skips a subagent whose parent worked in an excluded repo, wherever the subagent runs", async () => {
    // The parent visited excluded repo A, then cd'd to B and started a subagent there.
    mkdirSync(join(dir, "a", ".git"), { recursive: true });
    mkdirSync(join(dir, "a", ".seshi"));
    writeFileSync(join(dir, "a", ".seshi", "config.toml"), "capture = false\n");
    mkdirSync(join(dir, "b", ".git"), { recursive: true });
    await updateState(paths, (s) => {
      s.sessions["fake:main1"] = {
        agent: "fake",
        session_id: "main1",
        first_seen: "x",
        cwd: join(dir, "b"),
        folders: [join(dir, "a"), join(dir, "b")],
      };
    });
    const payload = { id: "main1", cwd: join(dir, "b"), sub: "agent-abc" };
    const outcome = await runHook({ agent, event: "SubagentStop", payload, host, paths });
    expect(outcome.spooled).toEqual([]);
    expect(outcome.skipped.map((s) => [s.session_id, s.decision.level])).toEqual([
      ["main1", "repo"],
      ["agent-abc", "repo"],
    ]);
  });

  it("skips a subagent whose parent worked in a repo the org excludes, wherever it runs", async () => {
    cliConfig(`[capture]\nexclude = ["acme/payments"]\n`);
    mkdirSync(join(dir, "payments", ".git"), { recursive: true });
    writeFileSync(
      join(dir, "payments", ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:Acme/Payments.git\n`,
    );
    mkdirSync(join(dir, "b", ".git"), { recursive: true });
    await updateState(paths, (s) => {
      s.sessions["fake:main1"] = {
        agent: "fake",
        session_id: "main1",
        first_seen: "x",
        cwd: join(dir, "b"),
        folders: [join(dir, "payments"), join(dir, "b")],
      };
    });
    const payload = { id: "main1", cwd: join(dir, "b"), sub: "agent-abc" };
    const outcome = await runHook({ agent, event: "SubagentStop", payload, host, paths });
    expect(outcome.spooled).toEqual([]);
    expect(outcome.skipped.map((s) => [s.session_id, s.decision.level])).toEqual([
      ["main1", "org"],
      ["agent-abc", "org"],
    ]);
    expect(outcome.skipped[1]?.decision.reason).toContain("acme/payments (capture.exclude)");
  });

  it("skips a folder the org excludes, and a session that moved from it, turned on or not", async () => {
    cliConfig(`[capture]\nexclude = ["~/clients"]\n`);
    for (const folder of ["clients", "clients-old", "app"]) mkdirSync(join(dir, folder));
    const stop = (id: string, cwd: string) =>
      runHook({ agent, event: "Stop", payload: { id, cwd }, host, paths });
    expect((await stop("a", join(dir, "clients"))).skipped[0]?.decision).toMatchObject({
      level: "org",
      reason: "the org excludes ~/clients (capture.exclude)",
    });
    expect((await stop("b", join(dir, "clients-old"))).spooled).toHaveLength(1);
    // Session a, seen in ~/clients and turned on, moves on into a captured folder: still off.
    await updateState(paths, (s) => {
      s.sessions["fake:a"] = {
        agent: "fake",
        session_id: "a",
        first_seen: "x",
        cwd: join(dir, "clients"),
        folders: [join(dir, "clients")],
        toggle: "on",
      };
    });
    const moved = await stop("a", join(dir, "app"));
    expect(moved.spooled).toEqual([]);
    expect(moved.skipped[0]?.decision).toMatchObject({ capture: false, level: "org" });
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
    expect(outcome.envFileWritten).toBe(file);
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
        exclude: [],
      },
      theme: "light",
      labels: { labels: {}, paths: [] },
    });
  });

  it("reads the org's exclude list from the file or SESHI_CAPTURE__EXCLUDE", async () => {
    cliConfig(`[capture]\nexclude = ["", "# the payments team", "acme/payments", "~/clients"]\n`);
    expect((await captureRules(host, paths)).rules.exclude).toEqual([
      { entry: "acme/payments", repo: "acme/payments" },
      { entry: "~/clients", path: join(dir, "clients") },
    ]);
    const env = { ...host.env, SESHI_CAPTURE__EXCLUDE: "github.com/Acme/*,/srv/secret" };
    expect((await captureRules({ ...host, env }, paths)).rules.exclude).toEqual([
      { entry: "github.com/Acme/*", repo: "github.com/acme/*" },
      { entry: "/srv/secret", path: "/srv/secret" },
    ]);
  });

  it("reads an exclude entry as a repository, or a folder from /, ~, a drive or a share", () => {
    expect(excludeRule("  acme/app ", "/h")).toEqual({ entry: "acme/app", repo: "acme/app" });
    expect(excludeRule("git@github.com:Acme/app.git", "/h")).toEqual({
      entry: "git@github.com:Acme/app.git",
      repo: "github.com/acme/app",
    });
    expect(excludeRule("~", "/h")).toMatchObject({ entry: "~", path: "/h" });
    expect(excludeRule("~/x/*", "/h")).toEqual({ entry: "~/x/*", path: join("/h", "x/*") });
    expect(excludeRule("C:\\work", "/h")).toEqual({ entry: "C:\\work", path: "C:\\work" });
    expect(excludeRule("\\\\fs01\\projects", "/h")).toEqual({
      entry: "\\\\fs01\\projects",
      path: "\\\\fs01\\projects",
    });
    expect(excludeRule("", "/h")).toBeUndefined();
    expect(excludeRule("  # note", "/h")).toBeUndefined();
  });

  it("keeps control characters of an entry out of the messages that name it", () => {
    expect(excludeRule("acme/\x1b[2Japp", "/h")?.entry).toBe("acme/\uFFFD[2Japp");
  });

  it("resolves a folder entry's symbolic links up to its first wildcard", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(excludeRule("~/link", dir)).toEqual({
      entry: "~/link",
      path: join(dir, "link"),
      real: join(dir, "real"),
    });
    expect(excludeRule("~/link/*/secret", dir)).toEqual({
      entry: "~/link/*/secret",
      path: join(dir, "link", "*", "secret"),
      real: join(dir, "real", "*", "secret"),
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
