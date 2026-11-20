/** Repositories and the org's exclude list (`capture.exclude`), shared by every path that names a
 * repository: a laptop's git remotes, a Cursor Cloud agent's repository URL, a session's `repo`.
 * One normalizer and one matcher, so an entry matches the same repository whichever way it
 * arrived. */

/** `remote` (`https://github.com/acme/app.git`, `git@github.com:acme/app`, `ssh://…`, or a
 * bare `github.com/acme/app`) as `host/path`: lowercase, no scheme, no user or credentials, no
 * port, no `.git`, no trailing slash. All of it is lowercased, not just the host: the hosts
 * people use ignore case in owner and repository names (`github.com/Acme/App` is
 * `github.com/acme/app`), and one repository must have one name whichever way it was cloned.
 * (The same function as dosu-ai/seshi#49's, there in @seshi/kit.) */
export function normalizeRemote(remote: string): string {
  let text = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `${scp[1]}/${scp[2]}`;
  } else {
    const url = tryParseUrl(text);
    if (url) text = `${url.hostname}${url.pathname}`;
    else text = withoutCredentials(text);
  }
  return text
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

const HOST = /^[A-Za-z0-9.-]+(?::\d*)?$/;

/** A remote no URL parser reads (`https://user:pa/ss@host/x`), or one with no scheme
 * (`GitHub.com/acme/app`), without its scheme and whatever user info and port precede its host:
 * the user info ends at the first `@` followed by a host, so an `@` in the path is kept. */
function withoutCredentials(text: string): string {
  const rest = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(text)?.[1] ?? text;
  let from = 0;
  for (let at = rest.indexOf("@"); at !== -1; at = rest.indexOf("@", at + 1)) {
    const after = rest.slice(at + 1);
    const slash = after.indexOf("/");
    if (HOST.test(slash === -1 ? after : after.slice(0, slash))) {
      from = at + 1;
      break;
    }
  }
  const hostAndPath = rest.slice(from);
  const slash = hostAndPath.indexOf("/");
  const host = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  if (!host.includes(".") && rest === text) return text;
  return `${host.replace(/:\d*$/, "")}${slash === -1 ? "" : hostAndPath.slice(slash)}`;
}

function tryParseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** A repository as compared: `normalizeRemote` (lowercase already, so one string per
 * repository whichever path named it). */
export function repoKey(remote: string): string {
  return normalizeRemote(remote);
}

/** A glob as a regular expression's source: `*` stands for one path segment (or part of one),
 * `**` for any number of segments, none included (`a/**` is `a` and everything under it,
 * `a/**` + `/b` is `a/b` too); everything else is literal. */
export function globSource(glob: string): string {
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
export function cachedRegExp(source: string, flags = ""): RegExp {
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
  return cachedRegExp(`^${globSource(target)}$`).test(remote);
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

/** One entry of `capture.exclude` as written, read: a repository (`repo`, the pattern) or a
 * folder (`folder`, as written: `~` is the laptop's to expand). */
export type ExcludeEntry =
  | { entry: string; repo: string; folder?: undefined }
  | { entry: string; folder: string; repo?: undefined };

/** An entry of `capture.exclude`, or undefined for a blank one or a `#` comment. A folder starts
 * with `/`, `~`, a drive (`C:\`) or a network share (`\\server`); anything else names a
 * repository. `entry` is the entry as written, control characters replaced, for messages. */
export function readExcludeEntry(raw: string): ExcludeEntry | undefined {
  const written = raw.trim();
  if (written === "" || written.startsWith("#")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters
  const entry = written.replace(/[\x00-\x1f\x7f-\x9f]/g, "\uFFFD");
  if (isFolderEntry(written)) return { entry, folder: written };
  return { entry, repo: excludePattern(written) };
}

export function isFolderEntry(written: string): boolean {
  return /^(?:[/~]|[a-z]:[\\/]|\\\\)/i.test(written.trim());
}

/** What is wrong with an entry of `capture.exclude`, if anything: what an admin wrote by mistake
 * (a URL with a credential in it, a space, a control character), which would never match. */
export function excludeEntryProblem(raw: string): string | undefined {
  const written = raw.trim();
  if (written === "" || written.startsWith("#")) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters
  if (/[\x00-\x1f\x7f-\x9f]/.test(written)) return "has a control character";
  if (isFolderEntry(written)) return undefined;
  if (/\s/.test(written)) return "has a space, which no repository name has";
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(written) || /^[^/@]+:[^/@]*@/.test(written)) {
    return "names a credential; write the repository as owner/name or host/owner/name";
  }
  if (excludePattern(written) === "") return "names no repository";
  return undefined;
}

/** An entry as a message may show it: user info (a token, a password) masked as `***`, and
 * control characters replaced. */
export function maskedEntry(raw: string): string {
  return (
    raw
      .trim()
      .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1***@")
      .replace(/^[^/@:]+:[^/@]*@/, "***@")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters
      .replace(/[\x00-\x1f\x7f-\x9f]/g, "\uFFFD")
  );
}

/** The repository entries of an exclude list, read once: what a server matches sessions and
 * Cursor Cloud agents against. Folder entries are a laptop's: a server knows no folders. */
export interface RepoExcludes {
  repos: readonly { entry: string; pattern: string }[];
}

export function repoExcludes(entries: readonly string[]): RepoExcludes {
  const repos: { entry: string; pattern: string }[] = [];
  for (const raw of entries) {
    const read = readExcludeEntry(raw);
    if (read?.repo !== undefined) repos.push({ entry: read.entry, pattern: read.repo });
  }
  return { repos };
}

/** The entry that excludes a session in any of `repos` (URLs or remotes, in any form: each is
 * normalized), if one does. */
export function excludingEntry(
  excludes: RepoExcludes,
  repos: readonly string[],
): string | undefined {
  const keys = repos.filter((r) => r.trim() !== "").map(repoKey);
  for (const { entry, pattern } of excludes.repos) {
    if (keys.some((key) => repoExcluded(key, pattern))) return entry;
  }
  return undefined;
}

/** `GET /v1/capture/rules`: the org's capture rules, which a laptop applies before upload. */
export const CAPTURE_RULES_SCHEMA = "seshi/capture-rules/1";

export interface CaptureRulesDocument {
  schema: typeof CAPTURE_RULES_SCHEMA;
  /** The server's `[capture] exclude`, every file's entries, as written (blanks and comments
   * left out). */
  exclude: string[];
  /** The server's `[capture] redact_tool_calls`, the same way. Absent from a server older than
   * the list. */
  redact_tool_calls?: string[];
}
