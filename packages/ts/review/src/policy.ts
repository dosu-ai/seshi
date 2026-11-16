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

export class ReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSetupError";
  }
}

export interface PolicyStep {
  provider: ModelProvider;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}

export interface Policy {
  id: string;
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

export interface PolicyScope {
  source_id: string;
  format: string;
  project?: string;
}

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

export type ProviderFactory = (step: ResolvedStep, role: "decision" | "redactor") => ModelProvider;

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
  providers?: ProviderFactory;
  fetch?: typeof fetch;
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

export async function loadPolicies(
  policies: readonly ReviewPolicy[],
  options: LoadOptions = {},
): Promise<Policy[]> {
  const out: Policy[] = [];
  for (const policy of policies) out.push(await loadPolicy(policy, options));
  return out;
}
