import { canRead, OwnerAliases, type Principal, seesEverything } from "@seshi/auth";
import type { Visibility } from "@seshi/model";

export interface Viewer {
  readonly everything: boolean;
  readonly own: readonly string[];
  /** Only `own`'s sessions, never the org's: a credential without the `search` scope (a
   * device token, a writing service) searches only its own owner's sessions (X5.10). */
  readonly ownOnly?: boolean;
  /** The authoritative read check, run on each result's live metadata. */
  canRead(session: { owner: string; visibility?: Visibility }): boolean;
}

export function viewerFor(
  principal: Principal,
  aliases: OwnerAliases = new OwnerAliases(),
): Viewer {
  return {
    everything: principal.scopes.has("search") && seesEverything(principal),
    own: aliases.storedAs(principal.owner),
    ownOnly: !principal.scopes.has("search"),
    canRead: (session) => canRead(principal, session, aliases, "search"),
  };
}

export const LOCAL_VIEWER: Viewer = Object.freeze({
  everything: true,
  own: [],
  canRead: () => true,
});
