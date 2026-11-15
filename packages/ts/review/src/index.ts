/** `@seshi/review`: model review (F3). A decision model labels each envelope allow, redact or
 * drop; for redact, a redactor LLM finds the text to remove and deterministic code removes it.
 * `ModelReviewer` is the pipeline's review stage (`Reviewer` from `@seshi/pipeline`), built from
 * `[review]` by `reviewerFromConfig`. Providers: the Anthropic Messages API and any
 * OpenAI-compatible endpoint. */

export { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic";
export {
  type Applied,
  applyFindings,
  checkFindings,
  checkLabel,
  type Label,
  MIN_FINDING_CHARS,
  marker,
  type RawFinding,
  removeSpans,
} from "./apply";
export { type ReviewerOptions, reviewerFromConfig } from "./build";
export {
  BUILTIN_FIXTURES,
  type EvalReport,
  evaluate,
  type Fixture,
  FixtureError,
  type FixtureResult,
  parseFixtures,
} from "./eval";
export { type OpenAiCompatibleOptions, OpenAiCompatibleProvider } from "./openai";
export {
  type LoadOptions,
  loadPolicies,
  loadPolicy,
  matches,
  type Policy,
  type PolicyScope,
  type PolicyStep,
  type ProviderFactory,
  policyHash,
  providerFactory,
  ReviewSetupError,
} from "./policy";
export {
  DECISION_SCHEMA,
  DEFAULT_CATEGORIES,
  DEFAULT_DECISION_PROMPT,
  DEFAULT_REDACTOR_PROMPT,
  decisionSystem,
  FINDINGS_SCHEMA,
  recordsMessage,
  redactorSystem,
  WRAPPER_VERSION,
} from "./prompts";
export {
  type CompletionRequest,
  type ModelProvider,
  ProviderError,
  parseAnswer,
  retryableStatus,
} from "./provider";
export { type Entry, entriesOf, fieldText, partsOf } from "./render";
export {
  ModelReviewer,
  type ModelReviewerOptions,
  modelName,
  type ReviewLogger,
} from "./reviewer";
