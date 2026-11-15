/** Who is searching, as the query layer applies it (F10.4): a member finds the sessions they own
 * and those visible to the org; admins and services find everything (X5.10). The server builds
 * the viewer from the verified principal, never from anything the client sends, and the index
 * filters with it in SQL; every result is then checked again against the session's live
 * metadata with the same rule `@seshi/auth` uses for reads, so a session whose visibility
 * changed after it was indexed is never shown. */

import { canRead, OwnerAliases, type Principal, seesEverything } from "@seshi/auth";
import type { Visibility } from "@seshi/model";

export interface Viewer {
  /** Sees every session: an admin, a service, or local mode (whoever holds the bucket keys
   * reads everything anyway, X5.6). */
  readonly everything: boolean;
  /** The owner folders that are the viewer's own (its owner id and the old ids
   * `[auth.owner_aliases]` folds into it). */
  readonly own: readonly string[];
  /** The authoritative read check, run on each result's live metadata. */
  canRead(session: { owner: string; visibility?: Visibility }): boolean;
}

/** The viewer for a verified principal: `canRead` and the owner folders, aliases applied. */
export function viewerFor(
  principal: Principal,
  aliases: OwnerAliases = new OwnerAliases(),
): Viewer {
  return {
    everything: seesEverything(principal),
    own: aliases.storedAs(principal.owner),
    canRead: (session) => canRead(principal, session, aliases),
  };
}

/** Local mode's viewer (X3.5): the person who owns the bucket sees all of it. */
export const LOCAL_VIEWER: Viewer = Object.freeze({
  everything: true,
  own: [],
  canRead: () => true,
});
