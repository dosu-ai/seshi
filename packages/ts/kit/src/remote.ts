/** A git remote as seshi names a repository (`github.com/acme/app`): the same for a laptop's
 * origin remote and a cloud agent's repository URL, and never carrying a credential. */

/** One normalizer for every path that names a repository: a laptop's remotes, a Cursor Cloud
 * agent's repository URL, the org's exclude list. It lives in @seshi/model (`exclude`), where the
 * server's matching uses it too. */
export { normalizeRemote } from "@seshi/model/exclude";

/** A normalized remote as a session's `repo`: none for a folder on this machine (`/srv/git/app`,
 * `../app`, `file:///…`), or for anything that is not `host/path` without user info. */
export function repoLabel(normalized: string | undefined): string | undefined {
  if (normalized === undefined || normalized === "") return undefined;
  if (/^[./~\\]|^[A-Za-z]:|^file:/i.test(normalized)) return undefined;
  if (!normalized.includes("/") || /[@\s\\]|:\/\//.test(normalized)) return undefined;
  return normalized;
}
