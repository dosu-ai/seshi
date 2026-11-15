import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_FILE_MAX_BYTES, readBounded } from "./files";
import { findRepo, gitRemotes, headBranch, parseRepoConfig, placeOf } from "./place";
import { DEFAULT_RULES, decide, type RepoConfig } from "./rules";

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

describe("files a repo plants where its config and git files are", () => {
  /** placeOf on `app`, which must come back quickly; its repo config. */
  function judged(): RepoConfig | undefined {
    const started = Date.now();
    const place = placeOf(join(dir, "app"));
    expect(Date.now() - started).toBeLessThan(2000);
    return place.repo?.config;
  }

  it.skipIf(process.platform === "win32")(
    "turn capture off there, without hanging, when one is a link to /dev/zero",
    () => {
      write("app/.git/HEAD", "ref: refs/heads/main\n");
      mkdirSync(join(dir, "app/.seshi"));
      symlinkSync("/dev/zero", join(dir, "app/.seshi/config.toml"));
      expect(judged()?.invalid).toMatch(/config\.toml is not a regular file/);
      // The same through a worktree's .git pointer, its HEAD and its config.
      rmSync(join(dir, "app/.seshi"), { recursive: true });
      symlinkSync("/dev/zero", join(dir, "app/.git/config"));
      expect(judged()?.invalid).toMatch(/git's config is not a regular file/);
      rmSync(join(dir, "app/.git"), { recursive: true });
      write("gitdir/commondir", "..\n");
      symlinkSync("/dev/zero", join(dir, "gitdir/HEAD"));
      write("app/.git", `gitdir: ${join(dir, "gitdir")}\n`);
      expect(judged()?.invalid).toMatch(/HEAD is not a regular file/);
      rmSync(join(dir, "app/.git"));
      symlinkSync("/dev/zero", join(dir, "app/.git"));
      // A .git that is not a file or a folder is not a repo: the search goes on upward.
      expect(placeOf(join(dir, "app")).repo).toBeUndefined();
    },
  );

  it("turn capture off there when one is a folder", () => {
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    mkdirSync(join(dir, "app/.seshi/config.toml"), { recursive: true });
    expect(judged()?.invalid).toMatch(/config\.toml is not a regular file/);
    expect(decide({ rules: DEFAULT_RULES, place: placeOf(join(dir, "app")) }).reason).toMatch(
      /cannot be read/,
    );
  });

  it("turn capture off there when one is larger than any real one", () => {
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    write("app/.seshi/config.toml", `# ${"x".repeat(REPO_FILE_MAX_BYTES)}\ncapture = true\n`);
    expect(judged()?.invalid).toMatch(/config\.toml is larger than/);
    write("app/.seshi/config.toml", "capture = true\n");
    write("app/.git/config", `[core]\n# ${"x".repeat(REPO_FILE_MAX_BYTES)}\n`);
    expect(judged()?.invalid).toMatch(/git's config is larger than/);
  });

  it("read bounded: a regular file, an absent one, and anything else", () => {
    write("ok.txt", "hello");
    expect(readBounded(join(dir, "ok.txt"))).toEqual({ text: "hello" });
    expect(readBounded(join(dir, "missing"))).toEqual({ absent: true });
    expect(readBounded(dir)).toEqual({ invalid: "is not a regular file" });
    expect(readBounded(join(dir, "ok.txt"), 4)).toEqual({ invalid: "is larger than 4 bytes" });
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
