import { describe, expect, it } from "vitest";
import { Secret } from "../secret";
import {
  DEFAULT_DECISION_MAX_TOKENS,
  DEFAULT_MAX_INPUT_CHARS,
  DEFAULT_REDACTOR_MAX_TOKENS,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_REVIEW_TIMEOUT_MS,
  filterFor,
  parseListen,
  type ReviewPolicy,
  resolveSteps,
  type ServerConfig,
  serverConfigSchema,
  signingKeyId,
  visibilityFor,
} from "./index";

const parse = (tree: Record<string, unknown>) =>
  serverConfigSchema.safeParse({ store: { url: "s3://seshi/prod" }, ...tree });

const messages = (tree: Record<string, unknown>) => {
  const result = parse(tree);
  if (result.success) throw new Error("expected issues");
  return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

const ok = (tree: Record<string, unknown>): ServerConfig => {
  const result = parse(tree);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
};

describe("parseListen", () => {
  it("reads host:port, :port and port", () => {
    expect(parseListen(":7200")).toEqual({ hostname: "0.0.0.0", port: 7200 });
    expect(parseListen("7200")).toEqual({ hostname: "0.0.0.0", port: 7200 });
    expect(parseListen("127.0.0.1:0")).toEqual({ hostname: "127.0.0.1", port: 0 });
    expect(parseListen("localhost:80")).toEqual({ hostname: "localhost", port: 80 });
    expect(parseListen("[::1]:8080")).toEqual({ hostname: "::1", port: 8080 });
  });

  it("refuses the rest", () => {
    for (const text of ["", ":", "host", ":65536", "a b:1", "::1:80", "http://x:1"]) {
      expect(parseListen(text)).toBeUndefined();
    }
    expect(messages({ server: { listen: "nope" } })[0]).toContain("server.listen");
  });
});

describe("store", () => {
  it("takes s3, r2, az and file URLs", () => {
    for (const url of ["s3://b", "s3://b/p/q", "r2://b/p", "az://c/p", "file:///data", "/data"]) {
      expect(serverConfigSchema.safeParse({ store: { url } }).success).toBe(true);
    }
    for (const url of ["http://b", "s3://", "gs://b", "data"]) {
      expect(serverConfigSchema.safeParse({ store: { url } }).success).toBe(false);
    }
  });

  it("takes credentials as secrets", () => {
    const config = ok({
      store: {
        url: "r2://b/p",
        account_id: "acct",
        credentials: { access_key_id: { env: "R2_ID" }, secret_access_key: { file: "/run/k" } },
      },
    });
    expect(config.store.credentials?.access_key_id).toBeInstanceOf(Secret);
    expect(config.store.credentials?.secret_access_key?.ref).toEqual({
      kind: "file",
      path: "/run/k",
    });
  });

  it("takes an Azure account key or SAS token for az://, with the account name", () => {
    const keyed = ok({
      store: {
        url: "az://sessions/prod",
        account_name: "acct",
        credentials: { account_key: { env: "AZURE_KEY" } },
      },
    });
    expect(keyed.store.account_name).toBe("acct");
    expect(keyed.store.credentials?.account_key).toBeInstanceOf(Secret);
    expect(ok({ store: { url: "az://c", credentials: { sas_token: "sv=1&sig=x" } } })).toBeTruthy();
    expect(ok({ store: { url: "az://c" } }).store.credentials).toBeUndefined();
  });

  it("refuses mixed keys, half an S3 key, and keys for the other kind of bucket", () => {
    expect(
      messages({ store: { url: "az://c", credentials: { account_key: "k", sas_token: "s" } } }),
    ).toEqual([
      "store.credentials: give one kind of key: access_key_id and secret_access_key (s3://, r2://), account_key or sas_token (az://)",
    ]);
    expect(messages({ store: { url: "s3://b", credentials: { access_key_id: "a" } } })).toEqual([
      "store.credentials: access_key_id and secret_access_key go together",
    ]);
    expect(
      messages({
        store: { url: "az://c", credentials: { access_key_id: "a", secret_access_key: "s" } },
      }),
    ).toEqual([
      "store.credentials: an az:// bucket takes account_key or sas_token, not access_key_id",
    ]);
    expect(messages({ store: { url: "r2://b", credentials: { sas_token: "s" } } })[0]).toContain(
      "an s3:// or r2:// bucket takes access_key_id",
    );
  });
});

describe("auth", () => {
  it("takes the IdP settings, admins, aliases and session keys", () => {
    const config = ok({
      auth: {
        org_key: { enabled: false },
        oidc: {
          issuer: "https://acme.okta.com",
          client_id: "0oa1",
          audience: "seshi-prod",
          owner_claim: "email",
          admin_group: "seshi-admins",
        },
        admins: ["ops@acme.com"],
        owner_aliases: { "alice-old": "alice@acme.com" },
        session_keys: { k1: "x".repeat(32), k2: { env: "K2" } },
        session_key_id: "k2",
      },
    });
    expect(config.auth.oidc?.owner_claim).toBe("email");
    expect(signingKeyId(config)).toBe("k2");
  });

  it("checks session_key_id against session_keys", () => {
    expect(messages({ auth: { session_keys: { k1: "x" }, session_key_id: "k9" } })).toEqual([
      "auth.session_key_id: names no key in auth.session_keys (k1)",
    ]);
    expect(messages({ auth: { session_keys: { a: "x", b: "y" } } })).toEqual([
      "auth.session_key_id: required when auth.session_keys holds more than one key: which one signs",
    ]);
    expect(signingKeyId(ok({ auth: { session_keys: { only: "x" } } }))).toBe("only");
    expect(signingKeyId(ok({}))).toBeUndefined();
  });

  it("needs a session key to sign with when an IdP is set (X5.9)", () => {
    expect(
      messages({ auth: { oidc: { issuer: "https://acme.okta.com", client_id: "x" } } }),
    ).toEqual(["auth.session_keys: auth.oidc needs a key here to sign session tokens (X5.9)"]);
  });

  it("no longer takes the shared HS256 secret (X5.2)", () => {
    expect(messages({ auth: { legacy_token_secret: "x".repeat(32) } })[0]).toContain(
      "legacy_token_secret",
    );
  });

  it("gives each source's visibility, then default_visibility (X5.10)", () => {
    const config = ok({
      default_visibility: "owner",
      sources: [
        { id: "console", type: "otlp", visibility: "org" },
        { id: "dd", type: "otlp" },
      ],
    });
    expect(visibilityFor(config, "console")).toBe("org");
    expect(visibilityFor(config, "dd")).toBe("owner");
    expect(visibilityFor(config, "upload")).toBe("owner");
  });

  it("wants an https issuer URL", () => {
    expect(messages({ auth: { oidc: { issuer: "acme", client_id: "x" } } })[0]).toContain(
      "auth.oidc.issuer",
    );
  });
});

describe("sources", () => {
  const datadog = {
    id: "datadog-prod",
    type: "datadog",
    api_key: { env: "DD" },
    app_key: { env: "DDA" },
  };

  it("are told apart by type, with their defaults", () => {
    const config = ok({
      sources: [
        { id: "console", type: "otlp", visibility: "owner" },
        datadog,
        { id: "evals", type: "s3", url: "s3://evals/out", include: ["**/*.json"], format: "atif" },
      ],
    });
    expect(config.sources.map((s) => s.type)).toEqual(["otlp", "datadog", "s3"]);
    expect(config.sources[0]).toMatchObject({ quiet_period: 600_000, enabled: true });
    expect(config.sources[1]).toMatchObject({
      site: "datadoghq.com",
      interval: 300_000,
      overlap: 600_000,
      lag: 120_000,
      backfill: 7 * 86_400_000,
      tags: [],
      page_size: 500,
      quiet_period: 600_000,
    });
    expect(config.sources[2]).toMatchObject({ ordered_keys: false, format: "atif" });
  });

  it("take Datadog tags as key:value, a bare site, an http(s) API URL and a page size", () => {
    expect(
      ok({
        sources: [
          { ...datadog, tags: ["env:prod", "team:ai:core"], api_url: "http://127.0.0.1:1" },
        ],
      }).sources[0],
    ).toMatchObject({ tags: ["env:prod", "team:ai:core"], api_url: "http://127.0.0.1:1" });
    expect(messages({ sources: [{ ...datadog, tags: ["prod"] }] })[0]).toContain("key:value");
    expect(messages({ sources: [{ ...datadog, tags: ["env:"] }] })[0]).toContain("key:value");
    expect(messages({ sources: [{ ...datadog, site: "https://app.datadoghq.com" }] })[0]).toContain(
      "sources.0.site",
    );
    expect(messages({ sources: [{ ...datadog, api_url: "ftp://x" }] })[0]).toContain(
      "sources.0.api_url",
    );
    expect(messages({ sources: [{ ...datadog, page_size: 5001 }] })[0]).toContain(
      "sources.0.page_size",
    );
  });

  it("want an id of their own, used once, and never 'upload'", () => {
    expect(messages({ sources: [{ ...datadog }, { ...datadog }] })).toEqual([
      "sources.1.id: id 'datadog-prod' is used twice",
    ]);
    expect(messages({ sources: [{ ...datadog, id: "upload" }] })[0]).toContain(
      "'upload' is the id uploads use",
    );
    expect(messages({ sources: [{ ...datadog, id: "Datadog Prod" }] })[0]).toContain(
      "sources.0.id",
    );
    // Its env form must not hold the `__` that separates env levels.
    for (const id of ["dd--prod", "dd-", "-dd", "x".repeat(64)]) {
      expect(messages({ sources: [{ ...datadog, id }] })[0]).toContain("sources.0.id");
    }
    expect(ok({ sources: [{ ...datadog, id: "dd-prod-2" }] }).sources[0]?.id).toBe("dd-prod-2");
  });

  it("refuse fields of another type", () => {
    expect(messages({ sources: [{ id: "o", type: "otlp", api_key: "x" }] })[0]).toContain(
      'Unrecognized key: "api_key"',
    );
  });

  it("refuse an S3 source that reads seshi's own bucket and prefix (F6.4)", () => {
    const own = (url: string, prefix?: string) =>
      messages({ sources: [{ id: "in", type: "s3", url, ...(prefix ? { prefix } : {}) }] });
    expect(own("s3://seshi/prod")[0]).toContain("reads seshi's own bucket");
    expect(own("s3://seshi/prod/inbox")[0]).toContain("reads seshi's own bucket");
    expect(own("s3://seshi", "prod")[0]).toContain("reads seshi's own bucket");
    expect(own("s3://seshi")[0]).toContain("reads seshi's own bucket");
    expect(
      ok({ sources: [{ id: "in", type: "s3", url: "s3://seshi/staging" }] }).sources,
    ).toHaveLength(1);
    expect(
      ok({ sources: [{ id: "in", type: "s3", url: "s3://seshi/production" }] }).sources,
    ).toHaveLength(1);
    expect(
      ok({ sources: [{ id: "in", type: "s3", url: "r2://seshi/prod" }] }).sources,
    ).toHaveLength(1);
  });
});

describe("filter", () => {
  it("is [filter] with each source's overrides", () => {
    const config = ok({
      filter: { min_chars: 500 },
      sources: [
        { id: "console", type: "otlp", filter: { require_user: false } },
        { id: "plain", type: "otlp" },
      ],
    });
    expect(filterFor(config, "console")).toEqual({
      enabled: true,
      min_chars: 500,
      require_user: false,
      require_reply: true,
    });
    expect(filterFor(config, "plain")).toEqual(config.filter);
    expect(filterFor(config, "upload")).toEqual(config.filter);
  });
});

describe("review", () => {
  const decision = { provider: "anthropic", model: "m", api_key: "sk-test" };

  it("takes policies with both steps", () => {
    const config = ok({
      review: {
        policies: [
          {
            id: "default",
            decision: { ...decision, api_key: { env: "ANTHROPIC_API_KEY" } },
            redactor: {
              provider: "openai-compatible",
              model: "local",
              base_url: "http://localhost:8000/v1",
              categories: [{ name: "pii", description: "personal data" }],
            },
          },
        ],
      },
    });
    expect(config.review.policies[0]).toMatchObject({
      on_failure: "drop",
      retries: 3,
      sources: [],
    });
  });

  it("checks ids, prompts and the sources a policy names", () => {
    expect(
      messages({
        review: {
          policies: [
            { id: "a", decision },
            { id: "a", decision, sources: ["nope", "upload"] },
          ],
        },
      }),
    ).toEqual([
      "review.policies.1.id: id 'a' is used twice",
      "review.policies.1.sources.0: no source with id 'nope' (or 'upload' for uploads)",
    ]);
    expect(
      messages({
        review: {
          policies: [{ id: "a", decision: { ...decision, prompt: "x", prompt_file: "/y" } }],
        },
      }),
    ).toEqual(["review.policies.0.decision: prompt or prompt_file, not both"]);
  });

  it("defaults both steps to Claude Haiku 5.5 on the Anthropic API (F3.5)", () => {
    const config = ok({ review: { policies: [{ id: "p", decision: { api_key: "sk-test" } }] } });
    const policy = config.review.policies[0] as ReviewPolicy;
    expect(policy.max_input_chars).toBe(DEFAULT_MAX_INPUT_CHARS);
    const { decision: d, redactor: r } = resolveSteps(policy);
    expect(d).toMatchObject({
      provider: "anthropic",
      model: DEFAULT_REVIEW_MODEL,
      base_url: "https://api.anthropic.com",
      max_tokens: DEFAULT_DECISION_MAX_TOKENS,
      timeout_ms: DEFAULT_REVIEW_TIMEOUT_MS,
    });
    expect(d.api_key?.reveal()).toBe("sk-test");
    // The redactor inherits the decision step's provider, model, key and endpoint.
    expect(r).toMatchObject({
      provider: "anthropic",
      model: DEFAULT_REVIEW_MODEL,
      base_url: "https://api.anthropic.com",
      max_tokens: DEFAULT_REDACTOR_MAX_TOKENS,
    });
    expect(r.api_key?.reveal()).toBe("sk-test");
  });

  it("does not hand the decision step's key to a redactor on another provider", () => {
    const config = ok({
      review: {
        policies: [
          {
            id: "p",
            decision: { api_key: "sk-test", effort: "low", timeout: "10s" },
            redactor: { provider: "openai-compatible", model: "llama", base_url: "http://gpu/v1" },
          },
        ],
      },
    });
    const { decision: d, redactor: r } = resolveSteps(config.review.policies[0] as ReviewPolicy);
    expect(d).toMatchObject({ effort: "low", timeout_ms: 10_000 });
    expect(r).toMatchObject({
      provider: "openai-compatible",
      model: "llama",
      base_url: "http://gpu/v1",
      api_key: undefined,
      effort: undefined,
      timeout_ms: DEFAULT_REVIEW_TIMEOUT_MS,
    });
  });

  it("does not hand the decision step's key to a redactor with an endpoint of its own", () => {
    // Same provider, another endpoint: the key stays with the decision step.
    expect(
      messages({
        review: {
          policies: [{ id: "p", decision, redactor: { base_url: "https://proxy.example" } }],
        },
      }),
    ).toEqual([
      "review.policies.0.redactor: anthropic needs an api_key (review is off until a provider key is given)",
    ]);
    const config = ok({
      review: {
        policies: [
          {
            id: "p",
            decision: { provider: "openai-compatible", model: "m", api_key: "sk-gw" },
            redactor: { base_url: "http://gpu.internal/v1" },
          },
          // Naming the decision step's own endpoint again is the same endpoint.
          { id: "q", decision, redactor: { base_url: "https://api.anthropic.com" } },
        ],
      },
    });
    const [p, q] = config.review.policies as [ReviewPolicy, ReviewPolicy];
    const local = resolveSteps(p).redactor;
    expect(local).toMatchObject({ provider: "openai-compatible", model: "m" });
    expect(local.base_url).toBe("http://gpu.internal/v1");
    expect(local.api_key).toBeUndefined();
    expect(resolveSteps(q).redactor.api_key?.reveal()).toBe(decision.api_key);
  });

  it("refuses a policy that could not send, or would be refused on every call (F3.5)", () => {
    expect(messages({ review: { policies: [{ id: "p" }] } })).toEqual([
      "review.policies.0.decision: anthropic needs an api_key (review is off until a provider key is given)",
    ]);
    expect(
      messages({
        review: {
          policies: [
            { id: "a", decision: { provider: "openai-compatible", model: "m" } },
            { id: "b", decision: { provider: "openai-compatible", base_url: "http://x/v1" } },
            { id: "c", decision: { provider: "bedrock", model: "m" } },
            {
              id: "d",
              decision: { api_key: "k" },
              redactor: { provider: "openai-compatible", base_url: "http://x/v1", effort: "low" },
            },
          ],
        },
      }),
    ).toEqual([
      "review.policies.0.decision: openai-compatible needs an api_key, or a base_url for a server that takes none",
      "review.policies.1.decision: openai-compatible needs a model",
      "review.policies.2.decision: provider bedrock is not built yet (F3.5): use anthropic, or reach it through an openai-compatible gateway",
      "review.policies.3.redactor: openai-compatible needs a model",
    ]);
    // A local server without a key is fine.
    ok({
      review: {
        policies: [
          {
            id: "p",
            decision: { provider: "openai-compatible", model: "m", base_url: "http://x/v1" },
          },
        ],
      },
    });
  });

  it("checks categories", () => {
    expect(
      messages({
        review: {
          policies: [
            {
              id: "p",
              decision,
              redactor: {
                categories: [
                  { name: "pii", description: "a" },
                  { name: "pii", description: "b" },
                  { name: "Bad Name", description: "c" },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual([
      "review.policies.0.redactor.categories.2.name: lower-case letters and digits, joined by - or _",
      "review.policies.0.redactor.categories.1.name: category 'pii' is named twice",
    ]);
  });
});
