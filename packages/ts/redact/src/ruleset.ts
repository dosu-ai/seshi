import { createHash } from "node:crypto";
import { canonicalJson } from "@seshi/model";
import { BUILTIN_PACK_ID, builtinPack } from "./builtin";
import { compilePattern, type Engine, PatternError, type PatternMatcher } from "./matcher";
import {
  APPLIES_TO,
  type AppliesTo,
  type PackProblem,
  type RulePack,
  RulePackError,
  type RuleTests,
  validatePack,
} from "./pack";
import { BUILTIN_SECRET_KINDS, redactSecrets } from "./secrets";
import {
  type CommandTest,
  classifyCall,
  globFiles,
  isSensitivePath,
  runsSecretCommand,
  type SensitiveFiles,
  type SensitiveRules,
  type WithheldKind,
} from "./sensitive";

export class RuleSetError extends RulePackError {
  constructor(problems: readonly PackProblem[]) {
    super(problems);
    this.name = "RuleSetError";
  }
}

export type RuleKind = "text" | "file" | "command";

export interface RuleInfo {
  id: string;
  kind: RuleKind;
  pack: string;
  builtin: boolean;
  engine: Engine | "code" | "glob";
  description?: string;
  applies_to?: AppliesTo[];
  enabled: boolean;
  disabled_by?: string;
}

export interface CompiledTextRule {
  id: string;
  pack: string;
  matchers: readonly PatternMatcher[];
  replacement: string;
  applies: ReadonlySet<AppliesTo>;
}

export interface CompiledFileRule {
  id: string;
  pack: string;
  files: SensitiveFiles;
}

export interface CompiledCommandRule {
  id: string;
  pack: string;
  commands: readonly CommandTest[];
}

export type Counts = Record<string, number>;

export function bump(counts: Counts, rule: string, n = 1): void {
  if (n > 0) counts[rule] = (counts[rule] ?? 0) + n;
}

const MARKER = /^\[redacted:[a-z0-9]+(?:-[a-z0-9]+)*\]$/;

export const markerOf = (id: string) => `[redacted:${id}]`;

export class RuleSet {
  readonly hash: string;
  readonly builtinVersion: string;
  readonly builtin: RulePack;
  readonly packs: readonly RulePack[];
  readonly catalogue: readonly RuleInfo[];
  readonly text: readonly CompiledTextRule[];
  readonly secretsOff: ReadonlySet<string>;
  readonly files: readonly CompiledFileRule[];
  readonly commands: readonly CompiledCommandRule[];
  readonly sensitive: SensitiveRules;
  private readonly markers: ReadonlySet<string>;

  constructor(parts: {
    builtin: RulePack;
    packs: readonly RulePack[];
    catalogue: RuleInfo[];
    text: CompiledTextRule[];
    secretsOff: Set<string>;
    files: CompiledFileRule[];
    commands: CompiledCommandRule[];
  }) {
    this.builtin = parts.builtin;
    this.builtinVersion = parts.builtin.version ?? "";
    this.packs = parts.packs;
    this.catalogue = parts.catalogue;
    this.text = parts.text;
    this.secretsOff = parts.secretsOff;
    this.files = parts.files;
    this.commands = parts.commands;
    this.sensitive = {
      files: {
        include: parts.files.flatMap((r) => r.files.include),
        exclude: parts.files.flatMap((r) => r.files.exclude),
      },
      commands: parts.commands.flatMap((r) => r.commands),
    };
    this.markers = new Set([
      ...parts.text.map((r) => r.replacement),
      ...BUILTIN_SECRET_KINDS.map(markerOf),
      markerOf("sensitive-file"),
      markerOf("secret-output"),
    ]);
    this.hash = createHash("sha256")
      .update(
        canonicalJson({
          v: 1,
          builtin: { version: this.builtinVersion, rules: behaviour(parts.builtin) },
          packs: parts.packs.map(behaviour),
        }),
        "utf8",
      )
      .digest("hex");
  }

  isMarker(region: string): boolean {
    return this.markers.has(region) || MARKER.test(region);
  }

  redactString(text: string, field: AppliesTo | "anywhere", counts: Counts): string {
    let out = text;
    for (const rule of this.text) {
      if (field === "anywhere" || rule.applies.has(field)) {
        out = applyTextRule(out, rule, counts, this);
      }
    }
    const secrets = redactSecrets(out, this.secretsOff);
    for (const [id, n] of Object.entries(secrets.counts)) bump(counts, id, n);
    return secrets.text;
  }

  withholdingRule(input: unknown, kind: WithheldKind): string {
    if (kind === "sensitive-file") {
      for (const rule of this.files) {
        const files = { include: rule.files.include, exclude: this.sensitive.files.exclude };
        if (classifyCall(input, { files, commands: [] }) === "sensitive-file") return rule.id;
      }
    } else {
      const none = { include: [], exclude: [] };
      for (const rule of this.commands) {
        if (classifyCall(input, { files: none, commands: rule.commands }) === "secret-output") {
          return rule.id;
        }
      }
    }
    /* v8 ignore next -- classifyCall over the whole set found one of these rules */
    return kind;
  }
}

function behaviour(pack: RulePack): unknown {
  return {
    id: pack.id,
    disable: pack.disable,
    rules: pack.rules.map((r) => ({
      id: r.id,
      patterns: r.patterns,
      implementation: r.implementation ?? null,
      replacement: r.replacement ?? null,
      applies_to: r.applies_to,
    })),
    sensitive_files: pack.sensitive_files.map((r) => ({ id: r.id, globs: r.globs })),
    secret_commands: pack.secret_commands.map((r) => ({ id: r.id, patterns: r.patterns })),
  };
}

export function applyTextRule(
  text: string,
  rule: CompiledTextRule,
  counts: Counts,
  set: { isMarker(region: string): boolean },
): string {
  let out = text;
  for (const matcher of rule.matchers) {
    const matches = matcher.matches(out);
    if (matches.length === 0) continue;
    let result = "";
    let from = 0;
    let n = 0;
    for (const m of matches) {
      const [start, end] = m.secret ?? [m.start, m.end];
      if (start === end) continue;
      const region = out.slice(start, end);
      if (region === rule.replacement || set.isMarker(region)) continue;
      result += out.slice(from, start) + rule.replacement;
      from = end;
      n++;
    }
    if (n > 0) {
      out = result + out.slice(from);
      bump(counts, rule.id, n);
    }
  }
  return out;
}

export interface CompileOptions {
  packs?: readonly RulePack[];
  builtin?: RulePack;
  runTests?: boolean;
  sources?: Readonly<Record<string, string>>;
}

export function compileRuleSet(options: CompileOptions = {}): RuleSet {
  const builtin = options.builtin ?? builtinPack();
  const packs = [...(options.packs ?? [])];
  const problems: PackProblem[] = [];
  const named = (pack: string) => {
    const source = options.sources?.[pack];
    return source !== undefined ? `${source} (pack ${pack})` : `pack ${pack}`;
  };
  const problem = (pack: string, where: string, message: string) =>
    problems.push({ where: `${named(pack)}${where ? `: ${where}` : ""}`, message });

  const coded = builtin.rules.filter((r) => r.implementation === "builtin").map((r) => r.id);
  for (const id of coded) {
    if (!BUILTIN_SECRET_KINDS.includes(id)) problem(builtin.id, id, "no code implements this rule");
  }
  for (const id of BUILTIN_SECRET_KINDS) {
    if (!coded.includes(id)) problem(builtin.id, id, "is implemented in code but not in the pack");
  }

  const packIds = new Set<string>([builtin.id]);
  for (const pack of packs) {
    if (packIds.has(pack.id)) problem(pack.id, "id", `another pack is also named '${pack.id}'`);
    packIds.add(pack.id);
  }

  const owner = new Map<string, string>();
  const ruleIds = (pack: RulePack) => [
    ...pack.rules.map((r) => r.id),
    ...pack.sensitive_files.map((r) => r.id),
    ...pack.secret_commands.map((r) => r.id),
  ];
  for (const pack of [builtin, ...packs]) {
    for (const id of ruleIds(pack)) {
      const first = owner.get(id);
      if (first === undefined) owner.set(id, pack.id);
      else if (first === builtin.id) {
        problem(
          pack.id,
          id,
          `is a built-in rule's id; pick another (turn the built-in off with disable = ["${id}"])`,
        );
      } else {
        problem(pack.id, id, `is also a rule in pack ${first}`);
      }
    }
  }

  const builtinIds = new Set(ruleIds(builtin));
  const disabledBy = new Map<string, string>();
  for (const pack of packs) {
    for (const id of pack.disable) {
      if (!builtinIds.has(id)) {
        problem(
          pack.id,
          "disable",
          owner.has(id)
            ? `'${id}' is not a built-in rule; only built-in rules can be turned off`
            : `'${id}' is not a built-in rule`,
        );
      } else if (!disabledBy.has(id)) {
        disabledBy.set(id, pack.id);
      }
    }
  }

  const catalogue: RuleInfo[] = [];
  const text: CompiledTextRule[] = [];
  const builtinText: CompiledTextRule[] = [];
  const files: CompiledFileRule[] = [];
  const commands: CompiledCommandRule[] = [];
  const secretsOff = new Set<string>();

  for (const pack of [...packs, builtin]) {
    const isBuiltin = pack === builtin;
    const engine: Engine = isBuiltin ? "js" : "re2";
    const state = (id: string) => {
      const by = disabledBy.get(id);
      return by !== undefined ? { enabled: false, disabled_by: by } : { enabled: true };
    };
    pack.rules.forEach((rule, i) => {
      const s = state(rule.id);
      catalogue.push({
        id: rule.id,
        kind: "text",
        pack: pack.id,
        builtin: isBuiltin,
        engine: rule.implementation ? "code" : engine,
        ...(rule.description !== undefined ? { description: rule.description } : {}),
        applies_to: rule.applies_to,
        ...s,
      });
      if (rule.implementation) {
        if (!s.enabled) secretsOff.add(rule.id);
        return;
      }
      const matchers: PatternMatcher[] = [];
      for (const source of rule.patterns) {
        try {
          matchers.push(compilePattern(source, engine));
        } catch (err) {
          if (!(err instanceof PatternError)) throw err;
          problem(
            pack.id,
            `rules[${i}] (${rule.id})`,
            `pattern '${source}' ${describe(err, engine)}`,
          );
        }
      }
      if (!s.enabled) return;
      (isBuiltin ? builtinText : text).push({
        id: rule.id,
        pack: pack.id,
        matchers,
        replacement: rule.replacement ?? markerOf(rule.id),
        applies: new Set(rule.applies_to),
      });
    });
    for (const rule of pack.sensitive_files) {
      const s = state(rule.id);
      catalogue.push({
        id: rule.id,
        kind: "file",
        pack: pack.id,
        builtin: isBuiltin,
        engine: "glob",
        ...(rule.description !== undefined ? { description: rule.description } : {}),
        ...s,
      });
      if (s.enabled) files.push({ id: rule.id, pack: pack.id, files: globFiles(rule.globs) });
    }
    pack.secret_commands.forEach((rule, i) => {
      const s = state(rule.id);
      catalogue.push({
        id: rule.id,
        kind: "command",
        pack: pack.id,
        builtin: isBuiltin,
        engine,
        ...(rule.description !== undefined ? { description: rule.description } : {}),
        ...s,
      });
      const compiled: PatternMatcher[] = [];
      for (const source of rule.patterns) {
        try {
          compiled.push(compilePattern(source, engine, { anchored: true }));
        } catch (err) {
          if (!(err instanceof PatternError)) throw err;
          problem(
            pack.id,
            `secret_commands[${i}] (${rule.id})`,
            `pattern '${source}' ${describe(err, engine)}`,
          );
        }
      }
      if (s.enabled) commands.push({ id: rule.id, pack: pack.id, commands: compiled });
    });
  }
  if (problems.length > 0) throw new RuleSetError(problems);

  const set = new RuleSet({
    builtin,
    packs,
    catalogue,
    text: [...text, ...builtinText],
    secretsOff,
    files,
    commands,
  });

  const markers = new Set([
    ...set.text.map((r) => r.replacement),
    ...BUILTIN_SECRET_KINDS.map(markerOf),
    markerOf("sensitive-file"),
    markerOf("secret-output"),
  ]);
  for (const rule of set.text) {
    for (const marker of markers) {
      if (applyTextRule(marker, rule, {}, set) !== marker) {
        problem(
          rule.pack,
          rule.id,
          `changes the replacement '${marker}', so redacting twice would change it again`,
        );
      }
    }
  }
  for (const rule of set.text) {
    const seen = redactSecrets(rule.replacement, set.secretsOff);
    if (seen.count > 0) {
      problem(
        rule.pack,
        rule.id,
        `its replacement '${rule.replacement}' looks like a secret to the built-in rules (${Object.keys(seen.counts).join(", ")})`,
      );
    }
  }
  if (options.runTests) {
    for (const result of runRuleTests(set, { builtin: false })) {
      if (result.ok) continue;
      problem(
        result.pack,
        result.rule,
        result.expect === "match"
          ? `does not match its test string ${JSON.stringify(result.input)}`
          : `matches its no_match test string ${JSON.stringify(result.input)}`,
      );
    }
  }
  if (problems.length > 0) throw new RuleSetError(problems);
  return set;
}

function describe(err: PatternError, engine: Engine): string {
  return engine === "re2"
    ? `is not a usable RE2 pattern: ${err.message}`
    : `does not compile: ${err.message}`;
}

export interface RuleTestResult {
  pack: string;
  rule: string;
  expect: "match" | "no_match";
  input: string;
  ok: boolean;
}

export function runRuleTests(
  set: RuleSet,
  options: { builtin?: boolean; operator?: boolean } = {},
): RuleTestResult[] {
  const out: RuleTestResult[] = [];
  const packs = [
    ...(options.operator === false ? [] : set.packs),
    ...(options.builtin === false ? [] : [set.builtin]),
  ];
  for (const pack of packs) {
    const engine: Engine = pack === set.builtin ? "js" : "re2";
    const check = (
      rule: string,
      tests: RuleTests | undefined,
      hits: (input: string) => boolean,
    ) => {
      for (const input of tests?.match ?? []) {
        out.push({ pack: pack.id, rule, expect: "match", input, ok: hits(input) });
      }
      for (const input of tests?.no_match ?? []) {
        out.push({ pack: pack.id, rule, expect: "no_match", input, ok: !hits(input) });
      }
    };
    for (const rule of pack.rules) {
      if (!rule.tests) continue;
      if (rule.implementation) {
        const off = new Set(BUILTIN_SECRET_KINDS.filter((k) => k !== rule.id));
        check(rule.id, rule.tests, (input) => redactSecrets(input, off).count > 0);
        continue;
      }
      const compiled: CompiledTextRule = {
        id: rule.id,
        pack: pack.id,
        matchers: rule.patterns.map((p) => compilePattern(p, engine)),
        replacement: rule.replacement ?? markerOf(rule.id),
        applies: new Set(APPLIES_TO),
      };
      check(rule.id, rule.tests, (input) => {
        const counts: Counts = {};
        applyTextRule(input, compiled, counts, set);
        return (counts[rule.id] ?? 0) > 0;
      });
    }
    for (const rule of pack.sensitive_files) {
      const files = globFiles(rule.globs);
      check(rule.id, rule.tests, (path) => isSensitivePath(path, files));
    }
    for (const rule of pack.secret_commands) {
      const commands = rule.patterns.map((p) => compilePattern(p, engine, { anchored: true }));
      check(rule.id, rule.tests, (line) => runsSecretCommand(line, commands));
    }
  }
  return out;
}

export interface RedactionRulesDocument {
  schema: "seshi/redaction-rules/1";
  rule_set: string;
  builtin: string;
  packs: RulePack[];
}

export const REDACTION_RULES_SCHEMA = "seshi/redaction-rules/1";

export function rulesDocument(set: RuleSet): RedactionRulesDocument {
  return {
    schema: REDACTION_RULES_SCHEMA,
    rule_set: set.hash,
    builtin: set.builtinVersion,
    packs: [...set.packs],
  };
}

export function ruleSetFromDocument(document: unknown): { rules: RuleSet; same: boolean } {
  if (typeof document !== "object" || document === null) {
    throw new RulePackError([{ where: "redaction rules", message: "must be an object" }]);
  }
  const doc = document as Partial<RedactionRulesDocument>;
  if (doc.schema !== REDACTION_RULES_SCHEMA || !Array.isArray(doc.packs)) {
    throw new RulePackError([
      { where: "redaction rules", message: `is not a ${REDACTION_RULES_SCHEMA} document` },
    ]);
  }
  const builtin = builtinPack();
  const known = new Set(
    [...builtin.rules, ...builtin.sensitive_files, ...builtin.secret_commands].map((r) => r.id),
  );
  const packs = doc.packs.map((p, i) => {
    const id = typeof p === "object" && p !== null && typeof (p as RulePack).id === "string";
    const pack = validatePack(p, { source: `server pack ${id ? (p as RulePack).id : i}` });
    return { ...pack, disable: pack.disable.filter((rule) => known.has(rule)) };
  });
  const rules = compileRuleSet({ packs, builtin });
  return { rules, same: rules.hash === doc.rule_set };
}

export { BUILTIN_PACK_ID };
