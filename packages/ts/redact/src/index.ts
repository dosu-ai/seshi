/** `@seshi/redact`: the rule engine (built-in secret patterns, sensitive files, secret
 * commands, the operator's own rules) over trajectory-v1 records (`ruleRedactor`, the
 * pipeline's redaction stage) and over raw transcripts (for redacting on a client before
 * upload; the server stores no raw, X6.3).
 * Layer 1: it imports only `@seshi/model` (X3.2). Branch 07 moves operator rules to TOML packs
 * (F2). */

export {
  type CompiledPatterns,
  CUSTOM_PATTERN_KIND,
  compilePatterns,
  redactPatterns,
  redactTranscriptPatterns,
} from "./patterns";
export { redactRaw } from "./raw";
export { redactRecords } from "./records";
export {
  BUILTIN_RULES_VERSION,
  type RecordRedaction,
  type Redactor,
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
export { type RedactionResult, redactSecrets } from "./secrets";
export {
  BUILTIN_SECRET_COMMANDS,
  BUILTIN_SENSITIVE_FILES,
  type CompiledCommands,
  classifyCall,
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
} from "./sensitive";
