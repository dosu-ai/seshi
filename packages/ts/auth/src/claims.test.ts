import { describe, expect, it } from "vitest";
import { idTokenClaims, pickClaims } from "./claims";

describe("claims (X5.5)", () => {
  it("keep the allowlisted fields, bounded, and drop the rest", () => {
    expect(
      pickClaims({
        email: " a@acme.com ",
        git_email: "a@users.noreply.github.com",
        git_name: "A",
        account_ids: { anthropic: "acct-1", "Bad Vendor": "x", openai: 7 },
        token: "secret",
        name: "x".repeat(400),
      }),
    ).toEqual({
      email: "a@acme.com",
      git_email: "a@users.noreply.github.com",
      git_name: "A",
      account_ids: { anthropic: "acct-1" },
    });
    expect(pickClaims({ token: "x" })).toBeUndefined();
    expect(pickClaims("x")).toBeUndefined();
    expect(pickClaims(null)).toBeUndefined();
  });

  it("take an ID token's email only when the IdP does not call it unverified", () => {
    expect(idTokenClaims({ email: "A@acme.com", name: "A", email_verified: true })).toEqual({
      email: "a@acme.com",
      name: "A",
    });
    expect(idTokenClaims({ email: "a@acme.com", email_verified: false })).toEqual({});
    expect(idTokenClaims({ email: "a@acme.com" })).toEqual({ email: "a@acme.com" });
  });
});
