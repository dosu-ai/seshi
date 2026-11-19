import { createHash } from "node:crypto";
import { assertSourceId, isOwner } from "@seshi/store";

export const SERVICE_PREFIX = "svc:";

export function serviceOwner(sourceId: string): string {
  return `${SERVICE_PREFIX}${assertSourceId(sourceId)}`;
}

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

/** The source a service account belongs to (`svc:otlp-prod` → `otlp-prod`), or undefined for
 * any other owner. What a service token writes is filed under that source: its visibility,
 * filter and health are the source's (X5.4, X5.10). */
export function serviceSourceId(owner: string): string | undefined {
  return isServiceOwner(owner) ? owner.slice(SERVICE_PREFIX.length) : undefined;
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

  canonical(owner: string): string {
    let at = owner;
    for (let next = this.to.get(at); next !== undefined; next = this.to.get(at)) at = next;
    return at;
  }

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
