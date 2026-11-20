import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_CONFIG_MAX_BYTES, REPO_FILE_MAX_BYTES, readUntrustedRepoFile } from "./files";
import {
  findRepo,
  gitRemotes,
  headBranch,
  headCommit,
  parseRepoConfig,
  pathInRepo,
  placeOf,
  repoName,
  repoRemote,
} from "./place";
import { DEFAULT_RULES, decide, normalizeRemote, type RepoConfig } from "./rules";

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

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

describe("the session's repository, commit and folder", () => {
  it("normalizes remotes without credentials or port", () => {
    for (const remote of [
      "https://github.com/acme/app.git",
      "https://x-access-token:ghp_secret0123456789@github.com/acme/app.git",
      "https://user@github.com/acme/app",
      "http://user:pass@GitHub.com:8443/acme/app/",
      "ssh://git@github.com/acme/app.git",
      "ssh://git@github.com:2222/acme/app.git",
      "git@github.com:acme/app.git",
      "token@github.com:acme/app",
      "git+ssh://git@github.com/acme/app.git",
    ]) {
      const normalized = normalizeRemote(remote);
      expect(normalized, remote).toBe("github.com/acme/app");
    }
    // One no URL parser reads keeps no user info either.
    expect(normalizeRemote("https://user:pa/ss@github.com/acme/app")).not.toContain("pa/ss");
    expect(normalizeRemote("https://user:pa/ss@github.com/acme/app")).not.toContain("@");
  });

  it("is origin's remote, else the first; none for a folder on this machine", () => {
    const config = (...remotes: [string, string][]) =>
      remotes.map(([name, url]) => `[remote "${name}"]\n\turl = ${url}\n`).join("");
    expect(repoRemote(GIT_CONFIG)).toBe("github.com/acme/app");
    expect(
      repoRemote(
        config(["fork", "https://github.com/me/app"], ["origin", "git@github.com:acme/app"]),
      ),
    ).toBe("github.com/acme/app");
    expect(repoRemote(config(["upstream", "https://t0k3n@gitlab.com/g/app.git"]))).toBe(
      "gitlab.com/g/app",
    );
    expect(repoRemote(config(["origin", "/srv/git/app.git"]))).toBeUndefined();
    expect(repoRemote(config(["origin", "../app"]))).toBeUndefined();
    expect(repoRemote(config(["origin", "file:///srv/git/app.git"]))).toBeUndefined();
    expect(repoRemote("[core]\n\tbare = false\n")).toBeUndefined();
  });

  it("reads HEAD's commit from a loose ref, packed-refs, a detached HEAD and a worktree", () => {
    const git = join(dir, "app/.git");
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    write("app/.git/refs/heads/main", `${SHA_A}\n`);
    expect(headCommit(git, git, "ref: refs/heads/main\n")).toBe(SHA_A);
    write(
      "app/.git/packed-refs",
      `# pack-refs with: peeled fully-peeled sorted\n${SHA_B} refs/heads/packed\n^${SHA_C}\n`,
    );
    expect(headCommit(git, git, "ref: refs/heads/packed\n")).toBe(SHA_B);
    expect(headCommit(git, git, `${SHA_C}\n`)).toBe(SHA_C);
    expect(headCommit(git, git, "ref: refs/heads/missing\n")).toBeUndefined();
    expect(headCommit(git, git, "ref: refs/heads/../../../etc/passwd\n")).toBeUndefined();
    // A worktree: its HEAD in its own git folder, the branch's ref in the shared one.
    write("app/.git/worktrees/wt/commondir", "../..\n");
    write("app/.git/worktrees/wt/HEAD", "ref: refs/heads/packed\n");
    write("wt/.git", `gitdir: ${join(git, "worktrees/wt")}\n`);
    expect(placeOf(join(dir, "wt")).repo?.commit).toBe(SHA_B);
    write("app/.git/worktrees/wt/HEAD", `${SHA_C}\n`);
    expect(placeOf(join(dir, "wt")).repo?.commit).toBe(SHA_C);
    expect(placeOf(join(dir, "app")).repo?.commit).toBe(SHA_A);
  });

  it("is the folder relative to the repository's root: none at the root or outside it", () => {
    write("app/.git/HEAD", "ref: refs/heads/main\n");
    mkdirSync(join(dir, "app/packages/api"), { recursive: true });
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    expect(placeOf(join(dir, "app")).repo?.path).toBeUndefined();
    expect(placeOf(join(dir, "app/packages/api")).repo?.path).toBe("packages/api");
    expect(placeOf(join(dir, "elsewhere")).repo).toBeUndefined();
    expect(pathInRepo(join(dir, "app"), join(dir, "elsewhere"))).toBeUndefined();
    expect(pathInRepo(join(dir, "app"), join(dir, "app"))).toBeUndefined();
  });
});

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
      name: "app",
      config: {},
      remotes: ["github.com/acme/app", "github.com/me/app"],
      branch: "wt-branch",
      remote: "github.com/acme/app",
    });
    expect(findRepo(dir)).toBeUndefined();
  });

  it("names a repo after its main checkout, from a worktree too", () => {
    expect(repoName("/src/dosu", "/src/dosu/.git")).toBe("dosu");
    expect(repoName("/src/dosu/.claude/worktrees/agent-a1", "/src/dosu/.git")).toBe("dosu");
    expect(repoName("/wt/feature", "/srv/git/dosu.git")).toBe("dosu");
    expect(repoName("/wt/feature", "/srv/git/plain")).toBe("feature");
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
    // git's own config gets more room: real ones with many branches pass 64 KiB.
    write("app/.git/config", `[core]\n# ${"x".repeat(REPO_FILE_MAX_BYTES)}\n`);
    expect(judged()?.invalid).toBeUndefined();
    write("app/.git/config", `[core]\n# ${"x".repeat(GIT_CONFIG_MAX_BYTES)}\n`);
    expect(judged()?.invalid).toMatch(/git's config is larger than/);
  });

  it("read bounded: a regular file, an absent one, and anything else", () => {
    write("ok.txt", "hello");
    expect(readUntrustedRepoFile(join(dir, "ok.txt"))).toEqual({ text: "hello" });
    expect(readUntrustedRepoFile(join(dir, "missing"))).toEqual({ absent: true });
    expect(readUntrustedRepoFile(dir)).toEqual({ invalid: "is not a regular file" });
    expect(readUntrustedRepoFile(join(dir, "ok.txt"), 4)).toEqual({
      invalid: "is larger than 4 bytes",
    });
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
