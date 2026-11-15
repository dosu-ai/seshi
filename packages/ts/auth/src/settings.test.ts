import { loadConfig, serverConfigSchema } from "@seshi/config";
import { describe, expect, it } from "vitest";
import { AuthSettingsError, authSettings } from "./settings";

const config = (env: Record<string, string>) =>
  loadConfig(serverConfigSchema, { env: { SESHI_STORE__URL: "file:///tmp/x", ...env } }).config;

describe("authSettings", () => {
  it("reveals and checks [auth]", () => {
    const settings = authSettings(
      config({
        SESHI_AUTH__TOKENS__ALICE: " alice-token-0123456789 ",
        SESHI_AUTH__ORG_KEY__ENABLED: "false",
        SESHI_AUTH__OIDC__ISSUER: "https://acme.okta.com",
        SESHI_AUTH__OIDC__CLIENT_ID: "cli",
        SESHI_AUTH__OIDC__ADMIN_GROUP: "admins",
        SESHI_AUTH__SESSION_KEYS__K1: "k".repeat(32),
        SESHI_AUTH__ADMINS: "Ops@Acme.com",
        SESHI_AUTH__OWNER_ALIASES__ALICE: "alice@acme.com",
      }),
    );
    expect(settings).toEqual({
      staticTokens: [{ token: "alice-token-0123456789", owner: "alice" }],
      orgKey: false,
      oidc: {
        issuer: "https://acme.okta.com",
        client_id: "cli",
        audience: "cli",
        owner_claim: "sub",
        admin_group: "admins",
        groups_claim: "groups",
      },
      admins: ["ops@acme.com"],
      aliases: { alice: "alice@acme.com" },
      sessionKeys: { k1: "k".repeat(32) },
      signingKeyId: "k1",
    });
  });

  it("names the setting that cannot work", () => {
    const fails = (env: Record<string, string>, message: string) => {
      expect(() => authSettings(config(env))).toThrow(AuthSettingsError);
      expect(() => authSettings(config(env))).toThrow(message);
    };
    fails({ SESHI_AUTH__TOKENS__ALICE: "short" }, "auth.tokens.alice must be 16+");
    fails(
      {
        SESHI_AUTH__TOKENS__A: "same-token-0123456789",
        SESHI_AUTH__TOKENS__B: "same-token-0123456789",
      },
      "the same token",
    );
    fails({ SESHI_AUTH__SESSION_KEYS__K1: "short" }, "auth.session_keys.k1 must be 32+");
    fails({ SESHI_AUTH__OWNER_ALIASES__A: "b", SESHI_AUTH__OWNER_ALIASES__B: "a" }, "circle");
  });
});
