import { describe, expect, it } from "vitest";
import { applyRules, parseRedactionConfig, RedactionConfigError, redactionRules } from "./rules";
import { compileRuleSet } from "./ruleset";

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");

describe("redactionRules", () => {
  it("is the built-in pack with nothing added", () => {
    const rules = redactionRules();
    expect(rules.packs).toEqual([]);
    expect(rules.text).toEqual([]);
    expect(rules.sensitive.files.include.length).toBeGreaterThan(10);
    expect(rules.sensitive.commands.length).toBeGreaterThan(10);
    expect(rules.hash).toBe(compileRuleSet().hash);
  });

  it("loads the lists as the legacy pack, the patterns as one rule, custom-pattern", () => {
    const rules = redactionRules({
      patterns: ["ACME-\\d+", "cust_[a-z0-9]{6}"],
      sensitive_files: ["config/master.key"],
      secret_commands: ["acme-cli\\s+token\\b"],
    });
    expect(rules.packs.map((p) => p.id)).toEqual(["legacy"]);
    expect(rules.text.map((r) => [r.id, r.matchers.length, r.replacement])).toEqual([
      ["custom-pattern", 2, "[redacted:custom-pattern]"],
    ]);
    expect(rules.files.map((r) => r.id)).toEqual(["custom-sensitive-files", "sensitive-file"]);
    expect(rules.commands.map((r) => r.id)).toEqual(["custom-secret-commands", "secret-output"]);
  });

  it("refuses, naming every one, patterns and commands that cannot be used", () => {
    try {
      redactionRules({ patterns: ["ok", "(", "a*"], secret_commands: ["["] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RedactionConfigError);
      const messages = (err as RedactionConfigError).problems.map((p) => p.message);
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatch(/pattern '\(' is not a usable RE2 pattern/);
      expect(messages[1]).toMatch(/pattern 'a\*' .*matches empty text/);
      expect(messages[2]).toMatch(/pattern '\[' is not a usable RE2 pattern/);
    }
  });

  it("refuses what RE2 cannot run: lookaround and backreferences (F2.2)", () => {
    expect(() => redactionRules({ patterns: ["(?<=key=)\\w+"] })).toThrow(
      /lookahead or lookbehind/,
    );
    expect(() => redactionRules({ patterns: ["(a)\\1"] })).toThrow(/backreferences/);
  });
});

describe("parseRedactionConfig", () => {
  it("reads the file Dosu's CLI writes, ignoring what is about the client", () => {
    const rules = parseRedactionConfig(
      JSON.stringify({
        patterns: ["ACME-\\d+"],
        sensitive_files: ["config/master.key"],
        excluded: ["acme/payments"],
        names_only: [],
        fetched_at: "2026-11-11T00:00:00Z",
      }),
    );
    expect(rules.text.flatMap((r) => r.matchers.map((m) => m.source))).toEqual(["ACME-\\d+"]);
  });

  it("refuses a misspelt field, a list that is not strings, and what is not JSON", () => {
    expect(() => parseRedactionConfig('{"sensitve_files": []}')).toThrow(/sensitve_files/);
    expect(() => parseRedactionConfig('{"patterns": [1]}')).toThrow(/list of strings/);
    expect(() => parseRedactionConfig("patterns:")).toThrow(RedactionConfigError);
    expect(() => parseRedactionConfig("[]")).toThrow(/must be an object/);
  });

  it("is the built-in pack alone for an empty file", () => {
    expect(parseRedactionConfig("{}").hash).toBe(compileRuleSet().hash);
  });
});

describe("applyRules", () => {
  it("withholds sensitive calls, then applies the custom patterns", () => {
    const rules = redactionRules({
      patterns: ["cust_[a-z0-9]{6}"],
      sensitive_files: ["config/master.key"],
    });
    const out = applyRules(
      jsonl(
        { type: "user", message: { content: "look up cust_abc123" } },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "m",
                name: "Read",
                input: { file_path: "app/config/master.key" },
              },
            ],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "m", content: "k3y" }] },
        },
      ),
      "jsonl",
      rules,
    );
    expect(out.text).toContain("look up [redacted:custom-pattern]");
    expect(out.text).not.toContain("k3y");
    expect(out.withheld).toEqual({ m: "sensitive-file" });
  });

  it("keeps a line with nothing to replace byte for byte, and leaves the built-ins to later", () => {
    const rules = redactionRules({ patterns: ["cust_[a-z0-9]{6}"] });
    const line = '{"type":"user",  "message":{"content":"ghp_abcdefghijklmnopqrstuvwx0123456789"}}';
    expect(applyRules(line, "jsonl", rules).text).toBe(line);
    const doc = JSON.stringify({ parts: [{ text: "cust_abc123" }] });
    expect(JSON.parse(applyRules(doc, "json", rules).text).parts[0].text).toBe(
      "[redacted:custom-pattern]",
    );
    expect(applyRules("not json cust_abc123", "jsonl", rules).text).toBe(
      "not json [redacted:custom-pattern]",
    );
  });
});
