import { canRead, OwnerAliases, type Principal, seesEverything } from "@seshi/auth";
import type { Visibility } from "@seshi/model";

export interface Viewer {
  readonly everything: boolean;
  readonly own: readonly string[];
  /** The authoritative read check, run on each result's live metadata. */
  canRead(session: { owner: string; visibility?: Visibility }): boolean;
}

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

export const LOCAL_VIEWER: Viewer = Object.freeze({
  everything: true,
  own: [],
  canRead: () => true,
});
