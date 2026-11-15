/** `@seshi/redact`: regex redaction (F2). Rules are TOML rule packs (`pack.ts`): the built-in
 * pack shipped in the repository (`packs/builtin.toml`) and the operator's (`[redaction]
 * packs`), compiled into one `RuleSet` (`ruleset.ts`). Operator patterns run under RE2
 * (`matcher.ts`, F2.2). The same rule set redacts a session's normalized records on the server
 * (`ruleRedactor`, the pipeline's redaction stage) and a native transcript on a client before
 * upload (`redactTranscript`, F2.4). What ran is recorded as the rule set's hash and matches by
 * rule id, never what matched (F2.3).
 *
 * Layer 1: it imports only `@seshi/model` (X3.2), and `re2js`. */

export {
  BUILTIN_PACK_ID,
  BUILTIN_PACK_TOML,
  BUILTIN_RULES_VERSION,
  builtinPack,
} from "./builtin";
export {
  type CompileOptions as PatternCompileOptions,
  compilePattern,
  type Engine,
  MAX_PROGRAM_SIZE,
  type Match,
  PatternError,
  type PatternMatcher,
} from "./matcher";
export {
  APPLIES_TO,
  type AppliesTo,
  type CommandRuleSpec,
  checkLegacyRules,
  type FileRuleSpec,
  LEGACY_PACK_ID,
  LEGACY_RULE_IDS,
  type LegacyRules,
  type LoadedPack,
  legacyPack,
  loadPacks,
  type PackProblem,
  parsePackFile,
  parsePackToml,
  RULE_ID,
  type RulePack,
  RulePackError,
  type RuleTests,
  readLegacyRules,
  type TextRuleSpec,
  type ValidateOptions,
  validatePack,
} from "./pack";
export { redactRaw } from "./raw";
export { redactRecords } from "./records";
export {
  type RecordRedaction,
  type Redactor,
  redactLlmCalls,
  ruleRedactor,
  ruleSetHash,
} from "./redactor";
export {
  applyRules,
  parseRedactionConfig,
  type RedactionConfig,
  RedactionConfigError,
  type RedactionRules,
  redactionRules,
} from "./rules";
export {
  applyTextRule,
  type CompiledCommandRule,
  type CompiledFileRule,
  type CompiledTextRule,
  type CompileOptions,
  type Counts,
  compileRuleSet,
  markerOf,
  REDACTION_RULES_SCHEMA,
  type RedactionRulesDocument,
  type RuleInfo,
  type RuleKind,
  RuleSet,
  RuleSetError,
  type RuleTestResult,
  ruleSetFromDocument,
  rulesDocument,
  runRuleTests,
} from "./ruleset";
export { BUILTIN_SECRET_KINDS, type RedactionResult, redactSecrets } from "./secrets";
export {
  builtinSecretCommands,
  builtinSensitiveFiles,
  type CommandTest,
  type CompiledCommands,
  classifyCall,
  globFiles,
  isSensitivePath,
  namesSensitiveFile,
  redactSensitive,
  runsSecretCommand,
  type SensitiveFiles,
  type SensitiveResult,
  type SensitiveRules,
  secretCommands,
  sensitiveFiles,
  sensitiveRules,
  trimSensitiveInput,
  type WithheldCalls,
  type WithheldKind,
  type WithholdListener,
} from "./sensitive";
export { redactTranscript, type TranscriptRedaction } from "./transcript";

/** The rule id today's custom patterns were counted under, and still are (`legacy` pack). */
export const CUSTOM_PATTERN_KIND = "custom-pattern";
