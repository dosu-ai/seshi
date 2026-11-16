import { describe, expect, it } from "vitest";
import { checkServerConfig } from "./check";
import { loadConfig } from "./load";
import { serverConfigSchema } from "./server/index";
import { configEntries } from "./show";

const load = (env: Record<string, string>) =>
  loadConfig(serverConfigSchema, {
    env: { SESHI_STORE__URL: "file:///data", ...env },
    resolveSecrets: false,
  });

describe("configEntries", () => {
  it("lists every value with its origin, durations and sizes in units, secrets masked", () => {
    const loaded = load({
      SESHI_AUTH__TOKENS__ALICE: "alice-token-0123456789",
      SESHI_AUTH__SESSION_KEYS__K1__ENV: "SHARED",
      SESHI_RECORDS__FAILED_RETENTION: "7d",
    });
    const byName = Object.fromEntries(configEntries(loaded).map((e) => [e.name, e]));
    expect(byName["store.url"]).toMatchObject({ value: "file:///data", origin: { source: "env" } });
    expect(byName["auth.tokens.alice"]?.value).toBe("<secret>");
    expect(byName["auth.session_keys.k1"]?.value).toBe("<secret: env SHARED>");
    expect(byName["records.failed_retention"]?.value).toBe("7d");
    expect(byName["records.dropped_retention"]).toMatchObject({
      value: "30d",
      origin: { source: "default" },
    });
    expect(byName["limits.max_records_bytes"]?.value).toBe("32MiB");
    expect(byName.sources?.value).toEqual([]);
    expect(byName["auth.owner_aliases"]?.value).toEqual({});
    expect(JSON.stringify(configEntries(loaded))).not.toContain("alice-token");
  });
});

describe("checkServerConfig", () => {
  const config = (env: Record<string, string>, toml?: Record<string, unknown>) =>
    serverConfigSchema.parse({ store: { url: "file:///data" }, ...toml, ...env });

  it("warns that owner visibility is not enforced without an IdP (X5.10)", () => {
    const report = checkServerConfig(
      config(
        {},
        { default_visibility: "owner", sources: [{ id: "o", type: "otlp", visibility: "owner" }] },
      ),
    );
    expect(report.warnings).toEqual([
      'default_visibility, sources[o].visibility = "owner" is not enforced without an IdP: the org key reads every session (X5.10)',
    ]);
    const withIdp = checkServerConfig(
      config(
        {},
        {
          default_visibility: "owner",
          auth: {
            oidc: { issuer: "https://idp.acme.com", client_id: "c" },
            session_keys: { k1: "k".repeat(32) },
          },
        },
      ),
    );
    // Mixed with an IdP, org-key holders can still state anyone's username (X5.12).
    expect(withIdp.warnings).toEqual([
      'default_visibility = "owner" is not enforced against org-key holders: they can state any username; set auth.org_key.enabled = false once everyone signs in (X5.10, X5.12)',
    ]);
    const idpOnly = checkServerConfig(
      config(
        {},
        {
          default_visibility: "owner",
          auth: {
            oidc: { issuer: "https://idp.acme.com", client_id: "c" },
            session_keys: { k1: "k".repeat(32) },
            org_key: { enabled: false },
          },
        },
      ),
    );
    expect(idpOnly.warnings).toEqual([]);
  });

  it("names every provider review sends data to (F3.5)", () => {
    const report = checkServerConfig(
      config(
        {},
        {
          review: {
            policies: [
              {
                id: "p",
                decision: { provider: "anthropic", api_key: "sk-test" },
                redactor: {
                  provider: "openai-compatible",
                  model: "r",
                  base_url: "http://gpu:8000/v1",
                },
              },
              { id: "q", decision: { api_key: "sk-test" } },
            ],
          },
        },
      ),
    );
    expect(report.notices).toEqual([
      "review policy 'p' sends envelopes to anthropic at https://api.anthropic.com (decision: claude-haiku-5-5)",
      "review policy 'p' sends envelopes to openai-compatible at http://gpu:8000/v1 (redactor: r)",
      // The redactor defaults to the decision step's provider and model (F3.5).
      "review policy 'q' sends envelopes to anthropic at https://api.anthropic.com (decision: claude-haiku-5-5)",
      "review policy 'q' sends envelopes to anthropic at https://api.anthropic.com (redactor: claude-haiku-5-5)",
    ]);
    expect(report.warnings).toEqual([]);
  });

  it("warns that server.public_url does nothing", () => {
    expect(
      checkServerConfig(config({}, { server: { public_url: "https://seshi.acme.com" } })).warnings,
    ).toEqual([
      "server.public_url has no effect: nothing in seshi reads it (sign-in goes from the CLI to the IdP directly)",
    ]);
    expect(checkServerConfig(config({})).warnings).toEqual([]);
  });

  it("warns that relaxing require_user or require_reply does nothing yet", () => {
    expect(
      checkServerConfig(
        config(
          {},
          {
            filter: { require_reply: false },
            sources: [{ id: "o", type: "otlp", filter: { require_user: false } }],
          },
        ),
      ).warnings,
    ).toEqual([
      "filter.require_reply, sources[o].filter.require_user = false has no effect yet: a session without a user record or a reply cannot be stored as a trace",
    ]);
  });

  it("notes disabled sources", () => {
    expect(
      checkServerConfig(config({}, { sources: [{ id: "o", type: "otlp", enabled: false }] }))
        .notices,
    ).toEqual(["source 'o' is disabled"]);
  });
});
