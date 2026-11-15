/** Review policies as the reviewer runs them (F3.3): `[[review.policies]]` with the defaults
 * applied (`resolveSteps`), prompt files read, a provider per step, and the policy's hash.
 *
 * The hash covers everything that changes what is judged or how: scope, retries and failure
 * mode, each step's provider, model, endpoint, prompt text, output cap, effort and timeout, the
 * redactor's categories, and seshi's prompt wrapping (`WRAPPER_VERSION`). Never the keys. Every
 * review record and drop record carries it, so a policy change is visible in the audit trail
 * and in evals (F3.8). */

import { createHash } from "node:crypto";
import {
  type ResolvedStep,
  type ReviewCategory,
  type ReviewPolicy,
  type ReviewProvider,
  resolveSteps,
} from "@seshi/config";
import { canonicalJson } from "@seshi/model";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai";
import {
  DEFAULT_CATEGORIES,
  DEFAULT_DECISION_PROMPT,
  DEFAULT_REDACTOR_PROMPT,
  WRAPPER_VERSION,
} from "./prompts";
import type { ModelProvider } from "./provider";

/** A policy that cannot be run as configured (a prompt file that cannot be read, a provider
 * this binary lacks). The message is for the operator. */
export class ReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSetupError";
  }
}

export interface PolicyStep {
  provider: ModelProvider;
  /** The operator's prompt (or the default), before seshi's wrapping. */
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface Policy {
  id: string;
  /** sha256 (hex) of the policy as run; see above. */
  hash: string;
  sources: readonly string[];
  agents: readonly string[];
  repos: readonly string[];
  onFailure: "drop" | "skip";
  retries: number;
  maxInputChars: number;
  decision: PolicyStep;
  redactor: PolicyStep & { categories: readonly ReviewCategory[] };
}

/** What a policy is matched against. */
export interface PolicyScope {
  source_id: string;
  /** The envelope's format (the agent). */
  format: string;
  /** The session's project (repository), when known. */
  project?: string;
}

/** Whether `policy` applies: every scope list it sets names the envelope (empty is all).
 * `repos` are globs; a session without a project matches only a policy with no repos. */
export function matches(policy: Policy, scope: PolicyScope): boolean {
  if (policy.sources.length > 0 && !policy.sources.includes(scope.source_id)) return false;
  if (policy.agents.length > 0 && !policy.agents.includes(scope.format)) return false;
  if (policy.repos.length > 0) {
    const project = scope.project;
    if (!project) return false;
    if (!policy.repos.some((pattern) => new Bun.Glob(pattern).match(project))) return false;
  }
  return true;
}

/** Builds the provider a step names. Tests pass their own. */
export type ProviderFactory = (step: ResolvedStep, role: "decision" | "redactor") => ModelProvider;

/** The real providers, reaching their endpoints through `fetch`. */
export function providerFactory(fetcher?: typeof fetch): ProviderFactory {
  return (step) => {
    const provider: ReviewProvider = step.provider;
    const base = step.base_url;
    if (provider === "anthropic" && base) {
      const apiKey = step.api_key?.reveal();
      if (!apiKey) throw new ReviewSetupError("anthropic needs an api_key");
      return new AnthropicProvider({
        model: step.model,
        apiKey,
        baseUrl: base,
        ...(step.effort ? { effort: step.effort } : {}),
        ...(fetcher ? { fetch: fetcher } : {}),
      });
    }
    if (provider === "openai-compatible" && base) {
      const apiKey = step.api_key?.reveal();
      return new OpenAiCompatibleProvider({
        model: step.model,
        baseUrl: base,
        ...(apiKey ? { apiKey } : {}),
        ...(fetcher ? { fetch: fetcher } : {}),
      });
    }
    throw new ReviewSetupError(`provider ${provider} is not built yet`);
  };
}

export interface LoadOptions {
  /** Builds each step's provider; the real ones over `fetch` by default. */
  providers?: ProviderFactory;
  fetch?: typeof fetch;
  /** Reads a `prompt_file`; `Bun.file(path).text()` by default. */
  readFile?: (path: string) => Promise<string>;
}

async function promptOf(
  policy: string,
  role: string,
  step: ResolvedStep,
  fallback: string,
  readFile: (path: string) => Promise<string>,
): Promise<string> {
  if (step.prompt !== undefined) return step.prompt;
  if (step.prompt_file === undefined) return fallback;
  let text: string;
  try {
    text = await readFile(step.prompt_file);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new ReviewSetupError(
      `review policy '${policy}' ${role}: cannot read prompt_file ${step.prompt_file}: ${why}`,
    );
  }
  if (text.trim() === "") {
    throw new ReviewSetupError(
      `review policy '${policy}' ${role}: prompt_file ${step.prompt_file} is empty`,
    );
  }
  return text;
}

function stepIdentity(step: ResolvedStep, prompt: string) {
  return {
    provider: step.provider,
    model: step.model,
    base_url: step.base_url,
    prompt,
    max_tokens: step.max_tokens,
    effort: step.effort,
    timeout_ms: step.timeout_ms,
  };
}

/** The hash of a policy as run (see above). */
export function policyHash(
  policy: ReviewPolicy,
  steps: { decision: ResolvedStep; redactor: ResolvedStep },
  prompts: { decision: string; redactor: string },
  categories: readonly ReviewCategory[],
): string {
  const identity = {
    wrapper: WRAPPER_VERSION,
    id: policy.id,
    sources: policy.sources,
    agents: policy.agents,
    repos: policy.repos,
    on_failure: policy.on_failure,
    retries: policy.retries,
    max_input_chars: policy.max_input_chars,
    decision: stepIdentity(steps.decision, prompts.decision),
    redactor: { ...stepIdentity(steps.redactor, prompts.redactor), categories },
  };
  return createHash("sha256").update(canonicalJson(identity)).digest("hex");
}

/** One configured policy, ready to run. */
export async function loadPolicy(policy: ReviewPolicy, options: LoadOptions = {}): Promise<Policy> {
  const steps = resolveSteps(policy);
  const readFile = options.readFile ?? ((path: string) => Bun.file(path).text());
  const providers = options.providers ?? providerFactory(options.fetch);
  const prompts = {
    decision: await promptOf(
      policy.id,
      "decision",
      steps.decision,
      DEFAULT_DECISION_PROMPT,
      readFile,
    ),
    redactor: await promptOf(
      policy.id,
      "redactor",
      steps.redactor,
      DEFAULT_REDACTOR_PROMPT,
      readFile,
    ),
  };
  const categories =
    policy.redactor.categories.length > 0 ? policy.redactor.categories : DEFAULT_CATEGORIES;
  const build = (role: "decision" | "redactor") => {
    try {
      return providers(steps[role], role);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new ReviewSetupError(`review policy '${policy.id}' ${role}: ${why}`);
    }
  };
  return {
    id: policy.id,
    hash: policyHash(policy, steps, prompts, categories),
    sources: policy.sources,
    agents: policy.agents,
    repos: policy.repos,
    onFailure: policy.on_failure,
    retries: policy.retries,
    maxInputChars: policy.max_input_chars,
    decision: {
      provider: build("decision"),
      prompt: prompts.decision,
      maxTokens: steps.decision.max_tokens,
      timeoutMs: steps.decision.timeout_ms,
    },
    redactor: {
      provider: build("redactor"),
      prompt: prompts.redactor,
      maxTokens: steps.redactor.max_tokens,
      timeoutMs: steps.redactor.timeout_ms,
      categories,
    },
  };
}

/** Every configured policy, in order (the first that matches an envelope reviews it). */
export async function loadPolicies(
  policies: readonly ReviewPolicy[],
  options: LoadOptions = {},
): Promise<Policy[]> {
  const out: Policy[] = [];
  for (const policy of policies) out.push(await loadPolicy(policy, options));
  return out;
}
