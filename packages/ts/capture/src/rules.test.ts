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
});
