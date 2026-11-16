import { type ReviewPolicy, reviewSection } from "@seshi/config";
import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "./anthropic";
import { reviewerFromConfig } from "./build";
import { OpenAiCompatibleProvider } from "./openai";
import { loadPolicy, matches, policyHash, providerFactory, ReviewSetupError } from "./policy";
import { DEFAULT_CATEGORIES, DEFAULT_DECISION_PROMPT, DEFAULT_REDACTOR_PROMPT } from "./prompts";
import { FakeProvider } from "./testing";

const parse = (policies: unknown[]): ReviewPolicy[] => reviewSection.parse({ policies }).policies;
const one = (policy: Record<string, unknown>) =>
  parse([{ id: "p", decision: { api_key: "sk-test" }, ...policy }])[0] as ReviewPolicy;
const fakes = () => new FakeProvider();

describe("loadPolicy", () => {
  it("uses seshi's default prompts and categories and the real providers (F3.5)", async () => {
    const policy = await loadPolicy(one({}));
    expect(policy.decision.prompt).toBe(DEFAULT_DECISION_PROMPT);
    expect(policy.redactor.prompt).toBe(DEFAULT_REDACTOR_PROMPT);
    expect(policy.redactor.categories).toEqual(DEFAULT_CATEGORIES);
    expect(policy.decision.provider).toBeInstanceOf(AnthropicProvider);
    expect(policy.decision.provider).toMatchObject({
      model: "claude-haiku-5-5",
      endpoint: "https://api.anthropic.com",
    });
    expect(policy).toMatchObject({ onFailure: "drop", retries: 3, maxInputChars: 100_000 });
    expect(policy.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads prompt files, and builds an OpenAI-compatible redactor", async () => {
    const read: string[] = [];
    const policy = await loadPolicy(
      one({
        decision: { api_key: "sk-test", prompt_file: "/etc/seshi/decision.md" },
        redactor: {
          provider: "openai-compatible",
          model: "local",
          base_url: "http://gpu:8000/v1",
          prompt: "find secrets",
          categories: [{ name: "pii", description: "personal data" }],
        },
      }),
      {
        readFile: async (path) => {
          read.push(path);
          return "our own decision prompt";
        },
      },
    );
    expect(read).toEqual(["/etc/seshi/decision.md"]);
    expect(policy.decision.prompt).toBe("our own decision prompt");
    expect(policy.redactor.prompt).toBe("find secrets");
    expect(policy.redactor.provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(policy.redactor.categories.map((c) => c.name)).toEqual(["pii"]);
  });

  it("refuses a prompt file it cannot read, or an empty one", async () => {
    const policy = one({ decision: { api_key: "k", prompt_file: "/nope" } });
    await expect(
      loadPolicy(policy, {
        readFile: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow(
      new ReviewSetupError("review policy 'p' decision: cannot read prompt_file /nope: ENOENT"),
    );
    await expect(loadPolicy(policy, { readFile: async () => "  \n" })).rejects.toThrow(
      "prompt_file /nope is empty",
    );
  });

  it("hashes what changes what is judged, never the key", async () => {
    const hash = async (policy: Record<string, unknown>) =>
      (await loadPolicy(one(policy), { providers: fakes })).hash;
    const base = await hash({});
    expect(await hash({})).toBe(base);
    expect(await hash({ decision: { api_key: "another-key" } })).toBe(base);
    for (const change of [
      { decision: { api_key: "k", prompt: "be strict" } },
      { decision: { api_key: "k", model: "claude-sonnet-5-5" } },
      { decision: { api_key: "k", effort: "low" } },
      { redactor: { categories: [{ name: "pii", description: "x" }] } },
      { on_failure: "skip" },
      { retries: 1 },
      { sources: ["upload"] },
      { max_input_chars: 5_000 },
    ]) {
      expect(await hash(change)).not.toBe(base);
    }
  });

  it("names the policy and step when a provider cannot be built", async () => {
    await expect(
      loadPolicy(one({}), {
        providers: () => {
          throw new Error("no such provider");
        },
      }),
    ).rejects.toThrow("review policy 'p' decision: no such provider");
  });
});

describe("providerFactory", () => {
  it("refuses a provider it does not have", () => {
    const factory = providerFactory();
    expect(() =>
      factory(
        {
          provider: "vertex",
          model: "m",
          base_url: undefined,
          api_key: undefined,
          prompt: undefined,
          prompt_file: undefined,
          max_tokens: 1,
          effort: undefined,
          timeout_ms: 1,
        },
        "decision",
        "p",
      ),
    ).toThrow(ReviewSetupError);
  });
});

describe("matches", () => {
  it("matches every scope list it sets; repos are globs", async () => {
    const policy = await loadPolicy(
      one({ sources: ["upload"], agents: ["claude-code", "codex"], repos: ["acme/*", "tools"] }),
      { providers: fakes },
    );
    const scope = { source_id: "upload", format: "codex", project: "acme/api" };
    expect(matches(policy, scope)).toBe(true);
    expect(matches(policy, { ...scope, project: "tools" })).toBe(true);
    expect(matches(policy, { ...scope, project: "acme" })).toBe(false);
    expect(matches(policy, { source_id: "upload", format: "codex" })).toBe(false);
    expect(matches(policy, { ...scope, format: "cursor" })).toBe(false);
    expect(matches(policy, { ...scope, source_id: "s3-logs" })).toBe(false);
  });
});

describe("policyHash", () => {
  it("is stable across key order", () => {
    const policy = one({});
    const steps = {
      decision: { provider: "anthropic", model: "m" },
      redactor: { model: "m", provider: "anthropic" },
    } as never;
    expect(policyHash(policy, steps, { decision: "a", redactor: "b" }, [])).toBe(
      policyHash(policy, steps, { redactor: "b", decision: "a" }, []),
    );
  });
});

describe("reviewerFromConfig", () => {
  it("is off without policies (F3.5)", async () => {
    expect(await reviewerFromConfig({ review: { policies: [] } })).toBeUndefined();
  });

  it("builds a reviewer over every policy, in order", async () => {
    const reviewer = await reviewerFromConfig(
      {
        review: {
          policies: parse([
            { id: "a", decision: { api_key: "k" }, sources: ["upload"] },
            { id: "b", decision: { api_key: "k" } },
          ]),
        },
      },
      { providers: fakes },
    );
    expect(reviewer?.policies.map((p) => p.id)).toEqual(["a", "b"]);
  });
});
