/** Owner ids (X5.8). There is no stored list of people: an owner id is derived every time from
 * the caller's identity.
 *
 * - With an IdP: the claim `owner_claim` names (`sub` by default, `oid` on Entra, or `email`).
 * - With the org key: the username the caller states, lowercased.
 * - A service account: `svc:<source-id>` (X5.4).
 *
 * An id is one path segment of the layout (`owners/<owner>/`): letters, digits and `.`, `_`, `-`,
 * `@`, `+`. A value that does not fit is replaced by a short hash of it, so every identity maps
 * to one id and no identity can name a path. `[auth.owner_aliases]` maps old ids to new ones and
 * is applied when reading (X5.8). */

import { createHash } from "node:crypto";
import { assertSourceId, isOwner } from "@seshi/store";

export const SERVICE_PREFIX = "svc:";

/** The service account of a source (X5.4). */
export function serviceOwner(sourceId: string): string {
  return `${SERVICE_PREFIX}${assertSourceId(sourceId)}`;
}

/** What a poller or OTLP destination puts on its envelopes (X5.4): it runs inside the server,
 * needs no token, and writes as its source's service account, visible org-wide. */
export function serviceIdentity(sourceId: string): {
  caller: { kind: "service"; principal: string };
  owner: string;
  owner_basis: "service";
} {
  const owner = serviceOwner(sourceId);
  return { caller: { kind: "service", principal: owner }, owner, owner_basis: "service" };
}

export function isServiceOwner(owner: string): boolean {
  return owner.startsWith(SERVICE_PREFIX);
}

/** The owner id for an identity value: the value itself when it is a valid person id, else
 * `h-` and the first 20 hex digits of its SHA-256. Never a service account: a person cannot
 * name themselves `svc:…`. */
export function ownerId(value: string): string {
  const trimmed = value.trim();
  if (trimmed !== "" && isOwner(trimmed) && !isServiceOwner(trimmed)) return trimmed;
  return `h-${createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 20)}`;
}

/** The owner id of an org-key caller (X5.12): the stated username, lowercased. Undefined for
 * an empty one. */
export function usernameOwner(username: string): string | undefined {
  const trimmed = username.trim();
  if (trimmed === "") return undefined;
  return ownerId(trimmed.toLowerCase());
}

/** The owner id an ID token gives (X5.8): the value of `claim`. An email is lowercased, so an
 * IdP owner matches the org-key username for the same address. Undefined when the claim is
 * missing or not a string. */
export function claimOwner(claims: Record<string, unknown>, claim: string): string | undefined {
  const value = claims[claim];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return ownerId(claim === "email" ? value.toLowerCase() : value);
}

/** `[auth.owner_aliases]` (X5.8): old owner id to new one, applied when reading, so sessions
 * stored under the old id are read as the new id's. */
export class OwnerAliases {
  private readonly to = new Map<string, string>();
  private readonly from = new Map<string, string[]>();

  /** Throws for an alias that is not an owner id or that leads round in a circle. */
  constructor(aliases: Readonly<Record<string, string>> = {}) {
    for (const [oldId, newId] of Object.entries(aliases)) {
      if (!isOwner(oldId) || !isOwner(newId)) {
        throw new Error(`auth.owner_aliases: '${oldId}' = '${newId}' is not an owner id`);
      }
      if (oldId === newId) continue;
      this.to.set(oldId, newId);
    }
    for (const oldId of this.to.keys()) {
      const seen = new Set([oldId]);
      let at = this.to.get(oldId);
      while (at !== undefined) {
        if (seen.has(at)) {
          throw new Error(`auth.owner_aliases: '${oldId}' leads round in a circle`);
        }
        seen.add(at);
        at = this.to.get(at);
      }
      const canonical = this.canonical(oldId);
      this.from.set(canonical, [...(this.from.get(canonical) ?? []), oldId]);
    }
  }

  /** The id `owner` is read as: its alias, followed to the end. */
  canonical(owner: string): string {
    let at = owner;
    for (let next = this.to.get(at); next !== undefined; next = this.to.get(at)) at = next;
    return at;
  }

  /** Whether two stored ids are the same owner. */
  same(a: string, b: string): boolean {
    return this.canonical(a) === this.canonical(b);
  }

  /** The folders an owner's sessions may be stored under: its canonical id first, then every
   * old id that leads to it, in key order. */
  storedAs(owner: string): string[] {
    const canonical = this.canonical(owner);
    return [canonical, ...[...(this.from.get(canonical) ?? [])].sort()];
  }
}
