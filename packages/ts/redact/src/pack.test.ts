import { describe, expect, it } from "vitest";
import {
  legacyPack,
  loadPacks,
  parsePackFile,
  parsePackToml,
  type RulePack,
  RulePackError,
  readLegacyRules,
  validatePack,
} from "./pack";

const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RulePackError) return err.problems.map((p) => `${p.where}: ${p.message}`);
    throw err;
  }
  return [];
};

const ACME = `
id = "acme"
version = "3"
description = "Acme's own secrets"
disable = ["entropy"]

[[rules]]
id = "acme-key"
description = "Acme API keys"
pattern = 'ACME-[0-9A-F]{32}'
tests.match = ["key ACME-0123456789ABCDEF0123456789ABCDEF"]
tests.no_match = ["ACME-1234"]

[[rules]]
id = "internal-key"
patterns = ['internal-key: (?P<secret>\\S+)', 'ikey=(?P<secret>\\w+)']
replacement = "[internal]"
applies_to = ["tool_output", "text"]

[[sensitive_files]]
id = "acme-master-key"
globs = ["config/master.key", "!config/README.md", "# a comment", ""]
tests.match = ["app/config/master.key"]

[[secret_commands]]
id = "acme-token"
pattern = 'acme-cli\\s+token\\b'
`;

describe("parsePackToml", () => {
  it("reads a pack into plain data, with defaults filled in", () => {
    const pack = parsePackToml(ACME, { source: "acme.toml" });
    expect(pack).toEqual({
      id: "acme",
      version: "3",
      description: "Acme's own secrets",
      disable: ["entropy"],
      rules: [
        {
          id: "acme-key",
          description: "Acme API keys",
          patterns: ["ACME-[0-9A-F]{32}"],
          applies_to: ["text", "tool_input", "tool_output"],
          tests: {
            match: ["key ACME-0123456789ABCDEF0123456789ABCDEF"],
            no_match: ["ACME-1234"],
          },
        },
        {
          id: "internal-key",
          patterns: ["internal-key: (?P<secret>\\S+)", "ikey=(?P<secret>\\w+)"],
          replacement: "[internal]",
          // In the canonical order, whatever order the pack named them in.
          applies_to: ["text", "tool_output"],
        },
      ],
      sensitive_files: [
        {
          id: "acme-master-key",
          globs: ["config/master.key", "!config/README.md"],
          tests: { match: ["app/config/master.key"], no_match: [] },
        },
      ],
      secret_commands: [{ id: "acme-token", patterns: ["acme-cli\\s+token\\b"] }],
    } satisfies RulePack);
  });

  it("is its own fixed point: a validated pack validates to itself", () => {
    const pack = parsePackToml(ACME, { source: "acme.toml" });
    expect(validatePack(JSON.parse(JSON.stringify(pack)), { source: "again" })).toEqual(pack);
  });

  it("says where TOML that does not parse goes wrong", () => {
    expect(problems(() => parsePackToml('id = "x"\npattern = "a', { source: "bad.toml" }))).toEqual(
      [expect.stringMatching(/^bad\.toml: not valid TOML: line 2, column \d+: /)],
    );
  });

  it("names every problem, each with its field", () => {
    const found = problems(() =>
      parsePackToml(
        `
id = "Bad Id"
colour = "red"
disable = ["not an id"]

[[rules]]
id = "a"
pattern = "x"
patterns = ["y"]

[[rules]]
id = "b"
pattern = ""

[[rules]]
id = "c"
replacement = "two\\nlines"
applies_to = ["text", "logs"]
implementation = "builtin"

[[rules]]
id = "a"
pattern = "z"
tests = "yes"

[[sensitive_files]]
id = "f"
globs = []

[[secret_commands]]
id = "c"
`,
        { source: "p.toml" },
      ),
    );
    expect(found).toEqual([
      "p.toml: colour: is not a known field",
      "p.toml: id: 'Bad Id' is not an id: lowercase letters and digits, words joined by single '-'",
      "p.toml: disable: 'not an id' is not a rule id",
      "p.toml: rules[0]: has both pattern and patterns; use one",
      "p.toml: rules[1].pattern: must not be blank",
      "p.toml: rules[2].implementation: is not a known field",
      "p.toml: rules[2].pattern: is required",
      "p.toml: rules[2].replacement: must be one line",
      "p.toml: rules[2].applies_to: 'logs' is not one of text, tool_input, tool_output",
      "p.toml: rules[3].tests: must be a table with match and no_match",
      "p.toml: sensitive_files[0].globs: must name at least one glob",
      "p.toml: secret_commands[0].pattern: is required",
    ]);
  });

  it("keeps rule ids unique across the three kinds, and refuses turning off its own rule", () => {
    expect(
      problems(() =>
        validatePack(
          {
            id: "p",
            disable: ["x"],
            rules: [{ id: "x", pattern: "abc" }],
            secret_commands: [{ id: "x", pattern: "abc" }],
          },
          { source: "p" },
        ),
      ),
    ).toEqual([
      "p: secret_commands[0].id: 'x' is also rules[0]'s id",
      "p: disable: 'x' is this pack's own rule; remove it instead of turning it off",
    ]);
  });

  it("refuses what is not a table, a missing id, and wrong types", () => {
    expect(problems(() => validatePack([], { source: "p" }))).toEqual([
      "p: a pack must be a table",
    ]);
    expect(problems(() => validatePack({}, { source: "p" }))).toEqual(["p: id: is required"]);
    expect(
      problems(() =>
        validatePack(
          {
            id: "p",
            version: 3,
            rules: { id: "x" },
            sensitive_files: ["x"],
            secret_commands: [{ id: "c", patterns: [] }],
          },
          { source: "p" },
        ),
      ),
    ).toEqual([
      "p: version: must be a string",
      "p: rules: must be a list of tables ([[rules]] in TOML)",
      "p: sensitive_files[0]: must be a table",
      "p: secret_commands[0].patterns: must not be empty",
    ]);
    expect(
      problems(() =>
        validatePack(
          { id: "p", rules: [{ id: "x", pattern: 1, applies_to: [] }] },
          { source: "p" },
        ),
      ),
    ).toEqual([
      "p: rules[0].pattern: must be a string",
      "p: rules[0].applies_to: must name at least one of text, tool_input, tool_output",
    ]);
    expect(
      problems(() =>
        validatePack(
          { id: "p", rules: [{ id: "x", pattern: "a", applies_to: ["text", "text"] }] },
          { source: "p" },
        ),
      ),
    ).toEqual(["p: rules[0].applies_to: names a place twice"]);
  });

  it("caps sizes", () => {
    expect(
      problems(() =>
        validatePack({ id: "p", rules: [{ id: "x", pattern: "a".repeat(5000) }] }, { source: "p" }),
      ),
    ).toEqual(["p: rules[0].pattern: must be at most 4096 characters"]);
    expect(
      problems(() =>
        validatePack(
          { id: "p", rules: [{ id: "x", pattern: "a", replacement: "r".repeat(300) }] },
          { source: "p" },
        ),
      ),
    ).toEqual(["p: rules[0].replacement: must be at most 256 characters"]);
  });

  it("drops empty tests", () => {
    const pack = validatePack(
      { id: "p", rules: [{ id: "x", pattern: "a", tests: { match: [], no_match: [] } }] },
      { source: "p" },
    );
    expect(pack.rules[0]?.tests).toBeUndefined();
  });
});

describe("the built-in pack's own fields", () => {
  it("lets only the built-in pack implement a rule in code, without a pattern", () => {
    expect(
      validatePack(
        { id: "builtin", rules: [{ id: "jwt", implementation: "builtin" }] },
        { source: "b", builtin: true },
      ).rules[0],
    ).toEqual({
      id: "jwt",
      patterns: [],
      implementation: "builtin",
      applies_to: ["text", "tool_input", "tool_output"],
    });
    expect(
      problems(() =>
        validatePack(
          {
            id: "builtin",
            disable: ["x"],
            rules: [
              { id: "a", implementation: "builtin", pattern: "x" },
              { id: "b", implementation: "regex" },
              { id: "c", implementation: "builtin", replacement: "[c]" },
            ],
          },
          { source: "b", builtin: true },
        ),
      ),
    ).toEqual([
      "b: disable: the built-in pack turns nothing off",
      "b: rules[0]: a rule implemented in code has no pattern",
      'b: rules[1].implementation: must be "builtin"',
      "b: rules[2].replacement: a rule implemented in code keeps its own replacement",
    ]);
  });
});

describe("JSON rule files (F2.1: today's file loads as a pack)", () => {
  const json = JSON.stringify({
    patterns: ["ACME-\\d+", " "],
    sensitive_files: ["config/master.key", "# note", "!"],
    secret_commands: ["acme-cli\\s+token\\b"],
    excluded: ["acme/payments"],
    fetched_at: "2026-11-11T00:00:00Z",
  });

  it("load as the legacy pack: one pattern rule, custom-pattern, and a rule per kind", () => {
    expect(parsePackFile("org/rules.JSON", json)).toEqual({
      id: "legacy",
      description: "Rules from JSON rule files (patterns, sensitive_files, secret_commands).",
      disable: [],
      rules: [
        {
          id: "custom-pattern",
          patterns: ["ACME-\\d+"],
          applies_to: ["text", "tool_input", "tool_output"],
        },
      ],
      sensitive_files: [{ id: "custom-sensitive-files", globs: ["config/master.key"] }],
      secret_commands: [{ id: "custom-secret-commands", patterns: ["acme-cli\\s+token\\b"] }],
    });
  });

  it("leave out the kinds a file does not have", () => {
    const pack = legacyPack({ patterns: ["x+y"] }, "f.json");
    expect([pack.rules.length, pack.sensitive_files.length, pack.secret_commands.length]).toEqual([
      1, 0, 0,
    ]);
  });

  it("refuse a misspelt field, a list that is not strings, and what is not a JSON object", () => {
    expect(problems(() => readLegacyRules('{"sensitve_files": []}', "f.json"))).toEqual([
      "f.json: sensitve_files: is not a known field",
    ]);
    expect(problems(() => readLegacyRules('{"patterns": [1]}', "f.json"))).toEqual([
      "f.json: patterns: must be a list of strings",
    ]);
    expect(problems(() => readLegacyRules("[]", "f.json"))).toEqual([
      "f.json: a JSON rule file must be an object",
    ]);
    expect(problems(() => readLegacyRules("{", "f.json"))[0]).toMatch(/^f\.json: not valid JSON/);
  });
});

describe("loadPacks", () => {
  it("keeps TOML packs in order and merges JSON files into one legacy pack where the first was", () => {
    const packs = loadPacks([
      { path: "a.json", text: '{"patterns": ["AAA-\\\\d+"]}' },
      { path: "acme.toml", text: ACME },
      { path: "b.json", text: '{"patterns": ["BBB-\\\\d+"], "sensitive_files": ["x.key"]}' },
    ]);
    expect(packs.map((p) => [p.pack.id, p.source])).toEqual([
      ["legacy", "a.json, b.json"],
      ["acme", "acme.toml"],
    ]);
    expect(packs[0]?.pack.rules[0]?.patterns).toEqual(["AAA-\\d+", "BBB-\\d+"]);
    expect(packs[0]?.pack.sensitive_files[0]?.globs).toEqual(["x.key"]);
  });

  it("reports the problems of every file at once", () => {
    expect(
      problems(() =>
        loadPacks([
          { path: "a.toml", text: "id = 1" },
          { path: "b.json", text: "[]" },
        ]),
      ),
    ).toEqual(["a.toml: id: must be a string", "b.json: a JSON rule file must be an object"]);
  });
});
