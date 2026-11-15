import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findRepo, gitRemotes, headBranch, parseRepoConfig, placeOf } from "./place";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "seshi-place-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, text: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const GIT_CONFIG = `[core]
\tbare = false
[remote "origin"]
\turl = git@github.com:acme/app.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "fork"]
\turl = "https://github.com/me/app"
[branch "main"]
\tremote = origin
`;

describe("git files", () => {
  it("reads remotes and the branch without git", () => {
    expect(gitRemotes(GIT_CONFIG)).toEqual(["github.com/acme/app", "github.com/me/app"]);
    expect(headBranch("ref: refs/heads/feature/x\n")).toBe("feature/x");
    expect(headBranch("0123abcd\n")).toBeUndefined();
  });

  it("finds a repo from a folder inside it, and a worktree's shared config", () => {
    write("app/.git/config", GIT_CONFIG);
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    mkdirSync(join(dir, "app/src/deep"), { recursive: true });
    expect(findRepo(join(dir, "app/src/deep"))).toEqual({
      root: join(dir, "app"),
      gitDir: join(dir, "app/.git"),
      commonDir: join(dir, "app/.git"),
    });
    write("app/.git/worktrees/wt/commondir", "../..\n");
    write("app/.git/worktrees/wt/HEAD", "ref: refs/heads/wt-branch\n");
    write("wt/.git", `gitdir: ${join(dir, "app/.git/worktrees/wt")}\n`);
    const place = placeOf(join(dir, "wt"));
    expect(place.repo).toEqual({
      root: join(dir, "wt"),
      config: {},
      remotes: ["github.com/acme/app", "github.com/me/app"],
      branch: "wt-branch",
    });
    expect(findRepo(dir)).toBeUndefined();
  });
});

describe("the repo's .seshi/config.toml", () => {
  it("reads capture and visibility, and leaves other keys alone", () => {
    expect(parseRepoConfig(undefined)).toEqual({});
    expect(parseRepoConfig('capture = false\nvisibility = "owner"\nother = 1\n')).toEqual({
      capture: false,
      visibility: "owner",
    });
  });

  it("is unreadable with a wrong type or bad TOML (capture turns off there)", () => {
    expect(parseRepoConfig('capture = "no"').invalid).toContain("true or false");
    expect(parseRepoConfig('visibility = "all"').invalid).toContain("visibility");
    expect(parseRepoConfig("capture = = 1").invalid).toBeDefined();
  });

  it("is part of the place", () => {
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    write("app/.seshi/config.toml", "capture = false\n");
    expect(placeOf(join(dir, "app")).repo?.config).toEqual({ capture: false });
  });
});

describe("placeOf", () => {
  it("knows nothing without a folder", () => {
    expect(placeOf(undefined)).toEqual({});
    expect(placeOf("")).toEqual({});
  });

  it("resolves a symbolic link to the real folder", () => {
    mkdirSync(join(dir, "real"));
    // A junction on Windows: a directory symlink there needs a privilege CI runners lack.
    symlinkSync(
      join(dir, "real"),
      join(dir, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(placeOf(join(dir, "link"))).toEqual({ cwd: join(dir, "link"), real: join(dir, "real") });
  });
});
