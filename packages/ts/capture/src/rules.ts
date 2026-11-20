import { cachedRegExp, globSource, remoteMatches, repoExcluded } from "@seshi/model/exclude";
import type { Toggle } from "./state";

export { excludePattern, normalizeRemote, remoteMatches, repoExcluded } from "@seshi/model/exclude";

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
  /** The org's list of places whose sessions are uploaded with their tool calls redacted
   * (`capture.redact_tool_calls`); entries as in `exclude`. Absent in a rules cache written before
   * it. */
  redactToolCalls?: ExcludeRule[];
}

/** One entry of `capture.exclude` (or `capture.redact_tool_calls`, written the same way): a
 * repository when `repo` is set, else a folder. */
export interface ExcludeRule {
  /** As the admin wrote it (control characters replaced), for messages. */
  entry: string;
  /** A repository entry as `excludePattern` gives it (`acme/app`, `github.com/acme/*`). */
  repo?: string;
  /** A folder entry, `~` expanded. */
  path?: string;
  /** That folder with symbolic links resolved (up to its first wildcard), when it differs. */
  real?: string;
  /** Where the entry came from: the server's list (`[capture] exclude`, fetched by the
   * uploader), or this machine's CLI config (`capture.exclude`) when unset. */
  from?: "server";
  /** For an entry of the server's list: the server the copy came from. */
  server?: string;
}

export const DEFAULT_RULES: CaptureRules = {
  enabled: true,
  paths: [],
  remotes: [],
  exclude: [],
  redactToolCalls: [],
};

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
  /** Set when an entry of the exclude list decided: the entry, and whether it is the server's
   * list or this machine's CLI config. */
  excluded?: { entry: string; from: "server" | "config"; server?: string };
  /** Set when a pause stops the session (`level: "pause"`): the transcript offset it stops at.
   * What lies before it may still be sent again (a whole-log resend after a 409, a moved
   * transcript, a replace); nothing past it ever is. A caller that keeps state records it as the
   * session's `frozen` offset, so the session stays stopped after the pause ends. */
  frozen?: number;
  /** Set when what is sent of the session goes with its tool calls redacted
   * (`capture.redact_tool_calls`): why, naming the entry. */
  redact_tool_calls?: string;
  /** With it: the entry, and whether it is the server's list or this machine's CLI config. */
  redacted?: { entry: string; from: "server" | "config"; server?: string };
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
  /** The session is a subagent's (it has a parent session). */
  subagent?: boolean;
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
  return cachedRegExp(`^${globSource(norm(base))}(?:/.*)?$`, flags).test(norm(folder));
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
  return listedIn(rules.exclude, place, platform);
}

/** The entry of `capture.redact_tool_calls` that `place` is in, if any, matched as
 * `excludedBy` matches. */
export function toolCallsRedactedBy(
  rules: CaptureRules,
  place: Place,
  platform: NodeJS.Platform,
): ExcludeRule | undefined {
  return listedIn(rules.redactToolCalls ?? [], place, platform);
}

function listedIn(
  entries: readonly ExcludeRule[],
  place: Place,
  platform: NodeJS.Platform,
): ExcludeRule | undefined {
  const remotes = place.repo?.remotes ?? [];
  return entries.find((rule) => {
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
    const from = excluded.from ?? "config";
    const where =
      from === "config"
        ? "capture.exclude"
        : `${excluded.server ?? "the server"}'s [capture] exclude`;
    return {
      capture: false,
      level: "org",
      reason: `the org excludes ${excluded.entry} (${where})`,
      excluded: {
        entry: excluded.entry,
        from,
        ...(excluded.server !== undefined ? { server: excluded.server } : {}),
      },
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

/** The first other folder the session was seen in where `check` finds something, as what it
 * found and that folder's name (its repo's root, else the folder). */
function firstSeenWhere<T>(
  input: DecideInput,
  check: (place: Place) => T | undefined,
): { found: T; where: string } | undefined {
  for (const other of input.seen ?? []) {
    if (other.cwd === undefined || other.cwd === input.place.cwd) continue;
    const found = check(other);
    if (found !== undefined) return { found, where: other.repo?.root ?? other.cwd };
  }
  return undefined;
}

const sharedRulesSeen: LevelRule = (input, platform) => {
  const seen = firstSeenWhere(input, (other) => sharedExclusion(input.rules, other, platform));
  return seen
    ? { ...seen.found, reason: `it also ran in ${seen.where}, where ${seen.found.reason}` }
    : undefined;
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
  let decision: Decision | undefined;
  for (const level of PRECEDENCE) {
    decision = level(input, platform);
    if (decision) break;
  }
  decision ??= globalLevel(input.rules);
  const sends = decision.capture || decision.frozen !== undefined;
  const redacting = sends ? toolCallsRedacted(input, platform) : undefined;
  if (redacting && input.subagent) {
    // A subagent's whole session is its parent's tool call: its prompt is the call's input and
    // its last reply the call's result. The parent's log keeps the call's name, id and failure.
    return {
      capture: false,
      level: "org",
      reason: `a subagent's session is its parent's tool call, and ${redacting.reason}`,
    };
  }
  return redacting
    ? { ...decision, redact_tool_calls: redacting.reason, redacted: redacting.redacted }
    : decision;
}

/** Why the session's tool calls are redacted, when they are: it ran in a place the org lists in
 * `capture.redact_tool_calls`, here or in any other folder it was seen in (what it did there
 * stays in it wherever it goes next). Exclusion is decided first, so it wins. */
function toolCallsRedacted(
  input: DecideInput,
  platform: NodeJS.Platform,
): { reason: string; redacted: NonNullable<Decision["redacted"]> } | undefined {
  const found = (entry: ExcludeRule) => {
    const from: "server" | "config" = entry.from ?? "config";
    const where =
      from === "config"
        ? "capture.redact_tool_calls"
        : `${entry.server ?? "the server"}'s [capture] redact_tool_calls`;
    return {
      reason: `the org redacts tool calls in ${entry.entry} (${where})`,
      redacted: {
        entry: entry.entry,
        from,
        ...(entry.server !== undefined ? { server: entry.server } : {}),
      },
    };
  };
  const here = toolCallsRedactedBy(input.rules, input.place, platform);
  if (here) return found(here);
  const seen = firstSeenWhere(input, (other) => toolCallsRedactedBy(input.rules, other, platform));
  if (!seen) return undefined;
  const there = found(seen.found);
  return { ...there, reason: `it also ran in ${seen.where}, where ${there.reason}` };
}
