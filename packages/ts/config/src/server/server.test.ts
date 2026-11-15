import { describe, expect, it } from "vitest";
import { Secret } from "../secret";
import {
  filterFor,
  parseListen,
  type ServerConfig,
  serverConfigSchema,
  signingKeyId,
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
  it("takes s3, r2 and file URLs", () => {
    for (const url of ["s3://b", "s3://b/p/q", "r2://b/p", "file:///data", "/data"]) {
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
    expect(config.store.credentials?.secret_access_key.ref).toEqual({
      kind: "file",
      path: "/run/k",
    });
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
    });
    expect(config.sources[2]).toMatchObject({ ordered_keys: false, format: "atif" });
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
  const decision = { provider: "anthropic", model: "m" };

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
});
