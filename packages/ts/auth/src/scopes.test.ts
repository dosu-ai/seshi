import { describe, expect, it } from "vitest";
import { CREDENTIAL_SCOPES, isScope, SCOPES, serviceScopesValid } from "./scopes";

describe("scopes (X5.3)", () => {
  it("are the six the decision lists", () => {
    expect([...SCOPES]).toEqual([
      "sessions:write",
      "sessions:read",
      "sessions:delete",
      "search",
      "sources:admin",
      "tokens:admin",
    ]);
    expect(isScope("search")).toBe(true);
    expect(isScope("sessions:admin")).toBe(false);
    expect(isScope(3)).toBe(false);
  });

  it("give the org key no delete, a device write only, an admin everything", () => {
    expect(CREDENTIAL_SCOPES.org).not.toContain("sessions:delete");
    expect([...CREDENTIAL_SCOPES.device]).toEqual(["sessions:write"]);
    expect([...CREDENTIAL_SCOPES.admin]).toEqual([...SCOPES]);
    expect(CREDENTIAL_SCOPES.member_session).not.toContain("sessions:write");
  });

  it("let a service token read or write, never both (X5.4)", () => {
    expect(serviceScopesValid(["sessions:read", "search"])).toBe(true);
    expect(serviceScopesValid(["sessions:read"])).toBe(true);
    expect(serviceScopesValid(["sessions:write"])).toBe(true);
    expect(serviceScopesValid(["sessions:write", "sessions:read"])).toBe(false);
    expect(serviceScopesValid(["tokens:admin"])).toBe(false);
    expect(serviceScopesValid([])).toBe(false);
  });
});
