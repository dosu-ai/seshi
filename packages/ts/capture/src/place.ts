import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoLabel } from "@seshi/kit";
import { GIT_CONFIG_MAX_BYTES, REPO_FILE_MAX_BYTES, readUntrustedRepoFile } from "./files";
import { normalizeRemote, type Place, type RepoConfig } from "./rules";

export const REPO_CONFIG = join(".seshi", "config.toml");

function kind(path: string): "dir" | "file" | undefined {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

function repoFile(
  path: string,
  name: string,
  max = REPO_FILE_MAX_BYTES,
): { text?: string; invalid?: string } {
  const read = readUntrustedRepoFile(path, max);
  if ("text" in read) return { text: read.text };
  if ("invalid" in read) return { invalid: `${name} ${read.invalid}` };
  return {};
}

/** The repository `folder` is in: its root and its git folders (`.git`, or the folder a
 * worktree's `.git` file points at, and the shared one it names in `commondir`). `invalid`
 * says why a git file it had to read cannot be trusted (not a regular file, too large). */
export function findRepo(
  folder: string,
): { root: string; gitDir: string; commonDir: string; invalid?: string } | undefined {
  let at = resolve(folder);
  for (;;) {
    const dotGit = join(at, ".git");
    const found = kind(dotGit);
    if (found === "dir") return { root: at, gitDir: dotGit, commonDir: dotGit };
    if (found === "file") {
      const file = repoFile(dotGit, "the .git file");
      if (file.invalid !== undefined) {
        return { root: at, gitDir: dotGit, commonDir: dotGit, invalid: file.invalid };
      }
      const pointer = /^gitdir:\s*(.+)$/m.exec(file.text ?? "")?.[1]?.trim();
      if (pointer) {
        const gitDir = isAbsolute(pointer) ? pointer : resolve(at, pointer);
        const common = repoFile(join(gitDir, "commondir"), "the worktree's commondir");
        if (common.invalid !== undefined) {
          return { root: at, gitDir, commonDir: gitDir, invalid: common.invalid };
        }
        const commonText = common.text?.trim();
        const commonDir = commonText ? resolve(gitDir, commonText) : gitDir;
        return { root: at, gitDir, commonDir };
      }
    }
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
}

/** The repository's name: the folder of its main checkout (`commonDir` is that checkout's
 * `.git`, also from a worktree of it), or of a bare repository without its `.git` suffix. */
export function repoName(root: string, commonDir: string): string {
  if (basename(commonDir) === ".git") return basename(dirname(commonDir));
  if (commonDir.endsWith(".git")) return basename(commonDir).slice(0, -".git".length);
  return basename(root);
}

/** The remotes a git config file names, each as its name and its first url normalized
 * (`github.com/acme/app`), in the order the file names them. */
export function namedRemotes(configText: string): { name: string; url: string }[] {
  const remotes: { name: string; url: string }[] = [];
  let remote: string | undefined;
  for (const raw of configText.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      remote = /^\[remote\s+"(.*)"\s*\]/.exec(line)?.[1];
      continue;
    }
    if (remote === undefined) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]?.trim();
    if (url) remotes.push({ name: remote, url: normalizeRemote(url.replace(/^"(.*)"$/, "$1")) });
  }
  return remotes;
}

/** The remotes a git config file names, normalized (`github.com/acme/app`). */
export function gitRemotes(configText: string): string[] {
  return [...new Set(namedRemotes(configText).map((r) => r.url))];
}

/** The repository's remote, as the session's `repo`: `origin`, else the first remote; none when
 * that remote is a folder on this machine (`repoLabel`). */
export function repoRemote(configText: string): string | undefined {
  const remotes = namedRemotes(configText);
  return repoLabel((remotes.find((r) => r.name === "origin") ?? remotes[0])?.url);
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The commit `HEAD` names, read from the git folders without running git: a detached `HEAD` is
 * the sha itself; a branch is its loose ref file (in the worktree's own folder, then the shared
 * one), else its line in `packed-refs`. A ref that names another ref is followed a few steps. */
export function headCommit(
  gitDir: string,
  commonDir: string,
  headText: string | undefined,
): string | undefined {
  let text = headText?.trim();
  for (let step = 0; step < 5 && text; step++) {
    if (SHA.test(text)) return text;
    const ref = /^ref:\s*(refs\/\S+)$/.exec(text)?.[1];
    if (!ref || ref.split("/").some((part) => part === ".." || part === "")) return undefined;
    text = undefined;
    for (const dir of new Set([gitDir, commonDir])) {
      const loose = repoFile(join(dir, ref), "a git ref").text?.trim();
      if (loose) {
        text = loose;
        break;
      }
    }
    text ??= packedRef(commonDir, ref);
  }
  return text !== undefined && SHA.test(text) ? text : undefined;
}

/** The commit `HEAD` names in the repository `cwd` is in; none outside one, or when git's files
 * cannot be trusted. Not part of `placeOf`, which every rule decision calls: it may read
 * `packed-refs`, so only the hook that captures a session and the uploader read it. */
export function headCommitAt(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === "") return undefined;
  let folder = cwd;
  try {
    folder = realpathSync(cwd);
  } catch {}
  const repo = findRepo(folder);
  if (!repo || repo.invalid !== undefined) return undefined;
  const head = repoFile(join(repo.gitDir, "HEAD"), "git's HEAD");
  if (head.invalid !== undefined) return undefined;
  return headCommit(repo.gitDir, repo.commonDir, head.text);
}

function packedRef(commonDir: string, ref: string): string | undefined {
  const packed = repoFile(
    join(commonDir, "packed-refs"),
    "git's packed-refs",
    GIT_CONFIG_MAX_BYTES,
  );
  for (const line of (packed.text ?? "").split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && SHA.test(sha)) return sha;
  }
  return undefined;
}

/** `folder` relative to the repository's `root`, `/`-separated; undefined at the root, or for a
 * folder outside it. */
export function pathInRepo(root: string, folder: string): string | undefined {
  const rel = relative(root, folder);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** The branch `HEAD` names; undefined when detached. */
export function headBranch(headText: string | undefined): string | undefined {
  return /^ref:\s*refs\/heads\/(.+)$/m.exec(headText ?? "")?.[1]?.trim();
}

/** A repo's `.seshi/config.toml`: `capture = false` turns capture off for everyone who works in
 * the repo; `visibility = "owner"` keeps its sessions private (X5.10). A repo can only narrow:
 * `visibility = "org"` is accepted but never sent, so it cannot make anyone's sessions wider
 * than their token's default (the uploader's `details`). Unknown keys are left
 * for other tools; a value of the wrong type makes the file unreadable, which turns capture off
 * there (fail closed). */
export function parseRepoConfig(text: string | undefined): RepoConfig {
  if (text === undefined) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    return { invalid: (err as Error).message };
  }
  const config: RepoConfig = {};
  if (parsed.capture !== undefined) {
    if (typeof parsed.capture !== "boolean") return { invalid: "capture must be true or false" };
    config.capture = parsed.capture;
  }
  if (parsed.visibility !== undefined) {
    if (parsed.visibility !== "org" && parsed.visibility !== "owner") {
      return { invalid: 'visibility must be "org" or "owner"' };
    }
    config.visibility = parsed.visibility;
  }
  return config;
}

/** Where `cwd` is: its repo, the repo's rules, remotes and branch. `cwd` undefined gives a place
 * the rules refuse (unknown). */
export function placeOf(cwd: string | undefined): Place {
  if (cwd === undefined || cwd === "") return {};
  const place: Place = { cwd };
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) place.real = real;
  } catch {}
  const repo = findRepo(place.real ?? cwd);
  if (repo) {
    if (repo.invalid !== undefined) {
      place.repo = {
        root: repo.root,
        name: repoName(repo.root, repo.commonDir),
        config: { invalid: repo.invalid },
        remotes: [],
      };
      return place;
    }
    const head = repoFile(join(repo.gitDir, "HEAD"), "git's HEAD");
    const config = repoFile(join(repo.root, REPO_CONFIG), REPO_CONFIG);
    const git = repoFile(join(repo.commonDir, "config"), "git's config", GIT_CONFIG_MAX_BYTES);
    const invalid = config.invalid ?? head.invalid ?? git.invalid;
    const branch = headBranch(head.text);
    const remote = repoRemote(git.text ?? "");
    const path = pathInRepo(repo.root, place.real ?? cwd);
    place.repo = {
      root: repo.root,
      name: repoName(repo.root, repo.commonDir),
      config: invalid !== undefined ? { invalid } : parseRepoConfig(config.text),
      remotes: gitRemotes(git.text ?? ""),
      ...(branch ? { branch } : {}),
      ...(remote ? { remote } : {}),
      ...(path ? { path } : {}),
    };
  }
  return place;
}
