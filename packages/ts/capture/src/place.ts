/** Where a session ran, as the capture rules need it (F9.5): the git repository around the
 * folder, the repo's own `.seshi/config.toml`, its remotes and branch. Read from the files
 * themselves (no `git` process), so a hook can afford it on every turn. */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readText } from "./files";
import { normalizeRemote, type Place, type RepoConfig } from "./rules";

/** The repo config file, relative to the repo root. */
export const REPO_CONFIG = join(".seshi", "config.toml");

function kind(path: string): "dir" | "file" | undefined {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}

/** The repository `folder` is in: its root and its git folders (`.git`, or the folder a
 * worktree's `.git` file points at, and the shared one it names in `commondir`). */
export function findRepo(
  folder: string,
): { root: string; gitDir: string; commonDir: string } | undefined {
  let at = resolve(folder);
  for (;;) {
    const dotGit = join(at, ".git");
    const found = kind(dotGit);
    if (found === "dir") return { root: at, gitDir: dotGit, commonDir: dotGit };
    if (found === "file") {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readText(dotGit) ?? "")?.[1]?.trim();
      if (pointer) {
        const gitDir = isAbsolute(pointer) ? pointer : resolve(at, pointer);
        const common = readText(join(gitDir, "commondir"))?.trim();
        const commonDir = common ? resolve(gitDir, common) : gitDir;
        return { root: at, gitDir, commonDir };
      }
    }
    const parent = dirname(at);
    if (parent === at) return undefined;
    at = parent;
  }
}

/** The remotes a git config file names, normalized (`github.com/acme/app`). */
export function gitRemotes(configText: string): string[] {
  const remotes: string[] = [];
  let inRemote = false;
  for (const raw of configText.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inRemote = /^\[remote\s+"/.test(line);
      continue;
    }
    if (!inRemote) continue;
    const url = /^url\s*=\s*(.+)$/.exec(line)?.[1]?.trim();
    if (url) remotes.push(normalizeRemote(url.replace(/^"(.*)"$/, "$1")));
  }
  return [...new Set(remotes)];
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
    const branch = headBranch(readText(join(repo.gitDir, "HEAD")));
    place.repo = {
      root: repo.root,
      config: parseRepoConfig(readText(join(repo.root, REPO_CONFIG))),
      remotes: gitRemotes(readText(join(repo.commonDir, "config")) ?? ""),
      ...(branch ? { branch } : {}),
    };
  }
  return place;
}
