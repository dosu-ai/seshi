import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { validatePack } from "./pack";
import { ruleRedactor, ruleSetHash } from "./redactor";
import { redactionRules } from "./rules";
import { compileRuleSet } from "./ruleset";

const ts = "2026-11-14T09:00:00Z";
const meta = { role: "meta", source: "claude-code", git_branch: "feat/ABC-1234-x7Kq9" } as const;
const call = (id: string, name: string, args: unknown) =>
  ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, name, args: typeof args === "string" ? args : JSON.stringify(args) }],
    timestamp: ts,
  }) as NormalizedRecord;
const result = (id: string, content: string) =>
  ({ role: "tool", tool_call_id: id, content, timestamp: ts }) as NormalizedRecord;

describe("ruleRedactor", () => {
  it("withholds what a sensitive-file call returned and keeps only the path in its input", () => {
    const { records, withheld, summary } = ruleRedactor().redact([
      meta,
      call("toolu_1", "Read", { file_path: "/repo/.env" }),
      result("toolu_1", "STRIPE_PW=plainvalue"),
      call("toolu_2", "Write", { file_path: "/repo/.env", content: "A=b\nC=d" }),
      result("toolu_2", "ok"),
    ]);
    expect(records[2]).toEqual({
      role: "tool",
      tool_call_id: "toolu_1",
      content: "[redacted:sensitive-file]",
      timestamp: ts,
      withheld: "sensitive-file",
    });
    const write = records[3] as { tool_calls: { args: string }[] };
    expect(JSON.parse(write.tool_calls[0]?.args as string)).toEqual({
      file_path: "/repo/.env",
      content: "[redacted:sensitive-file]",
    });
    expect(withheld).toEqual({ toolu_1: "sensitive-file", toolu_2: "sensitive-file" });
    expect(summary.counts).toEqual({ "sensitive-file": 2 });
  });

  it("withholds a secret command's output but keeps the command", () => {
    const { records, summary } = ruleRedactor().redact([
      meta,
      call("c1", "Bash", { command: "gh auth token" }),
      result("c1", "gho_notreallyatokenbutwithheldanyway"),
    ]);
    expect((records[1] as { tool_calls: { args: string }[] }).tool_calls[0]?.args).toBe(
      JSON.stringify({ command: "gh auth token" }),
    );
    expect(records[2]).toMatchObject({
      content: "[redacted:secret-output]",
      withheld: "secret-output",
    });
    expect(summary.counts["secret-output"]).toBe(1);
  });

  it("withholds a result that comes after its call in a later chunk, from the carried ids", () => {
    const redactor = ruleRedactor();
    const first = redactor.redact([meta, call("toolu_env", "Read", { file_path: ".env" })]);
    expect(first.withheld).toEqual({ toolu_env: "sensitive-file" });
    const second = redactor.redact([result("toolu_env", "SECRET=1")], first.withheld);
    expect(second.records[0]).toMatchObject({ content: "[redacted:sensitive-file]" });
    // The call was counted where it was seen, not again.
    expect(second.summary.counts).toEqual({});
  });

  it("applies the operator's patterns and the built-in secrets to text, never to ids", () => {
    const redactor = ruleRedactor(redactionRules({ patterns: ["cust_[a-z0-9]{6}"] }));
    const id = "toolu_01HxQ7vB9kZ3mN8pR2sT5wY4";
    const { records, summary } = redactor.redact([
      meta,
      {
        role: "user",
        content: "customer cust_abc123, token ghp_abcdefghijklmnopqrstuvwxyz012345",
        timestamp: ts,
      },
      call(id, "Bash", { command: "echo cust_zzz999" }),
      result(id, "cust_zzz999"),
    ]);
    expect(records[0]).toEqual(meta);
    expect((records[1] as { content: string }).content).toBe(
      "customer [redacted:custom-pattern], token [redacted:github-token]",
    );
    expect((records[2] as { tool_calls: { id: string; args: string }[] }).tool_calls[0]).toEqual({
      id,
      name: "Bash",
      args: JSON.stringify({ command: "echo [redacted:custom-pattern]" }),
    });
    expect(records[3]).toMatchObject({ tool_call_id: id, content: "[redacted:custom-pattern]" });
    expect(summary.counts).toEqual({ "custom-pattern": 3, "github-token": 1 });
  });

  it("is deterministic and idempotent", () => {
    const redactor = ruleRedactor();
    const input = [
      meta,
      {
        role: "user",
        content: "aws_secret_access_key=abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        timestamp: ts,
      },
      call("t1", "Read", { file_path: "id_rsa" }),
      result("t1", "-----BEGIN"),
    ] as NormalizedRecord[];
    const once = redactor.redact(input);
    expect(redactor.redact(input).records).toEqual(once.records);
    const twice = redactor.redact(once.records);
    expect(twice.records).toEqual(once.records);
    expect(input[3]).toEqual(result("t1", "-----BEGIN")); // the input is not modified
  });

  it("names its rule set: the operator's rules change the hash", () => {
    const builtin = ruleRedactor();
    expect(builtin.rule_set).toMatch(/^[0-9a-f]{64}$/);
    expect(builtin.rule_set).toBe(ruleSetHash(redactionRules()));
    expect(ruleRedactor(redactionRules({ patterns: ["x{3}"] })).rule_set).not.toBe(
      builtin.rule_set,
    );
    expect(ruleRedactor(redactionRules({ sensitive_files: ["*.secret"] })).rule_set).not.toBe(
      builtin.rule_set,
    );
    expect(builtin.redact([meta]).summary).toEqual({ rule_set: builtin.rule_set, counts: {} });
  });
});

describe("ruleRedactor over packs", () => {
  const acme = validatePack(
    {
      id: "acme",
      disable: ["entropy"],
      rules: [
        { id: "row-id", pattern: "ROW-\\d+", applies_to: ["tool_output"] },
        { id: "arg-key", pattern: "--key=(?P<secret>\\S+)", applies_to: ["tool_input"] },
        { id: "codename", pattern: "(?i)project bluebird" },
      ],
      sensitive_files: [{ id: "acme-master", globs: ["config/master.key"] }],
      secret_commands: [{ id: "acme-token", pattern: "acme-cli\\s+token\\b" }],
    },
    { source: "acme.toml" },
  );
  const redactor = ruleRedactor(compileRuleSet({ packs: [acme] }));

  it("runs each text rule only where its applies_to says, and counts by rule id", () => {
    const { records, summary } = redactor.redact([
      meta,
      { role: "user", content: "ROW-1 for Project Bluebird", timestamp: ts },
      call("c1", "Bash", { command: "deploy --key=abc ROW-2" }),
      result("c1", "ROW-3 --key=def"),
    ]);
    expect(records[1]).toMatchObject({ content: "ROW-1 for [redacted:codename]" });
    expect(
      JSON.parse((records[2] as { tool_calls: { args: string }[] }).tool_calls[0]?.args ?? ""),
    ).toEqual({ command: "deploy --key=[redacted:arg-key] ROW-2" });
    expect(records[3]).toMatchObject({ content: "[redacted:row-id] --key=def" });
    expect(summary.counts).toEqual({ codename: 1, "arg-key": 1, "row-id": 1 });
  });

  it("counts a withheld call under the rule it met", () => {
    const { summary } = redactor.redact([
      meta,
      call("a", "Read", { file_path: "app/config/master.key" }),
      call("b", "Read", { file_path: ".env" }),
      call("c", "Bash", { command: "acme-cli token" }),
      call("d", "Bash", { command: "printenv" }),
      result("a", "x"),
    ]);
    expect(summary.counts).toEqual({
      "acme-master": 1,
      "sensitive-file": 1,
      "acme-token": 1,
      "secret-output": 1,
    });
  });

  it("leaves a built-in rule a pack turned off", () => {
    const { records } = redactor.redact([
      meta,
      { role: "user", content: "DEPLOY_CRED=aB3xY7pQ9zK2mN8vR4tWcD5f", timestamp: ts },
    ]);
    expect(records[1]).toMatchObject({ content: "DEPLOY_CRED=aB3xY7pQ9zK2mN8vR4tWcD5f" });
  });

  it("redacts one string outside the records as the rules treat its place", () => {
    expect(redactor.redactText?.("ROW-9 and Project Bluebird")).toEqual({
      text: "ROW-9 and [redacted:codename]",
      counts: { codename: 1 },
    });
    expect(redactor.redactText?.("ROW-9", "tool_output")).toEqual({
      text: "[redacted:row-id]",
      counts: { "row-id": 1 },
    });
  });
});
