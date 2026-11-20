import { normalizeRemote } from "@seshi/kit";
import type { Toggle } from "./state";

export { normalizeRemote };

export interface PathRule {
  /** An absolute folder (`~` already expanded). */
  path: string;
  /** The same folder with symbolic links resolved, when it differs. */
  real?: string;
  capture: boolean;
}

export interface CaptureRules {
  enabled: boolean;
  paths: PathRule[];
  /** The org rule: when not empty, only repos with a remote matching one of these patterns are
   * captured (`github.com/acme`, `github.com/acme/*`). */
  remotes: string[];
  /** The org's exclude list: sessions in these repositories or folders are never captured. */
  exclude: ExcludeRule[];
}

/** One entry of `capture.exclude`: a repository when `repo` is set, else a folder. */
export interface ExcludeRule {
  /** As the admin wrote it (control characters replaced), for messages. */
  entry: string;
  /** A repository entry as `excludePattern` gives it (`acme/app`, `github.com/acme/*`). */
  repo?: string;
  /** A folder entry, `~` expanded. */
  path?: string;
  /** That folder with symbolic links resolved (up to its first wildcard), when it differs. */
  real?: string;
}

export const DEFAULT_RULES: CaptureRules = { enabled: true, paths: [], remotes: [], exclude: [] };

export interface RepoConfig {
  capture?: boolean;
  visibility?: "org" | "owner";
  /** `[labels]`: plain strings only, the fallback under the CLI config's (`resolveLabels`). */
  labels?: Record<string, string>;
  /** Why labels of the file were left out (an `env` reference, not a string): they never turn
   * capture off. */
  labelProblems?: string[];
  /** The file could not be read: capture is off there until it is fixed (fail closed). */
  invalid?: string;
}

export interface Place {
  cwd?: string;
  /** `cwd` with symbolic links resolved, when it differs. */
  real?: string;
  repo?: {
    root: string;
    /** The repository's name: its main checkout's folder, also for a worktree of it. */
    name: string;
    config: RepoConfig;
    /** Its remotes, as `host/path` (`github.com/acme/app`). */
    remotes: string[];
    branch?: string;
    /** Its `origin` remote, else its first, as `host/path`; none when that remote is a local
     * folder. What the uploader sends as the session's `repo`. */
    remote?: string;
    /** The working folder relative to the root (`packages/api`, `/`-separated); none at the
     * root. */
    path?: string;
  };
}

export type Level =
  | "config"
  | "unknown"
  | "org"
  | "repo"
  | "pause"
  | "session"
  | "folder"
  | "global";

/** A session a rule turns off (not a pause, which keeps what was sent, nor rules that could not be
 * read): what its hooks kept beside it goes. */
export function turnedOff(decision: Decision): boolean {
  return (
    !decision.capture &&
    decision.frozen === undefined &&
    decision.level !== "pause" &&
    decision.level !== "config" &&
    decision.level !== "unknown"
  );
}

export interface Decision {
  capture: boolean;
  level: Level;
  reason: string;
  /** Set when a pause stops the session (`level: "pause"`): the transcript offset it stops at.
   * What lies before it may still be sent again (a whole-log resend after a 409, a moved
   * transcript, a replace); nothing past it ever is. A caller that keeps state records it as the
   * session's `frozen` offset, so the session stays stopped after the pause ends. */
  frozen?: number;
}

/** A pause, from `seshi capture pause` to its end (`until`; none while it is open-ended). */
export interface PauseWindow {
  at: string;
  until?: string;
}

export interface DecideInput {
  rules: CaptureRules;
  /** The CLI config could not be read: nothing is captured until it is fixed. */
  rulesError?: string;
  place: Place;
  toggle?: Toggle;
  /** When that toggle was set: a session turned on after a pause began is not stopped by it. */
  toggledAt?: string;
  paused?: boolean;
  pausedAt?: string;
  /** The offset an earlier pause stopped the session at (its `frozen` state). */
  frozen?: number;
  /** Bytes of the transcript the server holds from this machine: where a pause stops it now. */
  uploaded?: number;
  /** When the session started, when known, and the pauses recorded (the one in force too): a
   * session that started during one is off, even when first seen after it ended. */
  started?: string;
  pauses?: readonly PauseWindow[];
  /** The other folders the session was seen in: a shared rule that turns any of them off turns
   * the session off (a session that left an excluded repo carries what it did there). */
  seen?: Place[];
}

/** A glob as a regular expression's source: `*` stands for one path segment (or part of one),
 * `**` for any number of segments, none included (`a/**` is `a` and everything under it,
 * `a/**` + `/b` is `a/b` too); everything else is literal. */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**", i)) {
      const segment = i === 0 || glob[i - 1] === "/";
      if (segment && glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else if (segment && i > 0 && i + 2 === glob.length) {
        out = `${out.slice(0, -1)}(?:/.*)?`;
        i += 2;
      } else {
        out += ".*";
        i += 2;
      }
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += (glob[i] as string).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

/** Compiled once: hooks and the status line judge often, with the same few patterns. */
const compiled = new Map<string, RegExp>();
function globRegExp(source: string, flags = ""): RegExp {
  const key = `${flags}:${source}`;
  let re = compiled.get(key);
  if (!re) {
    re = new RegExp(source, flags);
    compiled.set(key, re);
  }
  return re;
}

/** Whether a normalized remote matches a normalized pattern; `under` lets a pattern with no
 * wildcard match everything under it too. */
function patternMatches(remote: string, target: string, under: boolean): boolean {
  if (!target.includes("*")) return remote === target || (under && remote.startsWith(`${target}/`));
  return globRegExp(`^${globSource(target)}$`).test(remote);
}

/** Whether a normalized remote matches a pattern: `*` stands for one path segment (or part of
 * one), `**` for any number; a pattern with no wildcard also matches everything under it. */
export function remoteMatches(remote: string, pattern: string): boolean {
  return patternMatches(remote, normalizeRemote(pattern), true);
}

/** A repository entry of `capture.exclude` as a pattern: lowercase, normalized as a remote is. A
 * number after the host is a port (`git.acme.com:8443/acme/app`), not scp's `host:path`. */
export function excludePattern(entry: string): string {
  return normalizeRemote(
    entry
      .trim()
      .toLowerCase()
      .replace(/^([^/@:]+):\d+\//, "$1/"),
  );
}

/** Whether a normalized remote is in a repository entry of `capture.exclude` (`pattern`, from
 * `excludePattern`), ignoring case. The entry names the remote's last segments, so `acme/app`
 * matches it on any host and `github.com/acme/app` only on that one; or the whole remote, where
 * one with no wildcard also covers everything under it, as in `capture.remotes`
 * (`github.com/acme`: every repo of acme there). */
export function repoExcluded(remote: string, pattern: string): boolean {
  const target = remote.toLowerCase();
  if (patternMatches(target, pattern, true)) return true;
  const segments = target.split("/");
  return segments.some(
    (_, i) => i > 0 && patternMatches(segments.slice(i).join("/"), pattern, false),
  );
}

/** Whether `folder` is `base` or inside it (whole path segments only). Folders are compared as
 * the platform does: case-insensitively on Windows. */
export function within(folder: string, base: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const trimmed = p.length > 1 ? p.replace(/[\\/]+$/, "") : p;
    return platform === "win32" ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
  };
  const f = norm(folder);
  const b = norm(base);
  if (f === b) return true;
  const sep = platform === "win32" ? "\\" : "/";
  return f.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
}

/** Whether `folder` is in a folder entry of `capture.exclude` (`~` already expanded): `base` and
 * everything under it, `*` matching within one path segment and `**` across any number. */
export function folderExcluded(folder: string, base: string, platform: NodeJS.Platform): boolean {
  if (!base.includes("*")) return within(folder, base, platform);
  const norm = (p: string) => {
    const slashed = platform === "win32" ? p.replace(/\\/g, "/") : p;
    return slashed.length > 1 ? slashed.replace(/\/+$/, "") : slashed;
  };
  const flags = platform === "win32" ? "i" : "";
  return globRegExp(`^${globSource(norm(base))}(?:/.*)?$`, flags).test(norm(folder));
}

/** The longer of a rule's folders (its path, its real path) that `place`'s folder or real
 * folder is in, by `inside`. */
function longestBase(
  place: Place,
  rule: { path?: string; real?: string },
  inside: (folder: string, base: string) => boolean,
): string | undefined {
  let best: string | undefined;
  for (const base of [rule.path, rule.real]) {
    if (base === undefined || (best !== undefined && base.length <= best.length)) continue;
    if ([place.cwd, place.real].some((f) => f !== undefined && inside(f, base))) best = base;
  }
  return best;
}

/** The entry of `capture.exclude` that `place` is in, if any: its folder (or that folder with
 * symbolic links resolved) is under a folder entry, or one of its repo's remotes matches a
 * repository entry. */
export function excludedBy(
  rules: CaptureRules,
  place: Place,
  platform: NodeJS.Platform,
): ExcludeRule | undefined {
  const remotes = place.repo?.remotes ?? [];
  return rules.exclude.find((rule) => {
    const repo = rule.repo;
    if (repo !== undefined) return remotes.some((r) => repoExcluded(r, repo));
    return longestBase(place, rule, (f, b) => folderExcluded(f, b, platform)) !== undefined;
  });
}

/** How long the folder of `rule` (its path, or its real path) that `place` is in is, as
 * `[[capture.paths]]` matches; undefined when `place` is in neither. */
export function folderMatch(
  place: Place,
  rule: { path: string; real?: string },
  platform: NodeJS.Platform,
): number | undefined {
  return longestBase(place, rule, (f, b) => within(f, b, platform))?.length;
}

/** The folder rule for `place`: the longest one it is in. */
export function folderRule(
  rules: CaptureRules,
  place: Place,
  platform: NodeJS.Platform,
): PathRule | undefined {
  let best: { rule: PathRule; length: number } | undefined;
  for (const rule of rules.paths) {
    const base = longestBase(place, rule, (f, b) => within(f, b, platform));
    if (base !== undefined && (!best || base.length > best.length)) {
      best = { rule, length: base.length };
    }
  }
  return best?.rule;
}

function sharedExclusion(
  rules: CaptureRules,
  place: Place,
  platform: NodeJS.Platform,
): Decision | undefined {
  const excluded = excludedBy(rules, place, platform);
  if (excluded) {
    return {
      capture: false,
      level: "org",
      reason: `the org excludes ${excluded.entry} (capture.exclude)`,
    };
  }
  if (rules.remotes.length > 0) {
    const remotes = place.repo?.remotes ?? [];
    if (!remotes.some((r) => rules.remotes.some((p) => remoteMatches(r, p)))) {
      return {
        capture: false,
        level: "org",
        reason: place.repo
          ? "the repo's remote is not one the org captures (capture.remotes)"
          : "not in a git repo, and the org captures only its repos (capture.remotes)",
      };
    }
  }
  const repo = place.repo;
  if (repo?.config.invalid !== undefined) {
    return {
      capture: false,
      level: "repo",
      reason: `the repo's config cannot be read: ${repo.config.invalid}`,
    };
  }
  if (repo?.config.capture === false) {
    return {
      capture: false,
      level: "repo",
      reason: "the repo turns capture off (.seshi/config.toml)",
    };
  }
  return undefined;
}

export function turnedOnSince(
  toggle: Toggle | undefined,
  toggledAt: string | undefined,
  at: string | undefined,
): boolean {
  return (
    toggle === "on" &&
    toggledAt !== undefined &&
    (at === undefined || Date.parse(toggledAt) >= Date.parse(at))
  );
}

type LevelRule = (input: DecideInput, platform: NodeJS.Platform) => Decision | undefined;

const unreadableConfig: LevelRule = (input) =>
  input.rulesError === undefined
    ? undefined
    : {
        capture: false,
        level: "config",
        reason: `the CLI config cannot be read: ${input.rulesError}`,
      };

const unknownFolder: LevelRule = (input) =>
  input.place.cwd !== undefined
    ? undefined
    : {
        capture: false,
        level: "unknown",
        reason: "where the session ran is not known, so its repo's rules cannot be checked",
      };

const sharedRulesHere: LevelRule = (input, platform) =>
  sharedExclusion(input.rules, input.place, platform);

const sharedRulesSeen: LevelRule = (input, platform) => {
  for (const other of input.seen ?? []) {
    if (other.cwd === undefined || other.cwd === input.place.cwd) continue;
    const excluded = sharedExclusion(input.rules, other, platform);
    if (excluded) {
      return {
        ...excluded,
        reason: `it also ran in ${other.repo?.root ?? other.cwd}, where ${excluded.reason}`,
      };
    }
  }
  return undefined;
};

const sessionOff: LevelRule = (input) =>
  input.toggle === "off"
    ? { capture: false, level: "session", reason: "turned off for this session" }
    : undefined;

const frozenByPause: LevelRule = (input) =>
  input.frozen === undefined
    ? undefined
    : {
        capture: false,
        level: "pause",
        reason: "stopped by a pause; seshi capture on --session turns it back on",
        frozen: input.frozen,
      };

const pausedNow: LevelRule = (input) =>
  input.paused && !turnedOnSince(input.toggle, input.toggledAt, input.pausedAt)
    ? {
        capture: false,
        level: "pause",
        reason: "capture is paused: the session stops where it is",
        frozen: input.uploaded ?? 0,
      }
    : undefined;

const startedInPause: LevelRule = (input) => {
  const started = input.started === undefined ? Number.NaN : Date.parse(input.started);
  if (!Number.isFinite(started)) return undefined;
  const window = input.pauses?.find(
    (w) =>
      Date.parse(w.at) <= started &&
      (w.until === undefined || started < Date.parse(w.until)) &&
      !turnedOnSince(input.toggle, input.toggledAt, w.at),
  );
  return window
    ? {
        capture: false,
        level: "pause",
        reason: "it started while capture was paused",
        frozen: input.uploaded ?? 0,
      }
    : undefined;
};

const sessionToggle: LevelRule = (input) =>
  input.toggle === undefined
    ? undefined
    : {
        capture: input.toggle === "on",
        level: "session",
        reason: `turned ${input.toggle} for this session`,
      };

const folderLevel: LevelRule = (input, platform) => {
  const folder = folderRule(input.rules, input.place, platform);
  return folder
    ? {
        capture: folder.capture,
        level: "folder",
        reason: `${folder.capture ? "captured" : "not captured"} under ${folder.path} ([[capture.paths]])`,
      }
    : undefined;
};

function globalLevel(rules: CaptureRules): Decision {
  return rules.enabled
    ? { capture: true, level: "global", reason: "capture is on" }
    : { capture: false, level: "global", reason: "capture is off for this user (capture.enabled)" };
}

const PRECEDENCE: readonly LevelRule[] = [
  unreadableConfig,
  unknownFolder,
  sharedRulesHere,
  sharedRulesSeen,
  sessionOff,
  frozenByPause,
  pausedNow,
  startedInPause,
  sessionToggle,
  folderLevel,
];

export function decide(input: DecideInput, platform: NodeJS.Platform = process.platform): Decision {
  for (const level of PRECEDENCE) {
    const decision = level(input, platform);
    if (decision) return decision;
  }
  return globalLevel(input.rules);
}
