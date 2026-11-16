import { describe, expect, it } from "vitest";
import {
  type CaptureRules,
  DEFAULT_RULES,
  type DecideInput,
  decide,
  folderRule,
  normalizeRemote,
  type Place,
  remoteMatches,
  within,
} from "./rules";

const repo = (config: Place["repo"] extends infer R ? Partial<NonNullable<R>> : never = {}) => ({
  root: "/work/app",
  config: {},
  remotes: ["github.com/acme/app"],
  ...config,
});

const judge = (input: Partial<DecideInput>, platform: NodeJS.Platform = "linux") =>
  decide({ rules: DEFAULT_RULES, place: { cwd: "/work/app" }, ...input }, platform);

describe("remotes", () => {
  it("normalizes https, scp-like and ssh remotes to host/path", () => {
    expect(normalizeRemote("https://github.com/acme/app.git")).toBe("github.com/acme/app");
    expect(normalizeRemote("git@github.com:acme/app.git")).toBe("github.com/acme/app");
    expect(normalizeRemote("ssh://git@GitHub.com:22/acme/app")).toBe("github.com/acme/app");
    expect(normalizeRemote("https://user:pw@gitlab.example.com/a/b/")).toBe(
      "gitlab.example.com/a/b",
    );
  });

  it("matches a pattern with wildcards, or everything under one without", () => {
    expect(remoteMatches("github.com/acme/app", "github.com/acme")).toBe(true);
    expect(remoteMatches("github.com/acme/app", "github.com/acme/*")).toBe(true);
    expect(remoteMatches("github.com/acme-evil/app", "github.com/acme")).toBe(false);
    expect(remoteMatches("github.com/acme/team/app", "github.com/acme/*")).toBe(false);
    expect(remoteMatches("github.com/acme/team/app", "github.com/acme/**")).toBe(true);
    expect(remoteMatches("github.com/acme/app", "https://github.com/acme/app.git")).toBe(true);
  });
});

describe("folders", () => {
  it("compares whole path segments", () => {
    expect(within("/a/b", "/a/b", "linux")).toBe(true);
    expect(within("/a/b/c", "/a/b/", "linux")).toBe(true);
    expect(within("/a/bc", "/a/b", "linux")).toBe(false);
    expect(within("/A/b", "/a/b", "linux")).toBe(false);
  });

  it("is case-insensitive on Windows, either slash", () => {
    expect(within("C:\\Users\\Me\\Work\\x", "c:/users/me/work", "win32")).toBe(true);
  });

  it("picks the longest folder rule, by the real path too", () => {
    const rules: CaptureRules = {
      enabled: true,
      remotes: [],
      paths: [
        { path: "/work", capture: false },
        { path: "/link/app", real: "/work/app", capture: true },
      ],
    };
    expect(folderRule(rules, { cwd: "/work/app/src" }, "linux")?.capture).toBe(true);
    expect(folderRule(rules, { cwd: "/work/other" }, "linux")?.capture).toBe(false);
    expect(folderRule(rules, { cwd: "/elsewhere" }, "linux")).toBeUndefined();
  });
});

describe("the decision (F9.5)", () => {
  it("captures by default once installed", () => {
    expect(judge({})).toEqual({ capture: true, level: "global", reason: "capture is on" });
  });

  it("captures nothing while the CLI config cannot be read", () => {
    expect(judge({ rulesError: "bad" })).toMatchObject({ capture: false, level: "config" });
  });

  it("refuses a session whose folder is not known", () => {
    expect(judge({ place: {} })).toMatchObject({ capture: false, level: "unknown" });
    expect(judge({ place: {}, toggle: "on" })).toMatchObject({ capture: false });
  });

  it("the org rule turns capture off outside the org's repos, whatever the person says", () => {
    const rules = { ...DEFAULT_RULES, remotes: ["github.com/acme"] };
    expect(judge({ rules, place: { cwd: "/work/app", repo: repo() } }).capture).toBe(true);
    const other = { cwd: "/x", repo: repo({ remotes: ["github.com/other/x"] }) };
    expect(judge({ rules, place: other, toggle: "on" })).toMatchObject({
      capture: false,
      level: "org",
    });
    expect(judge({ rules, place: { cwd: "/tmp" } })).toMatchObject({
      capture: false,
      level: "org",
    });
  });

  it("a repo's capture = false beats a session turned on and a folder rule", () => {
    const place = { cwd: "/work/app", repo: repo({ config: { capture: false } }) };
    const rules = { ...DEFAULT_RULES, paths: [{ path: "/work", capture: true }] };
    expect(judge({ rules, place, toggle: "on" })).toMatchObject({ capture: false, level: "repo" });
  });

  it("a repo config it cannot read turns capture off there", () => {
    const place = { cwd: "/work/app", repo: repo({ config: { invalid: "bad toml" } }) };
    expect(judge({ place })).toMatchObject({ capture: false, level: "repo" });
  });

  it("a pause beats a session turned on", () => {
    expect(judge({ paused: true, toggle: "on" })).toMatchObject({ capture: false, level: "pause" });
  });

  it("a pause stops a session where it is: at what it uploaded, or nothing for a new one", () => {
    expect(judge({ paused: true, uploaded: 120 })).toMatchObject({
      capture: false,
      level: "pause",
      frozen: 120,
    });
    expect(judge({ paused: true })).toMatchObject({ capture: false, frozen: 0 });
    // A session turned off is off, pause or not: its own level says so, and nothing freezes.
    expect(judge({ paused: true, toggle: "off" })).toEqual({
      capture: false,
      level: "session",
      reason: "turned off for this session",
    });
  });

  it("a session a pause stopped stays stopped after it ends, whatever the levels below say", () => {
    expect(judge({ frozen: 80, uploaded: 80 })).toMatchObject({
      capture: false,
      level: "pause",
      frozen: 80,
    });
    const rules = { ...DEFAULT_RULES, paths: [{ path: "/work", capture: true }] };
    expect(judge({ rules, frozen: 80 })).toMatchObject({ level: "pause", frozen: 80 });
    // The shared rules still win: they say off without an offset.
    const place = { cwd: "/work/app", repo: repo({ config: { capture: false } }) };
    expect(judge({ place, frozen: 80 })).toMatchObject({ level: "repo" });
    expect(judge({ place, frozen: 80 }).frozen).toBeUndefined();
  });

  it("a session that started during a pause is off, even when first seen after it", () => {
    const pauses = [{ at: "2026-11-01T10:00:00Z", until: "2026-11-01T12:00:00Z" }];
    expect(judge({ pauses, started: "2026-11-01T11:00:00Z" })).toMatchObject({
      capture: false,
      level: "pause",
      frozen: 0,
      reason: "it started while capture was paused",
    });
    expect(judge({ pauses, started: "2026-11-01T12:00:00Z" })).toMatchObject({ capture: true });
    expect(judge({ pauses, started: "2026-11-01T09:59:59Z" })).toMatchObject({ capture: true });
    // An open-ended pause runs until resumed.
    expect(
      judge({ pauses: [{ at: "2026-11-01T10:00:00Z" }], started: "2026-11-02T00:00:00Z" }),
    ).toMatchObject({ level: "pause" });
    expect(judge({ pauses })).toMatchObject({ capture: true });
  });

  it("a session turned on after a pause began is not stopped by that pause", () => {
    const pausedAt = "2026-11-01T10:00:00Z";
    expect(
      judge({ paused: true, pausedAt, toggle: "on", toggledAt: "2026-11-01T10:30:00Z" }),
    ).toMatchObject({ capture: true, level: "session" });
    expect(
      judge({ paused: true, pausedAt, toggle: "on", toggledAt: "2026-11-01T09:30:00Z" }),
    ).toMatchObject({ capture: false, level: "pause" });
    const pauses = [{ at: pausedAt, until: "2026-11-01T12:00:00Z" }];
    expect(
      judge({
        pauses,
        started: "2026-11-01T11:00:00Z",
        toggle: "on",
        toggledAt: "2026-11-01T13:00:00Z",
      }),
    ).toMatchObject({ capture: true, level: "session" });
  });

  it("the most specific personal level decides: session, then folder, then global", () => {
    const rules: CaptureRules = {
      enabled: false,
      remotes: [],
      paths: [
        { path: "/work", capture: true },
        { path: "/work/app", capture: false },
      ],
    };
    expect(judge({ rules, toggle: "on" })).toMatchObject({ capture: true, level: "session" });
    expect(judge({ rules })).toMatchObject({ capture: false, level: "folder" });
    expect(judge({ rules, place: { cwd: "/work/lib" } })).toMatchObject({
      capture: true,
      level: "folder",
    });
    expect(judge({ rules, place: { cwd: "/home" } })).toMatchObject({
      capture: false,
      level: "global",
    });
    expect(judge({ toggle: "off" })).toMatchObject({ capture: false, level: "session" });
  });

  it("turns a session off when a shared rule excludes any folder it was seen in", () => {
    const excluded: Place = {
      cwd: "/work/secret",
      repo: repo({ root: "/work/secret", config: { capture: false } }),
    };
    const here: Place = { cwd: "/work/app", repo: repo() };
    expect(judge({ place: here, seen: [excluded], toggle: "on" })).toMatchObject({
      capture: false,
      level: "repo",
      reason: "it also ran in /work/secret, where the repo turns capture off (.seshi/config.toml)",
    });
    const rules: CaptureRules = { ...DEFAULT_RULES, remotes: ["github.com/acme"] };
    expect(judge({ rules, place: here, seen: [{ cwd: "/tmp" }] })).toMatchObject({
      capture: false,
      level: "org",
    });
    // Personal rules go by the folder it is in now.
    const paths: CaptureRules = { ...DEFAULT_RULES, paths: [{ path: "/home", capture: false }] };
    expect(judge({ rules: paths, place: here, seen: [{ cwd: "/home/x" }] })).toMatchObject({
      capture: true,
    });
  });
});

describe("the order of the levels: each beats the one below it", () => {
  const orgOnly: CaptureRules = { ...DEFAULT_RULES, remotes: ["github.com/acme"] };
  const offRepo: Place = {
    cwd: "/work/secret",
    repo: repo({ root: "/work/secret", config: { capture: false } }),
  };
  const pauses = [{ at: "2026-11-01T10:00:00Z", until: "2026-11-01T12:00:00Z" }];

  it("an unreadable CLI config beats an unknown folder", () => {
    expect(judge({ rulesError: "bad", place: {} })).toMatchObject({ level: "config" });
  });

  it("an unknown folder beats the shared rules", () => {
    expect(judge({ rules: orgOnly, place: {} })).toMatchObject({ level: "unknown" });
  });

  it("the shared rules where it runs beat those of a folder it was seen in", () => {
    expect(judge({ rules: orgOnly, place: offRepo, seen: [{ cwd: "/tmp" }] })).toEqual({
      capture: false,
      level: "repo",
      reason: "the repo turns capture off (.seshi/config.toml)",
    });
  });

  it("the shared rules of a folder it was seen in beat a session turned off", () => {
    expect(judge({ place: { cwd: "/work/app" }, seen: [offRepo], toggle: "off" })).toMatchObject({
      level: "repo",
    });
  });

  it("a session turned off beats a pause that stopped it", () => {
    expect(judge({ toggle: "off", frozen: 80 })).toEqual({
      capture: false,
      level: "session",
      reason: "turned off for this session",
    });
  });

  it("a pause that stopped it beats the pause in force: it stays at its first offset", () => {
    expect(judge({ frozen: 80, paused: true, uploaded: 120 })).toEqual({
      capture: false,
      level: "pause",
      reason: "stopped by a pause; seshi capture on --session turns it back on",
      frozen: 80,
    });
  });

  it("the pause in force beats a pause it started in", () => {
    expect(judge({ paused: true, pauses, started: "2026-11-01T11:00:00Z", uploaded: 40 })).toEqual({
      capture: false,
      level: "pause",
      reason: "capture is paused: the session stops where it is",
      frozen: 40,
    });
  });

  it("a pause it started in beats a session turned on before that pause", () => {
    expect(
      judge({
        pauses,
        started: "2026-11-01T11:00:00Z",
        toggle: "on",
        toggledAt: "2026-11-01T09:00:00Z",
      }),
    ).toMatchObject({ capture: false, level: "pause" });
  });

  it("a session turned on beats a folder rule, and a folder rule beats the global one", () => {
    const rules: CaptureRules = {
      enabled: false,
      remotes: [],
      paths: [{ path: "/work", capture: false }],
    };
    expect(judge({ rules, toggle: "on" })).toMatchObject({ capture: true, level: "session" });
    expect(judge({ rules: { ...rules, paths: [{ path: "/work", capture: true }] } })).toMatchObject(
      { capture: true, level: "folder" },
    );
  });
});
