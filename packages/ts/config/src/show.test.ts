import { describe, expect, it } from "vitest";
import { checkServerConfig } from "./check";
import { loadConfig } from "./load";
import { serverConfigSchema } from "./server/index";
import { configEntries, displayTree } from "./show";

const load = (env: Record<string, string>) =>
  loadConfig(serverConfigSchema, {
    env: { SESHI_STORE__URL: "file:///data", ...env },
    resolveSecrets: false,
  });

describe("configEntries", () => {
  it("lists every value with its origin, durations and sizes in units, secrets masked", () => {
    const loaded = load({
      SESHI_AUTH__TOKENS__ALICE: "alice-token-0123456789",
      SESHI_AUTH__LEGACY_TOKEN_SECRET__ENV: "SHARED",
      SESHI_RECORDS__FAILED_RETENTION: "7d",
    });
    const byName = Object.fromEntries(configEntries(loaded).map((e) => [e.name, e]));
    expect(byName["store.url"]).toMatchObject({ value: "file:///data", origin: { source: "env" } });
    expect(byName["auth.tokens.alice"]?.value).toBe("<secret>");
    expect(byName["auth.legacy_token_secret"]?.value).toBe("<secret: env SHARED>");
    expect(byName["records.failed_retention"]?.value).toBe("7d");
    expect(byName["records.dropped_retention"]).toMatchObject({
      value: "30d",
      origin: { source: "default" },
    });
    expect(byName["limits.max_records_bytes"]?.value).toBe("32MiB");
    expect(byName.sources?.value).toEqual([]);
    expect(byName["auth.session_keys"]?.value).toEqual({});
    expect(JSON.stringify(configEntries(loaded))).not.toContain("alice-token");
  });

  it("nests the printed values for JSON", () => {
    const tree = displayTree(load({})) as Record<string, Record<string, unknown>>;
    expect(tree.store).toEqual({ url: "file:///data", format: "letta" });
    expect(tree.limits?.max_upload_bytes).toBe("64MiB");
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
          auth: { oidc: { issuer: "https://idp.acme.com", client_id: "c" } },
        },
      ),
    );
    expect(withIdp.warnings).toEqual([]);
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
                decision: { provider: "bedrock", model: "d" },
                redactor: {
                  provider: "openai-compatible",
                  model: "r",
                  base_url: "http://gpu:8000/v1",
                },
              },
            ],
          },
        },
      ),
    );
    expect(report.notices).toEqual([
      "review policy 'p' sends envelopes to bedrock (decision: d)",
      "review policy 'p' sends envelopes to openai-compatible at http://gpu:8000/v1 (redactor: r)",
    ]);
    expect(report.warnings).toEqual([
      "review policy 'p' redactor has no api_key: openai-compatible will refuse its calls",
    ]);
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
