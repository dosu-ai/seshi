import { describe, expect, it } from "vitest";
import { BUILTIN_PACK_TOML, BUILTIN_RULES_VERSION, builtinPack } from "./builtin";
import { compileRuleSet, runRuleTests } from "./ruleset";
import { BUILTIN_SECRET_KINDS, redactSecrets } from "./secrets";
import { builtinSecretCommands, builtinSensitiveFiles } from "./sensitive";

describe("the built-in pack (packs/builtin.toml)", () => {
  const pack = builtinPack();

  it("parses with the operator packs' parser and validator", () => {
    expect(pack.id).toBe("builtin");
    expect(pack.disable).toEqual([]);
  });

  it("is the version BUILTIN_RULES_VERSION names", () => {
    expect(pack.version).toBe(BUILTIN_RULES_VERSION);
  });

  it("lists every rule the code implements, once, in the order the code runs them", () => {
    const coded = pack.rules.filter((r) => r.implementation === "builtin").map((r) => r.id);
    expect(coded).toEqual(BUILTIN_SECRET_KINDS);
  });

  it("describes every rule", () => {
    const all = [...pack.rules, ...pack.sensitive_files, ...pack.secret_commands];
    expect(all.filter((r) => !r.description).map((r) => r.id)).toEqual([]);
  });

  it("holds the sensitive files and secret commands the sensitive-call pass uses", () => {
    expect(pack.sensitive_files.map((r) => r.id)).toEqual(["sensitive-file"]);
    expect(pack.secret_commands.map((r) => r.id)).toEqual(["secret-output"]);
    expect(builtinSensitiveFiles()).toContain(".env");
    expect(builtinSensitiveFiles()).toContain("!.env.example");
    expect(builtinSecretCommands()).toContain(String.raw`printenv\b`);
  });

  it("passes every one of its test strings", () => {
    const results = runRuleTests(compileRuleSet(), { operator: false });
    expect(results.length).toBeGreaterThan(40);
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("redacts what its test strings redact to itself, counting nothing the second time", () => {
    const inputs = pack.rules.flatMap((r) => r.tests?.match ?? []);
    for (const input of inputs) {
      const once = redactSecrets(input);
      expect(once.count, input).toBeGreaterThan(0);
      expect(redactSecrets(once.text), input).toEqual({ text: once.text, count: 0, counts: {} });
    }
  });

  it("has a test string for every rule but the fallback name", () => {
    const tested = new Set(runRuleTests(compileRuleSet(), { operator: false }).map((r) => r.rule));
    const all = [...pack.rules, ...pack.sensitive_files, ...pack.secret_commands].map((r) => r.id);
    expect(all.filter((id) => !tested.has(id))).toEqual(["provider-token"]);
  });

  it("holds no literal string a secret scanner would take for a provider token", () => {
    // Test strings spell such tokens' first character as a \u escape (see the file's header).
    for (const prefix of ["ghp_", "glpat-", "sk_live_", "sk-ant-", "xoxb-", "AIza", "npm_"]) {
      expect(BUILTIN_PACK_TOML).not.toMatch(new RegExp(`${prefix}[A-Za-z0-9]{10}`));
    }
  });
});
