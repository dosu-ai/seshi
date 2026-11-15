/** `[auth]`: who may call the server (X5). Static tokens for one person and development,
 * the trusted org key, an optional IdP, admins, owner aliases and the keys session tokens are
 * signed with. */

import * as z from "zod";
import { secret } from "../secret";
import { httpUrl } from "./common";

export const oidcSection = z
  .strictObject({
    issuer: httpUrl.describe("The IdP's issuer URL; its keys come from its discovery document."),
    client_id: z
      .string()
      .min(1)
      .describe("The CLI's client id, registered in the IdP as a public client (X5.7)."),
    audience: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The ID token audience to require, specific to this deployment (X1.4); the client id when unset.",
      ),
    owner_claim: z
      .string()
      .min(1)
      .default("sub")
      .describe("The claim an owner ID is taken from (X5.8): sub, or oid on Entra, or email."),
    admin_group: z
      .string()
      .min(1)
      .optional()
      .describe("Members of this IdP group are admins (X5.3)."),
  })
  .describe("Sign-in through an identity provider (X5.2). Absent: no IdP.");

export const authSection = z
  .strictObject({
    tokens: z
      .record(z.string().min(1), secret())
      .default({})
      .describe(
        "Static tokens (X5.12): owner = token, each one everything for that owner, for single-user and development setups. 16+ characters.",
      ),
    legacy_token_secret: secret()
      .optional()
      .describe(
        "Accept HS256 JWTs signed with this secret (sub = owner, exp required). Kept from sessiondb until seshi tokens replace it (X5.2). 32+ characters.",
      ),
    org_key: z
      .strictObject({
        enabled: z
          .boolean()
          .default(true)
          .describe("Accept the org key: members write as the username they state (X5.12)."),
      })
      .prefault({})
      .describe("The trusted org key (X5.12)."),
    oidc: oidcSection.optional(),
    admins: z
      .array(z.string().min(1))
      .default([])
      .describe("Emails of people who are admins with an IdP (X5.3)."),
    owner_aliases: z
      .record(z.string().min(1), z.string().min(1))
      .default({})
      .describe("Old owner ID = new owner ID, applied when reading and searching (X5.8)."),
    session_keys: z
      .record(z.string().min(1), secret())
      .default({})
      .describe(
        "Keys that sign session tokens, by key id (X5.9). Old keys stay to verify until they expire.",
      ),
    session_key_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The key in session_keys that signs new session tokens; the only one when there is one.",
      ),
  })
  .prefault({})
  .describe("Who may call the server (X5).");

export type AuthSection = z.output<typeof authSection>;
export type OidcSection = z.output<typeof oidcSection>;
