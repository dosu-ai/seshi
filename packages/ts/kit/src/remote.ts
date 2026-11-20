/** A git remote as seshi names a repository (`github.com/acme/app`): the same for a laptop's
 * origin remote and a cloud agent's repository URL, and never carrying a credential. */

/** `remote` (`https://github.com/acme/app.git`, `git@github.com:acme/app`, `ssh://…`, or a
 * bare `github.com/acme/app`) as `host/path`: lowercase host, no user, no port, no `.git`, no
 * trailing slash. */
export function normalizeRemote(remote: string): string {
  let text = remote.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(text);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `${(scp[1] as string).toLowerCase()}/${scp[2]}`;
  } else {
    const url = tryParseUrl(text);
    if (url) text = `${url.hostname.toLowerCase()}${url.pathname}`;
    else text = withoutCredentials(text);
  }
  return text.replace(/\/+$/, "").replace(/\.git$/i, "");
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
    const host = after.slice(0, after.indexOf("/") === -1 ? undefined : after.indexOf("/"));
    if (HOST.test(host)) {
      from = at + 1;
      break;
    }
  }
  const hostAndPath = rest.slice(from);
  const slash = hostAndPath.indexOf("/");
  const host = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  if (!host.includes(".") && rest === text) return text;
  return `${host.replace(/:\d*$/, "").toLowerCase()}${slash === -1 ? "" : hostAndPath.slice(slash)}`;
}

function tryParseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/** A normalized remote as a session's `repo`: none for a folder on this machine (`/srv/git/app`,
 * `../app`, `file:///…`), or for anything that is not `host/path` without user info. */
export function repoLabel(normalized: string | undefined): string | undefined {
  if (normalized === undefined || normalized === "") return undefined;
  if (/^[./~\\]|^[A-Za-z]:|^file:/i.test(normalized)) return undefined;
  if (!normalized.includes("/") || /[@\s\\]|:\/\//.test(normalized)) return undefined;
  return normalized;
}
