/** The pipeline's authorize stage with the X5 ownership rules (X4.3 stage 1). The HTTP routes
 * authenticate the credential and check its scopes before an envelope exists; what reaches the
 * pipeline is an envelope whose caller, owner and basis this checks against each other, so no
 * route, poller or integration can write a session in someone else's name:
 *
 * - A service account's sessions are its own (`svc:<id>`, basis `service`), and only a service
 *   account writes as one (X5.4). A poller or OTLP destination writes as its own source's
 *   service account.
 * - Anyone else writes their own sessions: the owner is the caller's principal. An admin may
 *   write for any owner.
 * - `claimed` is the org-key basis (X5.12): only a person caller has it.
 *
 * The session's original writer and `admin` then decide replace (`mayReplace`, X4.6). */

import type { Authorization, Authorizer, Envelope, Writer } from "@seshi/model";
import { Forbidden } from "@seshi/model";
import { isServiceOwner, serviceOwner } from "./owner";

function writerOf(envelope: Envelope): Writer {
  const { caller } = envelope;
  return {
    kind: caller.kind,
    principal: caller.principal,
    ...(caller.credential_id ? { credential_id: caller.credential_id } : {}),
    source_id: envelope.source_id,
  };
}

export function ownershipAuthorizer(): Authorizer {
  return {
    authorize(envelope: Envelope): Authorization {
      const { caller, owner, owner_basis } = envelope;
      const admin = caller.kind === "admin";
      const service = isServiceOwner(owner);
      if (service !== (owner_basis === "service")) {
        throw new Forbidden(
          "a service account's sessions have owner_basis service, and only a service account's do",
        );
      }
      if (caller.kind === "service") {
        if (!isServiceOwner(caller.principal) || owner !== caller.principal) {
          throw new Forbidden("a service account writes only its own sessions (X5.4)");
        }
        if (envelope.source !== "upload" && envelope.source !== "hook") {
          if (caller.principal !== serviceOwner(envelope.source_id)) {
            throw new Forbidden(
              `source ${envelope.source_id} writes as its own service account, ${serviceOwner(envelope.source_id)} (X5.4)`,
            );
          }
        }
      } else {
        if (service) throw new Forbidden("only a service account writes as svc:… (X5.4)");
        if (owner !== caller.principal && !admin) {
          throw new Forbidden("a caller writes only its own sessions");
        }
        if (owner_basis === "claimed" && caller.kind !== "person") {
          throw new Forbidden("only an org-key caller's owner is claimed (X5.12)");
        }
      }
      return { owner, owner_basis, writer: writerOf(envelope), admin };
    },
  };
}
