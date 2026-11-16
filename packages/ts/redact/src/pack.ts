export type AppliesTo = "text" | "tool_input" | "tool_output";

export const APPLIES_TO: readonly AppliesTo[] = ["text", "tool_input", "tool_output"];

export interface RuleTests {
  match: string[];
  no_match: string[];
}

export interface TextRuleSpec {
  id: string;
  description?: string;
  patterns: string[];
  implementation?: "builtin";
  replacement?: string;
  applies_to: AppliesTo[];
  tests?: RuleTests;
}

export interface FileRuleSpec {
  id: string;
  description?: string;
  globs: string[];
  tests?: RuleTests;
}

export interface CommandRuleSpec {
  id: string;
  description?: string;
  patterns: string[];
  tests?: RuleTests;
}

export interface RulePack {
  id: string;
  version?: string;
  description?: string;
  disable: string[];
  rules: TextRuleSpec[];
  sensitive_files: FileRuleSpec[];
  secret_commands: CommandRuleSpec[];
}

export interface PackProblem {
  where: string;
  message: string;
}

export class RulePackError extends Error {
  constructor(readonly problems: readonly PackProblem[]) {
    super(
      problems.length === 1
        ? `${problems[0]?.where}: ${problems[0]?.message}`
        : `rule pack problems:\n${problems.map((p) => `  ${p.where}: ${p.message}`).join("\n")}`,
    );
    this.name = "RulePackError";
  }
}

export const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_PATTERN = 4096;
const MAX_REPLACEMENT = 256;
const MAX_TEXT = 1024;
const MAX_RULES = 1000;
const MAX_TESTS = 100;

export interface ValidateOptions {
  source: string;
  builtin?: boolean;
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

class Reader {
  readonly problems: PackProblem[] = [];
  constructor(readonly source: string) {}

  problem(field: string, message: string): void {
    this.problems.push({ where: field ? `${this.source}: ${field}` : this.source, message });
  }

  unknown(value: Obj, known: readonly string[], field: string): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.problem(field ? `${field}.${key}` : key, "is not a known field");
      }
    }
  }

  string(value: Obj, key: string, field: string, max: number, required: boolean) {
    const v = value[key];
    const at = field ? `${field}.${key}` : key;
    if (v === undefined) {
      if (required) this.problem(at, "is required");
      return undefined;
    }
    if (typeof v !== "string") {
      this.problem(at, "must be a string");
      return undefined;
    }
    if (v.length > max) {
      this.problem(at, `must be at most ${max} characters`);
      return undefined;
    }
    return v;
  }

  id(value: Obj, key: string, field: string): string | undefined {
    const v = this.string(value, key, field, MAX_ID, true);
    if (v === undefined) return undefined;
    if (!RULE_ID.test(v)) {
      this.problem(
        field ? `${field}.${key}` : key,
        `'${v}' is not an id: lowercase letters and digits, words joined by single '-'`,
      );
      return undefined;
    }
    return v;
  }

  strings(value: unknown, at: string, max: number, limit: number): string[] | undefined {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      this.problem(at, "must be a list of strings");
      return undefined;
    }
    if (value.length > limit) {
      this.problem(at, `must have at most ${limit} entries`);
      return undefined;
    }
    const long = (value as string[]).find((v) => v.length > max);
    if (long !== undefined) {
      this.problem(at, `entries must be at most ${max} characters`);
      return undefined;
    }
    return value as string[];
  }

  patterns(value: Obj, field: string): string[] | undefined {
    const one = value.pattern;
    const many = value.patterns;
    if (one !== undefined && many !== undefined) {
      this.problem(field, "has both pattern and patterns; use one");
      return undefined;
    }
    if (one === undefined && many === undefined) {
      this.problem(`${field}.pattern`, "is required");
      return undefined;
    }
    if (one !== undefined && typeof one !== "string") {
      this.problem(`${field}.pattern`, "must be a string");
      return undefined;
    }
    const list =
      one !== undefined ? [one] : this.strings(many, `${field}.patterns`, MAX_PATTERN, MAX_RULES);
    if (list === undefined) return undefined;
    if (list.length === 0) {
      this.problem(`${field}.patterns`, "must not be empty");
      return undefined;
    }
    if (list.some((p) => p.trim() === "")) {
      this.problem(`${field}.${one !== undefined ? "pattern" : "patterns"}`, "must not be blank");
      return undefined;
    }
    if (list.some((p) => p.length > MAX_PATTERN)) {
      this.problem(`${field}.pattern`, `must be at most ${MAX_PATTERN} characters`);
      return undefined;
    }
    return list;
  }

  tests(value: Obj, field: string): RuleTests | undefined {
    const v = value.tests;
    if (v === undefined) return undefined;
    const at = `${field}.tests`;
    if (!isObject(v)) {
      this.problem(at, "must be a table with match and no_match");
      return undefined;
    }
    this.unknown(v, ["match", "no_match"], at);
    const match =
      v.match === undefined ? [] : this.strings(v.match, `${at}.match`, MAX_TEXT * 8, MAX_TESTS);
    const noMatch =
      v.no_match === undefined
        ? []
        : this.strings(v.no_match, `${at}.no_match`, MAX_TEXT * 8, MAX_TESTS);
    if (match === undefined || noMatch === undefined) return undefined;
    if (match.length === 0 && noMatch.length === 0) return undefined;
    return { match, no_match: noMatch };
  }

  tables(value: unknown, at: string): Obj[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.problem(at, `must be a list of tables ([[${at}]] in TOML)`);
      return [];
    }
    if (value.length > MAX_RULES) {
      this.problem(at, `must have at most ${MAX_RULES} entries`);
      return [];
    }
    return value.filter((entry, i) => {
      if (isObject(entry)) return true;
      this.problem(`${at}[${i}]`, "must be a table");
      return false;
    });
  }
}

function textRule(r: Reader, value: Obj, field: string, builtin: boolean): TextRuleSpec | null {
  r.unknown(
    value,
    [
      "id",
      "description",
      "pattern",
      "patterns",
      "replacement",
      "applies_to",
      "tests",
      ...(builtin ? ["implementation"] : []),
    ],
    field,
  );
  const id = r.id(value, "id", field);
  const description = r.string(value, "description", field, MAX_TEXT, false);
  let patterns: string[] | undefined = [];
  let implementation: "builtin" | undefined;
  if (builtin && value.implementation !== undefined) {
    if (value.implementation !== "builtin") {
      r.problem(`${field}.implementation`, 'must be "builtin"');
    } else if (value.pattern !== undefined || value.patterns !== undefined) {
      r.problem(field, "a rule implemented in code has no pattern");
    } else {
      implementation = "builtin";
    }
  } else {
    patterns = r.patterns(value, field);
  }
  const replacement = r.string(value, "replacement", field, MAX_REPLACEMENT, false);
  if (replacement !== undefined && /[\r\n]/.test(replacement)) {
    r.problem(`${field}.replacement`, "must be one line");
  }
  if (implementation && replacement !== undefined) {
    r.problem(`${field}.replacement`, "a rule implemented in code keeps its own replacement");
  }
  let appliesTo: AppliesTo[] = [...APPLIES_TO];
  if (value.applies_to !== undefined) {
    const list = r.strings(value.applies_to, `${field}.applies_to`, 32, 3);
    if (list !== undefined) {
      const bad = list.filter((v) => !(APPLIES_TO as readonly string[]).includes(v));
      if (bad.length > 0) {
        r.problem(`${field}.applies_to`, `'${bad[0]}' is not one of ${APPLIES_TO.join(", ")}`);
      } else if (list.length === 0) {
        r.problem(`${field}.applies_to`, "must name at least one of text, tool_input, tool_output");
      } else if (new Set(list).size !== list.length) {
        r.problem(`${field}.applies_to`, "names a place twice");
      } else {
        appliesTo = APPLIES_TO.filter((a) => list.includes(a));
      }
    }
  }
  const tests = r.tests(value, field);
  if (id === undefined || patterns === undefined) return null;
  return {
    id,
    ...(description !== undefined ? { description } : {}),
    patterns,
    ...(implementation ? { implementation } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
    applies_to: appliesTo,
    ...(tests ? { tests } : {}),
  };
}

function fileRule(r: Reader, value: Obj, field: string): FileRuleSpec | null {
  r.unknown(value, ["id", "description", "globs", "tests"], field);
  const id = r.id(value, "id", field);
  const description = r.string(value, "description", field, MAX_TEXT, false);
  let globs: string[] | undefined;
  if (value.globs === undefined) {
    r.problem(`${field}.globs`, "is required");
  } else {
    globs = r.strings(value.globs, `${field}.globs`, MAX_PATTERN, MAX_RULES);
    if (globs !== undefined) {
      globs = globs.map((g) => g.trim()).filter((g) => g !== "" && !g.startsWith("#"));
      if (globs.length === 0) {
        r.problem(`${field}.globs`, "must name at least one glob");
        globs = undefined;
      } else if (globs.some((g) => g === "!" || g.replace(/^!/, "").replace(/^\/+/, "") === "")) {
        r.problem(`${field}.globs`, "has an empty glob");
        globs = undefined;
      } else if (globs.some((g) => /[\r\n]/.test(g))) {
        r.problem(`${field}.globs`, "globs must be one line each");
        globs = undefined;
      }
    }
  }
  const tests = r.tests(value, field);
  if (id === undefined || globs === undefined) return null;
  return {
    id,
    ...(description !== undefined ? { description } : {}),
    globs,
    ...(tests ? { tests } : {}),
  };
}

function commandRule(r: Reader, value: Obj, field: string): CommandRuleSpec | null {
  r.unknown(value, ["id", "description", "pattern", "patterns", "tests"], field);
  const id = r.id(value, "id", field);
  const description = r.string(value, "description", field, MAX_TEXT, false);
  const patterns = r.patterns(value, field);
  const tests = r.tests(value, field);
  if (id === undefined || patterns === undefined) return null;
  return {
    id,
    ...(description !== undefined ? { description } : {}),
    patterns,
    ...(tests ? { tests } : {}),
  };
}

export function validatePack(value: unknown, options: ValidateOptions): RulePack {
  const r = new Reader(options.source);
  const builtin = options.builtin === true;
  if (!isObject(value)) {
    throw new RulePackError([{ where: options.source, message: "a pack must be a table" }]);
  }
  r.unknown(
    value,
    ["id", "version", "description", "disable", "rules", "sensitive_files", "secret_commands"],
    "",
  );
  const id = r.id(value, "id", "");
  const version = r.string(value, "version", "", MAX_ID * 2, false);
  const description = r.string(value, "description", "", MAX_TEXT, false);
  let disable: string[] = [];
  if (value.disable !== undefined) {
    const list = r.strings(value.disable, "disable", MAX_ID, MAX_RULES);
    if (list !== undefined) {
      const bad = list.find((d) => !RULE_ID.test(d));
      if (bad !== undefined) r.problem("disable", `'${bad}' is not a rule id`);
      else if (builtin && list.length > 0)
        r.problem("disable", "the built-in pack turns nothing off");
      else disable = [...new Set(list)];
    }
  }
  const rules = r
    .tables(value.rules, "rules")
    .map((t, i) => textRule(r, t, `rules[${i}]`, builtin));
  const files = r
    .tables(value.sensitive_files, "sensitive_files")
    .map((t, i) => fileRule(r, t, `sensitive_files[${i}]`));
  const commands = r
    .tables(value.secret_commands, "secret_commands")
    .map((t, i) => commandRule(r, t, `secret_commands[${i}]`));

  const seen = new Map<string, string>();
  const all: [string, { id: string } | null][] = [
    ...rules.map((x, i) => [`rules[${i}]`, x] as [string, { id: string } | null]),
    ...files.map((x, i) => [`sensitive_files[${i}]`, x] as [string, { id: string } | null]),
    ...commands.map((x, i) => [`secret_commands[${i}]`, x] as [string, { id: string } | null]),
  ];
  for (const [field, rule] of all) {
    if (!rule) continue;
    const first = seen.get(rule.id);
    if (first !== undefined) r.problem(`${field}.id`, `'${rule.id}' is also ${first}'s id`);
    else seen.set(rule.id, field);
  }
  for (const d of disable) {
    if (seen.has(d)) {
      r.problem("disable", `'${d}' is this pack's own rule; remove it instead of turning it off`);
    }
  }
  if (r.problems.length > 0 || id === undefined) {
    if (r.problems.length === 0) r.problem("id", "is required");
    throw new RulePackError(r.problems);
  }
  return {
    id,
    ...(version !== undefined ? { version } : {}),
    ...(description !== undefined ? { description } : {}),
    disable,
    rules: rules as TextRuleSpec[],
    sensitive_files: files as FileRuleSpec[],
    secret_commands: commands as CommandRuleSpec[],
  };
}

export function parsePackToml(text: string, options: ValidateOptions): RulePack {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(text);
  } catch (err) {
    const position = (err as { position?: { line?: number; column?: number } }).position;
    const at =
      position?.line !== undefined
        ? `line ${position.line}${position.column !== undefined ? `, column ${position.column}` : ""}: `
        : "";
    throw new RulePackError([
      {
        where: options.source,
        message: `not valid TOML: ${at}${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  return validatePack(parsed, options);
}

export const LEGACY_PACK_ID = "legacy";
export const LEGACY_RULE_IDS = {
  patterns: "custom-pattern",
  sensitive_files: "custom-sensitive-files",
  secret_commands: "custom-secret-commands",
} as const;

export interface LegacyRules {
  patterns?: string[];
  sensitive_files?: string[];
  secret_commands?: string[];
}

const LEGACY_FIELDS = [
  "patterns",
  "sensitive_files",
  "secret_commands",
  "excluded",
  "names_only",
  "fetched_at",
];

export function readLegacyRules(text: string, source: string): LegacyRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RulePackError([
      {
        where: source,
        message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  return checkLegacyRules(parsed, source);
}

export function checkLegacyRules(value: unknown, source: string): LegacyRules {
  if (!isObject(value)) {
    throw new RulePackError([{ where: source, message: "a JSON rule file must be an object" }]);
  }
  const r = new Reader(source);
  r.unknown(value, LEGACY_FIELDS, "");
  const out: LegacyRules = {};
  for (const key of ["patterns", "sensitive_files", "secret_commands"] as const) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    const list = r.strings(v, key, MAX_PATTERN, MAX_RULES);
    if (list !== undefined) out[key] = list;
  }
  if (r.problems.length > 0) throw new RulePackError(r.problems);
  return out;
}

export function legacyPack(rules: LegacyRules, source: string): RulePack {
  const patterns = (rules.patterns ?? []).filter((p) => p.trim() !== "");
  const globs = (rules.sensitive_files ?? [])
    .map((g) => g.trim())
    .filter((g) => g !== "" && !g.startsWith("#") && g !== "!");
  const commands = (rules.secret_commands ?? [])
    .map((c) => c.trim())
    .filter((c) => c !== "" && !c.startsWith("#"));
  return validatePack(
    {
      id: LEGACY_PACK_ID,
      description: "Rules from JSON rule files (patterns, sensitive_files, secret_commands).",
      rules: patterns.length > 0 ? [{ id: LEGACY_RULE_IDS.patterns, patterns }] : [],
      sensitive_files: globs.length > 0 ? [{ id: LEGACY_RULE_IDS.sensitive_files, globs }] : [],
      secret_commands:
        commands.length > 0 ? [{ id: LEGACY_RULE_IDS.secret_commands, patterns: commands }] : [],
    },
    { source },
  );
}

export function parsePackFile(path: string, text: string): RulePack {
  if (path.toLowerCase().endsWith(".json")) return legacyPack(readLegacyRules(text, path), path);
  return parsePackToml(text, { source: path });
}

export function loadPacks(files: readonly { path: string; text: string }[]): LoadedPack[] {
  const out: (LoadedPack | null)[] = [];
  const legacy: Required<LegacyRules> = { patterns: [], sensitive_files: [], secret_commands: [] };
  const legacySources: string[] = [];
  const problems: PackProblem[] = [];
  for (const { path, text } of files) {
    try {
      if (path.toLowerCase().endsWith(".json")) {
        const rules = readLegacyRules(text, path);
        legacy.patterns.push(...(rules.patterns ?? []));
        legacy.sensitive_files.push(...(rules.sensitive_files ?? []));
        legacy.secret_commands.push(...(rules.secret_commands ?? []));
        if (legacySources.length === 0) out.push(null);
        legacySources.push(path);
      } else {
        out.push({ pack: parsePackToml(text, { source: path }), source: path });
      }
    } catch (err) {
      if (!(err instanceof RulePackError)) throw err;
      problems.push(...err.problems);
    }
  }
  if (problems.length > 0) throw new RulePackError(problems);
  const source = legacySources.join(", ");
  return out.map((p) => p ?? { pack: legacyPack(legacy, source), source });
}

export interface LoadedPack {
  pack: RulePack;
  source: string;
}
