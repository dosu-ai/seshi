/** Who is calling (X5.1): the principal a credential stands for, with its role and scopes. */

import type { CallerKind, Claims, OwnerBasis, Visibility } from "@seshi/model";
import type { Role, Scope } from "./scopes";

/** Which credential from the X5 table was presented. */
export type CredentialType = "org_key" | "session" | "admin" | "device" | "service" | "static";

export interface Principal {
  /** The caller kind written into envelopes and writers (X5.5). */
  kind: CallerKind;
  /** Whose sessions it acts as: the person's owner id, or `svc:<id>` (X5.8). */
  owner: string;
  owner_basis: OwnerBasis;
  role: Role;
  scopes: ReadonlySet<Scope>;
  credential: CredentialType;
  /** The token record's id, the session token's id, or a hash naming a static token; never
   * the secret. */
  credential_id: string;
  /** The token's default visibility for what it writes (X5.10). */
  visibility?: Visibility;
  /** When a session token was issued: a delete needs a fresh one (X5.3). */
  issued_at?: Date;
  expires_at?: Date;
  /** What the credential established about the person: an org-key caller's stated username,
   * an IdP email and name. */
  claims: Claims;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}
