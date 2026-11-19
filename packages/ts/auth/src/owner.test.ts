import { describe, expect, it } from "vitest";
import {
  claimOwner,
  isServiceOwner,
  OwnerAliases,
  ownerId,
  serviceOwner,
  usernameOwner,
} from "./owner";

describe("owner ids (X5.8)", () => {
  it("keep a value that fits, and hash one that does not", () => {
    expect(ownerId("alice@acme.com")).toBe("alice@acme.com");
    expect(ownerId("00uAbC123")).toBe("00uAbC123");
    const hashed = ownerId("Ålice Smith");
    expect(hashed).toMatch(/^h-[0-9a-f]{20}$/);
    expect(ownerId("Ålice Smith")).toBe(hashed);
    expect(ownerId("../etc")).toMatch(/^h-/);
    expect(ownerId("")).toMatch(/^h-/);
  });

  it("never let a person be a service account", () => {
    expect(ownerId("svc:otlp")).toMatch(/^h-/);
    expect(usernameOwner("svc:otlp")).toMatch(/^h-/);
  });

  it("lowercase an org-key username (X5.12)", () => {
    expect(usernameOwner("Alice@Acme.com")).toBe("alice@acme.com");
    expect(usernameOwner("  bob ")).toBe("bob");
    expect(usernameOwner("   ")).toBeUndefined();
  });

  it("take the owner claim from an ID token, lowercasing only an email", () => {
    expect(claimOwner({ sub: "00uAbC" }, "sub")).toBe("00uAbC");
    expect(claimOwner({ email: "Alice@Acme.com" }, "email")).toBe("alice@acme.com");
    expect(claimOwner({ oid: "6f1c-2e" }, "oid")).toBe("6f1c-2e");
    expect(claimOwner({ sub: 7 }, "sub")).toBeUndefined();
    expect(claimOwner({}, "sub")).toBeUndefined();
    expect(claimOwner({ sub: "auth0|123" }, "sub")).toMatch(/^h-/);
  });

  it("name a source's service account svc:<source-id> (X5.4)", () => {
    expect(serviceOwner("otlp-prod")).toBe("svc:otlp-prod");
    expect(isServiceOwner("svc:otlp-prod")).toBe(true);
    expect(isServiceOwner("alice")).toBe(false);
    expect(() => serviceOwner("Bad Id")).toThrow();
  });
});

describe("owner aliases (X5.8)", () => {
  const aliases = new OwnerAliases({
    alice: "alice@acme.com",
    "alice-old": "alice",
    bob: "bob@acme.com",
  });

  it("follow an alias to the end", () => {
    expect(aliases.canonical("alice-old")).toBe("alice@acme.com");
    expect(aliases.canonical("alice")).toBe("alice@acme.com");
    expect(aliases.canonical("carol")).toBe("carol");
    expect(aliases.same("alice-old", "alice@acme.com")).toBe(true);
    expect(aliases.same("alice", "bob")).toBe(false);
  });

  it("give every folder an owner's sessions may be under, the canonical one first", () => {
    expect(aliases.storedAs("alice@acme.com")).toEqual(["alice@acme.com", "alice", "alice-old"]);
    expect(aliases.storedAs("alice-old")).toEqual(["alice@acme.com", "alice", "alice-old"]);
    expect(aliases.storedAs("carol")).toEqual(["carol"]);
  });

  it("refuse a circle or an id that is not one", () => {
    expect(() => new OwnerAliases({ a: "b", b: "a" })).toThrow("leads round in a circle");
    expect(() => new OwnerAliases({ "a/b": "c" })).toThrow("is not an owner id");
    expect(new OwnerAliases({ a: "a" }).storedAs("a")).toEqual(["a"]);
  });
});
