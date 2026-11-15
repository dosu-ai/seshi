import { describe, expect, it } from "vitest";
import { builtinPack } from "./builtin";
import { type AppliesTo, type RulePack, validatePack } from "./pack";
import {
  type Counts,
  compileRuleSet,
  REDACTION_RULES_SCHEMA,
  RuleSetError,
  ruleSetFromDocument,
  rulesDocument,
  runRuleTests,
} from "./ruleset";

const pack = (value: Record<string, unknown>): RulePack =>
  validatePack({ id: "acme", ...value }, { source: "acme.toml" });

const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RuleSetError) return err.problems.map((p) => `${p.where}: ${p.message}`);
    throw err;
  }
  return [];
};

const redact = (
  set: ReturnType<typeof compileRuleSet>,
  text: string,
  field: AppliesTo | "anywhere" = "text",
) => {
  const counts: Counts = {};
  return { text: set.redactString(text, field, counts), counts };
};

describe("compileRuleSet", () => {
  it("runs the operator's text rules, then the built-ins, counting by rule id", () => {
    const set = compileRuleSet({
      packs: [pack({ rules: [{ id: "acme-key", pattern: "ACME-[0-9A-F]{8}" }] })],
    });
    expect(
      redact(set, "ACME-0123ABCD and ghp_abcdefghijklmnopqrstuvwx0123456789 and ACME-FFFFFFFF"),
    ).toEqual({
      text: "[redacted:acme-key] and [redacted:github-token] and [redacted:acme-key]",
      counts: { "acme-key": 2, "github-token": 1 },
    });
  });

  it("replaces only the secret group, with the rule's own replacement", () => {
    const set = compileRuleSet({
      packs: [
        pack({
          rules: [{ id: "ikey", pattern: "internal-key: (?P<secret>\\S+)", replacement: "<gone>" }],
        }),
      ],
    });
    expect(redact(set, "internal-key: abc then internal-key: zz").text).toBe(
      "internal-key: <gone> then internal-key: <gone>",
    );
  });

  it("applies a text rule only where applies_to says", () => {
    const set = compileRuleSet({
      packs: [pack({ rules: [{ id: "row", pattern: "ROW-\\d+", applies_to: ["tool_output"] }] })],
    });
    expect(redact(set, "ROW-12", "text").text).toBe("ROW-12");
    expect(redact(set, "ROW-12", "tool_input").text).toBe("ROW-12");
    expect(redact(set, "ROW-12", "tool_output").text).toBe("[redacted:row]");
  });

  it("is idempotent, and counts nothing the second time", () => {
    const set = compileRuleSet({
      packs: [
        pack({
          rules: [
            { id: "ikey", pattern: "internal-key: (?P<secret>\\S+)" },
            { id: "acme-key", pattern: "ACME-\\d+" },
          ],
        }),
      ],
    });
    const once = redact(set, "internal-key: s3cr3t ACME-42 password=hunter2hunter2hunter2");
    expect(once.counts).toEqual({ ikey: 1, "acme-key": 1, credential: 1 });
    expect(redact(set, once.text)).toEqual({ text: once.text, counts: {} });
  });

  it("leaves an earlier rule's marker as it is (a backfill keeps old markers)", () => {
    const set = compileRuleSet({
      packs: [pack({ rules: [{ id: "ikey", pattern: "internal-key: (?P<secret>\\S+)" }] })],
    });
    expect(redact(set, "internal-key: [redacted:openai-key]")).toEqual({
      text: "internal-key: [redacted:openai-key]",
      counts: {},
    });
  });

  it("turns built-in rules off by id, and lists them as off", () => {
    const set = compileRuleSet({
      packs: [pack({ disable: ["github-token", "entropy", "sensitive-file", "secret-output"] })],
    });
    expect(
      redact(set, "ghp_abcdefghijklmnopqrstuvwx0123456789 sk-proj-abcdefghijklmnopqrstuvwxyz"),
    ).toEqual({
      text: "ghp_abcdefghijklmnopqrstuvwx0123456789 [redacted:openai-key]",
      counts: { "openai-key": 1 },
    });
    expect(set.secretsOff).toEqual(new Set(["github-token", "entropy"]));
    expect(set.files).toEqual([]);
    expect(set.commands).toEqual([]);
    const github = set.catalogue.find((r) => r.id === "github-token");
    expect(github).toMatchObject({ enabled: false, disabled_by: "acme", engine: "code" });
  });

  it("refuses what spans packs: duplicate pack and rule ids, unknown or operator disables", () => {
    const a = pack({ rules: [{ id: "acme-key", pattern: "A" }] });
    const b = validatePack(
      {
        id: "other",
        disable: ["acme-key", "no-such-rule"],
        rules: [{ id: "jwt", pattern: "C" }],
      },
      { source: "other.toml" },
    );
    const c = validatePack(
      { id: "third", rules: [{ id: "acme-key", pattern: "B" }] },
      { source: "c" },
    );
    expect(problems(() => compileRuleSet({ packs: [a, b, c, a] }))).toEqual([
      "pack acme: id: another pack is also named 'acme'",
      'pack other: jwt: is a built-in rule\'s id; pick another (turn the built-in off with disable = ["jwt"])',
      "pack third: acme-key: is also a rule in pack acme",
      "pack acme: acme-key: is also a rule in pack acme",
      "pack other: disable: 'acme-key' is not a built-in rule; only built-in rules can be turned off",
      "pack other: disable: 'no-such-rule' is not a built-in rule",
    ]);
    expect(
      problems(() => compileRuleSet({ packs: [validatePack({ id: "builtin" }, { source: "x" })] })),
    ).toEqual(["pack builtin: id: another pack is also named 'builtin'"]);
  });

  it("compiles operator patterns under RE2, naming the rule and pattern that cannot be used", () => {
    expect(
      problems(() =>
        compileRuleSet({
          packs: [
            pack({
              rules: [{ id: "look", patterns: ["ok", "(?<=k=)\\w+"] }],
              secret_commands: [{ id: "cmd", pattern: "x*" }],
            }),
          ],
        }),
      ),
    ).toEqual([
      expect.stringMatching(
        /^pack acme: rules\[0\] \(look\): pattern '\(\?<=k=\)\\w\+' is not a usable RE2 pattern: .*no lookahead or lookbehind/,
      ),
      "pack acme: secret_commands[0] (cmd): pattern 'x*' is not a usable RE2 pattern: matches an empty command",
    ]);
  });

  it("refuses a rule that would change what another rule replaces text with", () => {
    expect(
      problems(() =>
        compileRuleSet({
          packs: [
            pack({
              rules: [
                { id: "word", pattern: "redacted" },
                { id: "loud", pattern: "LOUD", replacement: "NOT LOUD" },
              ],
            }),
          ],
        }),
      ),
    ).toContain(
      "pack acme: word: changes the replacement '[redacted:word]', so redacting twice would change it again",
    );
    expect(
      problems(() =>
        compileRuleSet({
          packs: [pack({ rules: [{ id: "loud", pattern: "LOUD", replacement: "NOT LOUD" }] })],
        }),
      ),
    ).toEqual([
      "pack acme: loud: changes the replacement 'NOT LOUD', so redacting twice would change it again",
    ]);
  });

  it("refuses a replacement the built-ins would redact", () => {
    expect(
      problems(() =>
        compileRuleSet({
          packs: [
            pack({
              rules: [{ id: "x", pattern: "XYZ", replacement: "password=hunter2hunter2hunter2" }],
            }),
          ],
        }),
      ),
    ).toEqual([
      "pack acme: x: its replacement 'password=hunter2hunter2hunter2' looks like a secret to the built-in rules (credential)",
    ]);
  });

  it("checks the operator's test strings when asked", () => {
    const failing = pack({
      rules: [
        {
          id: "acme-key",
          pattern: "ACME-\\d{4}",
          tests: { match: ["ACME-12"], no_match: ["ACME-1234"] },
        },
      ],
      sensitive_files: [{ id: "f", globs: ["*.secret"], tests: { match: ["a.txt"] } }],
      secret_commands: [{ id: "c", pattern: "acme\\s+token", tests: { no_match: ["acme token"] } }],
    });
    expect(compileRuleSet({ packs: [failing] }).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(problems(() => compileRuleSet({ packs: [failing], runTests: true }))).toEqual([
      'pack acme: acme-key: does not match its test string "ACME-12"',
      'pack acme: acme-key: matches its no_match test string "ACME-1234"',
      'pack acme: f: does not match its test string "a.txt"',
      'pack acme: c: matches its no_match test string "acme token"',
    ]);
  });
});

describe("withheld calls by rule id", () => {
  const set = compileRuleSet({
    packs: [
      pack({
        sensitive_files: [{ id: "acme-master", globs: ["config/master.key"] }],
        secret_commands: [{ id: "acme-token", pattern: "acme-cli\\s+token\\b" }],
      }),
    ],
  });

  it("names the rule a call met", () => {
    expect(set.withholdingRule('{"file_path":"config/master.key"}', "sensitive-file")).toBe(
      "acme-master",
    );
    expect(set.withholdingRule('{"file_path":".env"}', "sensitive-file")).toBe("sensitive-file");
    expect(set.withholdingRule('{"command":"acme-cli token"}', "secret-output")).toBe("acme-token");
    expect(set.withholdingRule('{"command":"printenv"}', "secret-output")).toBe("secret-output");
  });

  it("applies an exception from any file rule to every file rule", () => {
    const withException = compileRuleSet({
      packs: [pack({ sensitive_files: [{ id: "keep-dev-env", globs: ["!.env.dev"] }] })],
    });
    expect(withException.sensitive.files.exclude.length).toBeGreaterThan(
      compileRuleSet().sensitive.files.exclude.length,
    );
  });
});

describe("the rule-set hash", () => {
  const base = { rules: [{ id: "acme-key", pattern: "ACME-\\d+", description: "a" }] };

  it("is stable, and changes with what the rules do", () => {
    const h = (value: Record<string, unknown>) => compileRuleSet({ packs: [pack(value)] }).hash;
    expect(h(base)).toBe(h(base));
    expect(h(base)).not.toBe(compileRuleSet().hash);
    expect(h({ rules: [{ id: "acme-key", pattern: "ACME-\\d{2,}" }] })).not.toBe(h(base));
    expect(h({ rules: [{ id: "acme-key", pattern: "ACME-\\d+", replacement: "x" }] })).not.toBe(
      h(base),
    );
    expect(h({ rules: [{ id: "acme-key", pattern: "ACME-\\d+", applies_to: ["text"] }] })).not.toBe(
      h(base),
    );
    expect(h({ ...base, disable: ["entropy"] })).not.toBe(h(base));
    expect(h({ ...base, sensitive_files: [{ id: "f", globs: ["a.key"] }] })).not.toBe(h(base));
  });

  it("does not change with descriptions or test strings", () => {
    const h = (value: Record<string, unknown>) => compileRuleSet({ packs: [pack(value)] }).hash;
    expect(
      h({
        description: "new words",
        version: "9",
        rules: [
          { id: "acme-key", pattern: "ACME-\\d+", description: "b", tests: { match: ["ACME-1"] } },
        ],
      }),
    ).toBe(h(base));
  });

  it("names the built-in version", () => {
    const builtin = builtinPack();
    expect(compileRuleSet({ builtin: { ...builtin, version: "seshi/rules/99" } }).hash).not.toBe(
      compileRuleSet().hash,
    );
  });

  it("refuses a built-in pack that does not match the code", () => {
    const builtin = builtinPack();
    expect(
      problems(() =>
        compileRuleSet({
          builtin: { ...builtin, rules: builtin.rules.filter((r) => r.id !== "jwt") },
        }),
      ),
    ).toEqual(["pack builtin: jwt: is implemented in code but not in the pack"]);
    expect(
      problems(() =>
        compileRuleSet({
          builtin: {
            ...builtin,
            rules: [
              ...builtin.rules,
              { id: "new-one", patterns: [], implementation: "builtin", applies_to: ["text"] },
            ],
          },
        }),
      ),
    ).toEqual(["pack builtin: new-one: no code implements this rule"]);
  });
});

describe("runRuleTests", () => {
  it("reports each test string, the built-in pack's and the operator's", () => {
    const set = compileRuleSet({
      packs: [
        pack({
          rules: [{ id: "acme-key", pattern: "ACME-\\d+", tests: { match: ["ACME-1"] } }],
        }),
      ],
    });
    const operator = runRuleTests(set, { builtin: false });
    expect(operator).toEqual([
      { pack: "acme", rule: "acme-key", expect: "match", input: "ACME-1", ok: true },
    ]);
    expect(runRuleTests(set).length).toBeGreaterThan(operator.length);
  });
});

describe("the rules document (F2.4)", () => {
  const packs = [
    pack({
      disable: ["entropy"],
      rules: [{ id: "acme-key", pattern: "ACME-\\d+", tests: { match: ["ACME-1"] } }],
    }),
  ];

  it("serves the operator's packs and the rule-set hash", () => {
    const set = compileRuleSet({ packs });
    const doc = rulesDocument(set);
    expect(doc).toEqual({
      schema: REDACTION_RULES_SCHEMA,
      rule_set: set.hash,
      builtin: "seshi/rules/3",
      packs,
    });
  });

  it("rebuilds the server's rule set on a client, through JSON", () => {
    const set = compileRuleSet({ packs });
    const { rules, same } = ruleSetFromDocument(JSON.parse(JSON.stringify(rulesDocument(set))));
    expect(same).toBe(true);
    expect(rules.hash).toBe(set.hash);
  });

  it("says when the client's built-ins are not the server's", () => {
    const set = compileRuleSet({ packs, builtin: { ...builtinPack(), version: "seshi/rules/2" } });
    expect(ruleSetFromDocument(rulesDocument(set)).same).toBe(false);
  });

  it("validates what the server sent like any other pack", () => {
    expect(() => ruleSetFromDocument(null)).toThrow(/must be an object/);
    expect(() => ruleSetFromDocument({ schema: "x", packs: [] })).toThrow(
      /seshi\/redaction-rules\/1/,
    );
    expect(() =>
      ruleSetFromDocument({
        schema: REDACTION_RULES_SCHEMA,
        rule_set: "x",
        packs: [{ id: "evil", rules: [{ id: "x", pattern: "(a)\\1" }] }],
      }),
    ).toThrow(/RE2/);
    expect(() =>
      ruleSetFromDocument({ schema: REDACTION_RULES_SCHEMA, rule_set: "x", packs: [{ id: 3 }] }),
    ).toThrow(/server pack 0/);
  });
});
