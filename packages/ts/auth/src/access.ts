import { Forbidden, type OwnerBasis, type Visibility } from "@seshi/model";
import { OwnerAliases } from "./owner";
import type { Principal } from "./principal";
import type { Scope } from "./scopes";

export const DELETE_FRESH_MS = 10 * 60 * 1000;

export interface SessionAccess {
  owner: string;
  visibility?: Visibility;
}

const NO_ALIASES = new OwnerAliases();

/** Throws `Forbidden` unless the principal's credential carries `scope`. */
export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.has(scope)) {
    throw new Forbidden(`this credential cannot do that: it needs the ${scope} scope`);
  }
}

export function isOwnSession(
  principal: Principal,
  owner: string,
  aliases: OwnerAliases = NO_ALIASES,
): boolean {
  return aliases.same(principal.owner, owner);
}

export function seesEverything(principal: Principal): boolean {
  return principal.role === "admin" || principal.role === "service";
}

/** Whether the principal may read the session (X5.10). Scopes are checked separately. */
export function canRead(
  principal: Principal,
  session: SessionAccess,
  aliases: OwnerAliases = NO_ALIASES,
): boolean {
  if (seesEverything(principal)) return true;
  if (isOwnSession(principal, session.owner, aliases)) return true;
  return (session.visibility ?? "org") === "org";
}

/** Throws `Forbidden` unless the principal may delete a session of `owner` at `now` (X5.3). */
export function requireDelete(
  principal: Principal,
  owner: string,
  now: Date,
  aliases: OwnerAliases = NO_ALIASES,
): void {
  requireScope(principal, "sessions:delete");
  if (principal.role !== "admin" && !isOwnSession(principal, owner, aliases)) {
    throw new Forbidden("only the session's owner or an admin may delete it");
  }
  if (principal.credential === "session") {
    const issued = principal.issued_at?.getTime() ?? 0;
    if (now.getTime() - issued > DELETE_FRESH_MS) {
      throw new Forbidden(
        "a delete needs a session token issued in the last 10 minutes: sign in again (seshi login)",
      );
    }
  }
}

/** Throws `Forbidden` unless the principal's credential may change a session's visibility at
 * all: one that writes sessions (a device token, on its owner's own sessions) or one that reads
 * them (a sign-in, an admin). Which sessions it may change is `requireVisibilityChange`'s. */
export function requireVisibilityScope(principal: Principal): void {
  if (!principal.scopes.has("sessions:write") && !principal.scopes.has("sessions:read")) {
    throw new Forbidden(
      "this credential cannot do that: it needs the sessions:write or sessions:read scope",
    );
  }
}

/** Whether the principal finds only its own sessions when changing visibility: a credential that
 * writes but cannot read, so a session it does not own is not there for it (404), as for a read.
 * It learns nothing of anyone else's sessions. */
export function changesOnlyOwn(principal: Principal): boolean {
  return principal.role !== "admin" && !principal.scopes.has("sessions:read");
}

/** Throws `Forbidden` unless the principal may change who reads a session of `owner`, whose
 * owner was established as `basis` (X5.10). The owner may, with a credential that writes
 * sessions or reads them; an admin may change anyone's. */
export function requireVisibilityChange(
  principal: Principal,
  owner: string,
  aliases: OwnerAliases = NO_ALIASES,
  basis?: OwnerBasis,
): void {
  requireVisibilityScope(principal);
  if (principal.role !== "admin" && !isOwnSession(principal, owner, aliases)) {
    throw new Forbidden("only the session's owner or an admin may change its visibility");
  }
  if (
    principal.role !== "admin" &&
    principal.owner_basis === "claimed" &&
    basis !== undefined &&
    basis !== "claimed"
  ) {
    throw new Forbidden(
      "the org key cannot change a session whose owner was verified: sign in, or ask an admin",
    );
  }
}
