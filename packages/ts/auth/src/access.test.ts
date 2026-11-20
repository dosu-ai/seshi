import { Forbidden } from "@seshi/model";
import { describe, expect, it } from "vitest";
import {
  canRead,
  DELETE_FRESH_MS,
  requireDelete,
  requireScope,
  requireVisibilityChange,
} from "./access";
import { OwnerAliases } from "./owner";
import type { Principal } from "./principal";
import { CREDENTIAL_SCOPES, type Scope } from "./scopes";

const now = new Date("2026-11-14T09:00:00.000Z");

function principal(
  over: Partial<Omit<Principal, "scopes">> & { scopes?: readonly Scope[] },
): Principal {
  return {
    kind: "person",
    owner: "alice",
    owner_basis: "verified",
    role: "member",
    credential: "session",
    credential_id: "c",
    issued_at: now,
    claims: {},
    ...over,
    scopes: new Set(over.scopes ?? CREDENTIAL_SCOPES.member_session),
  };
}

const alice = principal({});
const orgKey = principal({
  credential: "org_key",
  owner_basis: "claimed",
  scopes: CREDENTIAL_SCOPES.org,
});
const admin = principal({
  kind: "admin",
  owner: "ops",
  role: "admin",
  credential: "admin",
  scopes: CREDENTIAL_SCOPES.admin,
});
const reader = principal({
  kind: "service",
  owner: "svc:sync",
  role: "service",
  credential: "service",
  owner_basis: "service",
  scopes: CREDENTIAL_SCOPES.service_read,
});
const device = principal({
  kind: "device",
  credential: "device",
  scopes: CREDENTIAL_SCOPES.device,
});

describe("reads (X5.10)", () => {
  it("show members their own sessions and the org's; admins and services everything", () => {
    const bobsPrivate = { owner: "bob", visibility: "owner" as const };
    const bobsShared = { owner: "bob", visibility: "org" as const };
    const alicesPrivate = { owner: "alice", visibility: "owner" as const };
    expect(canRead(alice, bobsShared)).toBe(true);
    expect(canRead(alice, bobsPrivate)).toBe(false);
    expect(canRead(alice, alicesPrivate)).toBe(true);
    expect(canRead(orgKey, bobsPrivate)).toBe(false);
    expect(canRead(admin, bobsPrivate)).toBe(true);
    expect(canRead(reader, bobsPrivate)).toBe(true);
    expect(canRead(alice, { owner: "bob" })).toBe(true);
  });

  it("read an old owner id's sessions as the new id's (X5.8)", () => {
    const aliases = new OwnerAliases({ "alice-old": "alice" });
    expect(canRead(alice, { owner: "alice-old", visibility: "owner" }, aliases)).toBe(true);
    expect(canRead(alice, { owner: "alice-old", visibility: "owner" })).toBe(false);
  });
});

describe("deletes (X5.3)", () => {
  it("let a member delete their own sessions with a fresh session token", () => {
    expect(() => requireDelete(alice, "alice", now)).not.toThrow();
    expect(() =>
      requireDelete(alice, "alice", new Date(now.getTime() + DELETE_FRESH_MS + 1)),
    ).toThrow("issued in the last 10 minutes");
    expect(() => requireDelete(alice, "bob", now)).toThrow("owner or an admin");
  });

  it("never let the org key or a device delete; an admin token deletes anything, any time", () => {
    expect(() => requireDelete(orgKey, "alice", now)).toThrow(Forbidden);
    expect(() => requireDelete(device, "alice", now)).toThrow("sessions:delete");
    expect(() => requireDelete(admin, "bob", new Date(now.getTime() + 86_400_000))).not.toThrow();
    const adminSession = { ...admin, credential: "session" as const, issued_at: now };
    expect(() =>
      requireDelete(adminSession, "bob", new Date(now.getTime() + DELETE_FRESH_MS + 1)),
    ).toThrow("10 minutes");
  });

  it("let a static token delete its own owner's sessions without a freshness rule", () => {
    const fixed = principal({
      kind: "static",
      credential: "static",
      scopes: CREDENTIAL_SCOPES.static,
      issued_at: undefined,
    });
    expect(() => requireDelete(fixed, "alice", now)).not.toThrow();
    expect(() => requireDelete(fixed, "bob", now)).toThrow(Forbidden);
  });
});

describe("visibility changes and scopes", () => {
  it("are for the owner or an admin, with a credential that reads or writes sessions", () => {
    expect(() => requireVisibilityChange(alice, "alice")).not.toThrow();
    expect(() => requireVisibilityChange(alice, "bob")).toThrow("owner or an admin");
    expect(() => requireVisibilityChange(admin, "bob")).not.toThrow();
    expect(() => requireVisibilityChange(device, "alice")).not.toThrow();
    expect(() => requireVisibilityChange(device, "bob")).toThrow("owner or an admin");
    expect(() => requireVisibilityChange(reader, "alice")).toThrow("owner or an admin");
    const searcher = principal({ scopes: ["search"] });
    expect(() => requireVisibilityChange(searcher, "alice")).toThrow(
      "it needs the sessions:write or sessions:read scope",
    );
  });

  it("let a credential that reads nothing find only its own sessions", () => {
    const bobsShared = { owner: "bob", visibility: "org" as const };
    expect(canRead(device, bobsShared)).toBe(false);
    expect(canRead(device, { owner: "alice", visibility: "owner" })).toBe(true);
    const writer = principal({ role: "service", owner: "svc:otlp", scopes: ["sessions:write"] });
    expect(canRead(writer, bobsShared)).toBe(false);
    expect(canRead(alice, bobsShared)).toBe(true);
    expect(canRead(reader, bobsShared)).toBe(true);
  });

  it("keep the org key off a session whose owner was verified (X5.12)", () => {
    expect(() => requireVisibilityChange(orgKey, "alice", undefined, "claimed")).not.toThrow();
    expect(() => requireVisibilityChange(orgKey, "alice", undefined, "verified")).toThrow(
      "owner was verified",
    );
    expect(() => requireVisibilityChange(alice, "alice", undefined, "verified")).not.toThrow();
    expect(() => requireVisibilityChange(admin, "alice", undefined, "verified")).not.toThrow();
  });

  it("say which scope was missing", () => {
    expect(() => requireScope(reader, "sessions:write")).toThrow(
      "it needs the sessions:write scope",
    );
  });
});
