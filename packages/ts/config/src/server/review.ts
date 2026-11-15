/** `[review]`: model review policies (F3). None by default, so review is off and nothing is sent
 * anywhere until an operator writes a policy with a provider key (F3.5).
 *
 * A policy has two steps, the decision model and the redactor LLM (F3.1). Each step names a
 * provider, a model and a prompt; anything it leaves out has a default, so the smallest policy
 * is an id and a key:
 *
 * ```toml
 * [[review.policies]]
 * id = "default"
 * decision.api_key = { env = "ANTHROPIC_API_KEY" }
 * ```
 *
 * which reviews every envelope with Claude Haiku 5.5 on the Anthropic API for both steps, with
 * seshi's default prompts and categories (F3.5). `resolveSteps` applies the defaults: the
 * redactor takes the decision step's provider, model, key and endpoint unless it names another
 * provider. The review package (`@seshi/review`) builds the providers from what it returns. */

import * as z from "zod";
import { type Secret, secret } from "../secret";
import { duration } from "../units";
import { httpUrl } from "./common";

export const PROVIDERS = ["anthropic", "bedrock", "vertex", "openai-compatible"] as const;
export type ReviewProvider = (typeof PROVIDERS)[number];

/** The providers this binary can call. Bedrock and Vertex are named by F3.5 and accepted by
 * the schema's enum, but refused until they are built; an OpenAI-compatible gateway in front
 * of them works today. */
export const BUILT_PROVIDERS: readonly ReviewProvider[] = ["anthropic", "openai-compatible"];

/** The model both steps use when a policy names none: Claude Haiku 5.5 on the Anthropic API
 * (F3.5 names it for the redactor; seshi picks it for the decision model too). */
export const DEFAULT_REVIEW_MODEL = "claude-haiku-5-5";

/** Where each provider is reached when `base_url` is not set. */
export const DEFAULT_BASE_URLS: Readonly<Partial<Record<ReviewProvider, string>>> = {
  anthropic: "https://api.anthropic.com",
  "openai-compatible": "https://api.openai.com/v1",
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** How long one model call may take, when a step does not say. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 60_000;
/** The output cap of a decision call: a one-word label, with room for the model's thinking. */
export const DEFAULT_DECISION_MAX_TOKENS = 4_096;
/** The output cap of a redactor call: a list of findings. */
export const DEFAULT_REDACTOR_MAX_TOKENS = 16_000;
/** How much record text one model call is given before an envelope is split by turn (F3.7). */
export const DEFAULT_MAX_INPUT_CHARS = 100_000;

const modelStep = z.strictObject({
  provider: z
    .enum(PROVIDERS)
    .optional()
    .describe(
      "Who runs the model; review sends envelopes there (F3.5). anthropic by default; the redactor defaults to the decision step's.",
    ),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      `The model name at that provider; ${DEFAULT_REVIEW_MODEL} on anthropic by default, required for other providers.`,
    ),
  prompt: z
    .string()
    .min(1)
    .optional()
    .describe("The prompt, inline; seshi's default prompt when neither is set."),
  prompt_file: z.string().min(1).optional().describe("The prompt, from a file read at start."),
  api_key: secret()
    .optional()
    .describe(
      "The provider key. Required for anthropic, and for openai-compatible without a base_url.",
    ),
  base_url: httpUrl
    .optional()
    .describe(
      "The provider's endpoint: a proxy, an OpenAI-compatible server or a local model. The provider's public API by default.",
    ),
  max_tokens: z
    .int()
    .positive()
    .optional()
    .describe(
      `The output cap of one call; ${DEFAULT_DECISION_MAX_TOKENS} for the decision model, ${DEFAULT_REDACTOR_MAX_TOKENS} for the redactor.`,
    ),
  effort: z
    .enum(EFFORTS)
    .optional()
    .describe(
      "anthropic only: output_config.effort for the model; the model's own default when unset.",
    ),
  timeout: duration()
    .optional()
    .describe("How long one call may take before it counts as failed; 60s by default."),
});

const category = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "lower-case letters and digits, joined by - or _")
    .max(40)
    .describe("The category's name; redacted text becomes [redacted:<name>]."),
  description: z.string().min(1).describe("What belongs in it, for the redactor."),
  examples: z.array(z.string()).default([]).describe("Examples of such text, for the redactor."),
});

const onePrompt = (step: { prompt?: string; prompt_file?: string }) =>
  !(step.prompt !== undefined && step.prompt_file !== undefined);

const policyBase = z.strictObject({
  id: z.string().min(1).describe("The policy's name."),
  sources: z
    .array(z.string().min(1))
    .default([])
    .describe("Source ids it applies to; all when empty."),
  agents: z
    .array(z.string().min(1))
    .default([])
    .describe("Agents (formats) it applies to; all when empty."),
  repos: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Repositories (the session's project) it applies to, as globs; all when empty. A session without a project matches only a policy with no repos.",
    ),
  on_failure: z
    .enum(["drop", "skip"])
    .default("drop")
    .describe(
      "After the last retry: drop the envelope, or store it with regex redaction only (F3.4).",
    ),
  retries: z
    .int()
    .nonnegative()
    .max(10)
    .default(3)
    .describe("Retries of a failed model call, or of an answer that does not fit (F3.4)."),
  max_input_chars: z
    .int()
    .min(1_000)
    .default(DEFAULT_MAX_INPUT_CHARS)
    .describe("Record text per model call; a longer envelope is split by turn (F3.7)."),
  decision: modelStep
    .refine(onePrompt, "prompt or prompt_file, not both")
    .prefault({})
    .describe("The decision model: allow, redact or drop (F3.1)."),
  redactor: modelStep
    .extend({
      categories: z
        .array(category)
        .default([])
        .describe("What the redactor looks for; seshi's default categories when empty."),
    })
    .refine(onePrompt, "prompt or prompt_file, not both")
    .prefault({})
    .describe("The redactor LLM, called only for redact (F3.1)."),
});

export type ReviewPolicy = z.output<typeof policyBase>;
export type ReviewStepConfig = ReviewPolicy["decision"];
export type ReviewCategory = ReviewPolicy["redactor"]["categories"][number];

/** One step with every default applied. */
export interface ResolvedStep {
  provider: ReviewProvider;
  model: string;
  base_url: string | undefined;
  api_key: Secret | undefined;
  prompt: string | undefined;
  prompt_file: string | undefined;
  max_tokens: number;
  effort: (typeof EFFORTS)[number] | undefined;
  timeout_ms: number;
}

/** A policy's two steps with every default applied: the redactor takes the decision step's
 * provider, and with it the model, key and endpoint, unless it names a provider of its own. */
export function resolveSteps(policy: ReviewPolicy): {
  decision: ResolvedStep;
  redactor: ResolvedStep;
} {
  const d = policy.decision;
  const decisionProvider = d.provider ?? "anthropic";
  const decision: ResolvedStep = {
    provider: decisionProvider,
    model: d.model ?? DEFAULT_REVIEW_MODEL,
    base_url: d.base_url ?? DEFAULT_BASE_URLS[decisionProvider],
    api_key: d.api_key,
    prompt: d.prompt,
    prompt_file: d.prompt_file,
    max_tokens: d.max_tokens ?? DEFAULT_DECISION_MAX_TOKENS,
    effort: d.effort,
    timeout_ms: d.timeout ?? DEFAULT_REVIEW_TIMEOUT_MS,
  };
  const r = policy.redactor;
  const inherits = r.provider === undefined || r.provider === decisionProvider;
  const redactorProvider = r.provider ?? decisionProvider;
  const redactor: ResolvedStep = {
    provider: redactorProvider,
    model: r.model ?? (inherits ? decision.model : DEFAULT_REVIEW_MODEL),
    base_url: r.base_url ?? (inherits ? decision.base_url : DEFAULT_BASE_URLS[redactorProvider]),
    api_key: r.api_key ?? (inherits ? decision.api_key : undefined),
    prompt: r.prompt,
    prompt_file: r.prompt_file,
    max_tokens: r.max_tokens ?? DEFAULT_REDACTOR_MAX_TOKENS,
    effort: r.effort ?? (inherits ? decision.effort : undefined),
    timeout_ms: r.timeout ?? (inherits ? decision.timeout_ms : DEFAULT_REVIEW_TIMEOUT_MS),
  };
  return { decision, redactor };
}

/** Why a step cannot be used as resolved, or undefined. Review is off until an operator gives
 * a provider key (F3.5): a policy that would send nothing, or would be refused on every call,
 * stops start-up rather than drop every envelope. */
function stepProblem(step: ResolvedStep, own: ReviewStepConfig): string | undefined {
  if (!BUILT_PROVIDERS.includes(step.provider)) {
    return `provider ${step.provider} is not built yet (F3.5): use anthropic, or reach it through an openai-compatible gateway`;
  }
  if (
    step.provider !== "anthropic" &&
    own.model === undefined &&
    step.model === DEFAULT_REVIEW_MODEL
  ) {
    return `${step.provider} needs a model`;
  }
  if (step.provider === "anthropic" && step.api_key === undefined) {
    return "anthropic needs an api_key (review is off until a provider key is given)";
  }
  if (
    step.provider === "openai-compatible" &&
    step.api_key === undefined &&
    step.base_url === DEFAULT_BASE_URLS["openai-compatible"]
  ) {
    return "openai-compatible needs an api_key, or a base_url for a server that takes none";
  }
  if (step.effort !== undefined && step.provider !== "anthropic") {
    return "effort applies to anthropic only";
  }
  return undefined;
}

export const reviewPolicy = policyBase
  .superRefine((policy, ctx) => {
    const steps = resolveSteps(policy);
    const decision = stepProblem(steps.decision, policy.decision);
    if (decision) ctx.addIssue({ code: "custom", path: ["decision"], message: decision });
    const redactor = stepProblem(steps.redactor, policy.redactor);
    // A redactor that inherits the decision step's problem is not reported twice.
    if (redactor && redactor !== decision) {
      ctx.addIssue({ code: "custom", path: ["redactor"], message: redactor });
    }
    const names = new Set<string>();
    policy.redactor.categories.forEach((c, i) => {
      if (names.has(c.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["redactor", "categories", i, "name"],
          message: `category '${c.name}' is named twice`,
        });
      }
      names.add(c.name);
    });
  })
  .describe("A review policy (F3.3). The first policy that matches an envelope reviews it.");

export const reviewSection = z
  .strictObject({
    policies: z
      .array(reviewPolicy)
      .default([])
      .describe("Review policies, first match wins; none means no model review."),
  })
  .prefault({})
  .describe("Model review (F3).");

export type ReviewSection = z.output<typeof reviewSection>;
