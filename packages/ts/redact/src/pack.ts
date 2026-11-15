/** Rule packs (F2.1): the one place a redaction rule is defined, as data. The built-in pack
 * ships in the repository (`packs/builtin.toml`); an operator lists their own in config
 * (`[redaction] packs`). Every pack, whatever it came from (a TOML file, today's JSON rule file,
 * or the JSON `GET /v1/redaction/rules` serves a client), goes through one validator,
 * `validatePack`, so a rule means the same on the server and on a laptop.
 *
 * A pack in TOML:
 *
 * ```toml
 * id = "acme"                      # the pack's id
 * version = "2026-11-01"           # optional, free text
 * description = "Acme's secrets"   # optional
 * disable = ["entropy"]            # built-in rules this pack turns off, by id
 *
 * [[rules]]                        # text rules: a regular expression over strings
 * id = "acme-key"                  # stable: it names the rule in redaction counts
 * description = "Acme API keys"
 * pattern = 'ACME-[0-9A-F]{32}'    # or patterns = [...]; RE2 syntax for operator packs
 * replacement = "[redacted:acme-key]"   # the default is [redacted:<id>]
 * applies_to = ["text", "tool_input", "tool_output"]   # the default is all three
 * tests.match = ["key ACME-0123456789ABCDEF0123456789ABCDEF"]
 * tests.no_match = ["ACME-1234"]
 *
 * [[sensitive_files]]              # a call that names one of these files has its result withheld
 * id = "acme-master-key"
 * globs = ["config/master.key", "!config/README.md"]
 * tests.match = ["app/config/master.key"]
 *
 * [[secret_commands]]              # a call that runs one of these has its output withheld
 * id = "acme-token"
 * pattern = 'acme-cli\s+token\b'
 * tests.match = ["acme-cli token --org x"]
 * ```
 *
 * A text rule's match is replaced whole, or only the part a named group `secret` matched
 * (`api-key: (?P<secret>\S+)` keeps `api-key: `). Rule ids are lowercase words joined by `-`
 * and unique in a rule set; the counts stored with every session are by rule id (F2.3). */

/** Where in a record a text rule runs: message text, a tool call's input, a tool's output. */
export type AppliesTo = "text" | "tool_input" | "tool_output";

export const APPLIES_TO: readonly AppliesTo[] = ["text", "tool_input", "tool_output"];

/** Strings a rule must redact (`match`) and leave alone (`no_match`); checked when the pack
 * loads, so a rule that does not do what its author meant stops start-up. */
export interface RuleTests {
  match: string[];
  no_match: string[];
}

export interface TextRuleSpec {
  id: string;
  description?: string;
  /** Regular expressions; any of them matching is the rule matching. Empty for a built-in
   * rule implemented in code. */
  patterns: string[];
  /** Built-in pack only: the rule is matched by reviewed code (`secrets.ts`), not a pattern. */
  implementation?: "builtin";
  /** What a match becomes; `[redacted:<id>]` when absent. */
  replacement?: string;
  applies_to: AppliesTo[];
  tests?: RuleTests;
}

export interface FileRuleSpec {
  id: string;
  description?: string;
  /** `.gitignore`-style globs; `!` makes an exception, which holds for the whole rule set. */
  globs: string[];
  /** Paths that must (`match`) and must not (`no_match`) count as one of these files. */
  tests?: RuleTests;
}

export interface CommandRuleSpec {
  id: string;
  description?: string;
  /** Regular expressions matched at the start of each command of a shell line. */
  patterns: string[];
  /** Shell lines that must (`match`) and must not (`no_match`) run one of these commands. */
  tests?: RuleTests;
}

/** A validated pack: plain data, safe to serialize (it is what `GET /v1/redaction/rules`
 * serves) and to validate again. */
export interface RulePack {
  id: string;
  version?: string;
  description?: string;
  /** Built-in rule ids this pack turns off. */
  disable: string[];
  rules: TextRuleSpec[];
  sensitive_files: FileRuleSpec[];
  secret_commands: CommandRuleSpec[];
}

export interface PackProblem {
  /** Where: the pack's source and the field (`acme.toml: rules[2].pattern`). */
  where: string;
  message: string;
}

/** A pack that cannot be used. Names every problem, each with where it is. */
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

/** A rule or pack id: lowercase letters and digits, words joined by single `-`, up to 64. */
export const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ID = 64;
const MAX_PATTERN = 4096;
const MAX_REPLACEMENT = 256;
const MAX_TEXT = 1024;
const MAX_RULES = 1000;
const MAX_TESTS = 100;

export interface ValidateOptions {
  /** Names the pack in messages (a file path, `server`). */
  source: string;
  /** The built-in pack: rules may be `implementation = "builtin"`. */
  builtin?: boolean;
}

type Obj = Record<string, unknown>;

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collects problems while reading one pack. */
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

  /** `pattern` (one) or `patterns` (several): exactly one of them, every entry non-empty. */
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

  /** The entries of a list of tables. */
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

/** Check a pack read from anywhere (parsed TOML, JSON) and return it as plain data. Throws
 * `RulePackError` naming every problem. Patterns are not compiled here: whether a pattern is
 * valid depends on the engine it runs on, which the rule set decides (`compileRuleSet`). */
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

  // Rule ids are unique across the three kinds: redaction counts are by id alone.
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

/** A pack written in TOML. */
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

/** The id of the pack today's JSON rule files load as (F2.1). */
export const LEGACY_PACK_ID = "legacy";
/** The rule ids a JSON rule file's three lists become. The pattern rule keeps the kind every
 * custom pattern was counted and marked as before (`[redacted:custom-pattern]`). */
export const LEGACY_RULE_IDS = {
  patterns: "custom-pattern",
  sensitive_files: "custom-sensitive-files",
  secret_commands: "custom-secret-commands",
} as const;

/** The shape of today's JSON rule file (Dosu's CLI writes the same for an org's rules). */
export interface LegacyRules {
  patterns?: string[];
  sensitive_files?: string[];
  secret_commands?: string[];
}

/** The fields a JSON rule file may hold. The last three are what Dosu's CLI also keeps in it
 * (where an org's sessions do not ship, when it was fetched): about the client's machine, not
 * rules, so they are ignored. */
const LEGACY_FIELDS = [
  "patterns",
  "sensitive_files",
  "secret_commands",
  "excluded",
  "names_only",
  "fetched_at",
];

/** Read today's JSON rule file into its three lists. */
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

/** Today's rule lists from a value of unknown shape (a parsed JSON file, a caller's object). */
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

/** Today's JSON rule lists as one pack, `legacy`: the patterns as one rule, `custom-pattern`;
 * the files and commands as rules of their own kinds. Several JSON files are merged into one
 * such pack before it is validated, as they were merged before. */
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

/** A pack file's text, by its name: `.json` is today's JSON rule file, anything else TOML. */
export function parsePackFile(path: string, text: string): RulePack {
  if (path.toLowerCase().endsWith(".json")) return legacyPack(readLegacyRules(text, path), path);
  return parsePackToml(text, { source: path });
}

/** The packs `[redaction] packs` names, in order, from their files' text. JSON rule files are
 * merged into one `legacy` pack, placed where the first of them is listed, as they were merged
 * before packs existed. */
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

/** A pack and the file (or files, for the merged JSON pack) it came from. */
export interface LoadedPack {
  pack: RulePack;
  source: string;
}
