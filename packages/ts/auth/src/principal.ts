import type { CallerKind, Claims, OwnerBasis, Visibility } from "@seshi/model";
import type { Role, Scope } from "./scopes";

export type CredentialType = "org_key" | "session" | "admin" | "device" | "service" | "static";

export interface Principal {
  kind: CallerKind;
  owner: string;
  owner_basis: OwnerBasis;
  role: Role;
  scopes: ReadonlySet<Scope>;
  credential: CredentialType;
  credential_id: string;
  visibility?: Visibility;
  issued_at?: Date;
  expires_at?: Date;
  claims: Claims;
}

export function hasScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.has(scope);
}
