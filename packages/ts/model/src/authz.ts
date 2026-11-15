/** The pipeline's authorize stage (X4.3 stage 1), as a contract between the layers: the
 * pipeline (`@seshi/pipeline`) calls an `Authorizer`, and the auth package (`@seshi/auth`)
 * supplies the real one. Both are on layer 2 and may not import each other, so the types live
 * here (X3.2). */

import type { Envelope } from "./generated/envelope";
import type { OwnerBasis, Writer } from "./schemas/store";

/** Who may write an envelope's session, as the authorizer resolved it. */
export interface Authorization {
  /** Whose session it is (X5.4, X5.8). */
  owner: string;
  owner_basis: OwnerBasis;
  /** Who writes (X5.5): recorded on the change entry, and as the session's original writer
   * when it is new. */
  writer: Writer;
  /** An admin may replace any session (X4.6, X5.3). */
  admin: boolean;
}

export interface Authorizer {
  /** Check that the envelope's caller may write it and resolve whose session it is. Throws
   * `Forbidden` (permanent) when it may not, `StoreError` when it cannot tell (transient). */
  authorize(envelope: Envelope): Authorization | Promise<Authorization>;
}
