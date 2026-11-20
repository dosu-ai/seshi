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

export const CUSTOM_PATTERN_KIND = "custom-pattern";
export {
  redactToolCallRecords,
  TOOL_CALL_COUNT,
  TOOL_CALL_MARKER,
  withToolCallsRedacted,
} from "./tool-calls";
