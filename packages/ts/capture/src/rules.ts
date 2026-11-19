import type { Toggle } from "./state";

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
}

export const DEFAULT_RULES: CaptureRules = { enabled: true, paths: [], remotes: [] };

export interface RepoConfig {
  capture?: boolean;
  visibility?: "org" | "owner";
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

/** `remote` (`https://github.com/acme/app.git`, `git@github.com:acme/app`, `ssh://…`) as
 * `host/path`: lowercase host, no user, no port, no `.git`, no trailing slash. */
export function normalizeRemote(remote: string): string {
  let text = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `${(scp[1] as string).toLowerCase()}/${scp[2]}`;
  } else {
    const url = tryParseUrl(text);
    if (url) text = `${url.hostname.toLowerCase()}${url.pathname}`;
  }
  return text.replace(/\/+$/, "").replace(/\.git$/, "");
}

function tryParseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** Whether a normalized remote matches a pattern: `*` stands for one path segment (or part of
 * one), `**` for any number; a pattern with no wildcard also matches everything under it. */
export function remoteMatches(remote: string, pattern: string): boolean {
  const target = normalizeRemote(pattern);
  if (!target.includes("*")) return remote === target || remote.startsWith(`${target}/`);
  const source = target
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(remote);
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

/** The folder rule for `place`: the longest one it is in. */
export function folderRule(
  rules: CaptureRules,
  place: Place,
  platform: NodeJS.Platform,
): PathRule | undefined {
  const candidates = [place.cwd, place.real].filter((p): p is string => p !== undefined);
  let best: { rule: PathRule; length: number } | undefined;
  for (const rule of rules.paths) {
    for (const base of [rule.path, rule.real].filter((p): p is string => p !== undefined)) {
      if (candidates.some((c) => within(c, base, platform))) {
        if (!best || base.length > best.length) best = { rule, length: base.length };
      }
    }
  }
  return best?.rule;
}

function sharedExclusion(rules: CaptureRules, place: Place): Decision | undefined {
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

const sharedRulesHere: LevelRule = (input) => sharedExclusion(input.rules, input.place);

const sharedRulesSeen: LevelRule = (input) => {
  for (const other of input.seen ?? []) {
    if (other.cwd === undefined || other.cwd === input.place.cwd) continue;
    const excluded = sharedExclusion(input.rules, other);
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
