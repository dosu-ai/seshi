import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { validatePack } from "./pack";
import { ruleRedactor } from "./redactor";
import { compileRuleSet } from "./ruleset";
import { redactTranscript } from "./transcript";

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const GITHUB = "ghp_abcdefghijklmnopqrstuvwx0123456789";

const rules = compileRuleSet({
  packs: [
    validatePack(
      {
        id: "acme",
        rules: [{ id: "row-id", pattern: "ROW-\\d+", applies_to: ["tool_output"] }],
        sensitive_files: [{ id: "acme-master", globs: ["config/master.key"] }],
      },
      { source: "acme.toml" },
    ),
  ],
});

describe("redactTranscript (client pre-redaction, F2.4)", () => {
  it("runs every pass over a native transcript and counts by rule id", () => {
    const transcript = jsonl(
      { type: "user", uuid: "u1", message: { role: "user", content: `push ${GITHUB} ROW-7` } },
      {
        type: "assistant",
        uuid: "u2",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_01AbCdEfGhJkLmNpQrStUvWxYz",
              name: "Read",
              input: { file_path: "app/config/master.key" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "u3",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01AbCdEfGhJkLmNpQrStUvWxYz",
              content: "master-key-material",
            },
          ],
        },
      },
    );
    const out = redactTranscript(rules, transcript, "jsonl");
    const rows = out.text.split("\n").map((l) => JSON.parse(l));
    // Pre-redaction does not know where a string sits, so a rule runs on every string.
    expect(rows[0].message.content).toBe("push [redacted:github-token] [redacted:row-id]");
    expect(rows[1].message.content[0].id).toBe("toolu_01AbCdEfGhJkLmNpQrStUvWxYz");
    expect(rows[2].message.content[0].tool_use_id).toBe("toolu_01AbCdEfGhJkLmNpQrStUvWxYz");
    expect(out.text).not.toContain("master-key-material");
    expect(out.withheld).toEqual({ toolu_01AbCdEfGhJkLmNpQrStUvWxYz: "sensitive-file" });
    expect(out.summary).toEqual({
      rule_set: rules.hash,
      counts: { "github-token": 1, "row-id": 1, "acme-master": 1 },
    });
  });

  it("never touches ids, even ones the entropy rule would take for a secret", () => {
    const id = "aB3xY7pQ9zK2mN8vR4tWcD5fGh6JkL1m";
    const line = JSON.stringify({
      type: "user",
      sessionId: id,
      uuid: id,
      gitBranch: id,
      message: { content: id },
    });
    const row = JSON.parse(redactTranscript(rules, line, "jsonl").text);
    expect([row.sessionId, row.uuid, row.gitBranch]).toEqual([id, id, id]);
    expect(row.message.content).toBe("[redacted:entropy]");
  });

  it("redacts a tool call's input as the server redacts its args, framing keys included", () => {
    const input = {
      name: "AKIAIOSFODNN7EXAMPLQ",
      type: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      source: GITHUB,
      password: "hunter2hunter2hunter2",
    };
    const line = JSON.stringify({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__db", input }] },
    });
    const out = redactTranscript(compileRuleSet(), line, "jsonl");
    const block = JSON.parse(out.text).message.content[0];
    // The call's own framing still links and names it.
    expect([block.id, block.name, block.type]).toEqual(["toolu_1", "mcp__db", "tool_use"]);
    // What the server stores for the same call: its input as one string, redacted whole.
    const server = ruleRedactor(compileRuleSet()).redact([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_1", name: "mcp__db", args: JSON.stringify(input) }],
      } as unknown as NormalizedRecord,
    ]);
    const stored = (server.records[0] as { tool_calls: { args: string }[] }).tool_calls[0];
    expect(JSON.stringify(block.input)).toBe(stored?.args);
    for (const secret of Object.values(input)) expect(out.text).not.toContain(secret);
    expect(out.summary.counts).toEqual(server.summary.counts);
  });

  it("redacts each string of an input when a match spans its JSON", () => {
    // The URL-credential password runs to the last '@', across quotes and a closing brace, so
    // the redacted JSON no longer parses; every string, `name` included, is redacted on its own.
    const input = { a: { url: "http://u:p" }, name: GITHUB, b: "x@y" };
    const line = JSON.stringify({ type: "assistant", message: { content: [{ input }] } });
    const block = JSON.parse(redactTranscript(rules, line, "jsonl").text).message.content[0];
    expect(block.input).toEqual({
      a: { url: "http://u:p" },
      name: "[redacted:github-token]",
      b: "x@y",
    });
  });

  it("keeps the bytes of lines with nothing to redact, and blank lines and the last newline", () => {
    const clean = '{"type":"user",   "message":{"content":"hello"}}';
    const transcript = `${clean}\n\n${JSON.stringify({ text: GITHUB })}\n`;
    const out = redactTranscript(rules, transcript, "jsonl");
    expect(out.text).toBe(`${clean}\n\n{"text":"[redacted:github-token]"}\n`);
    expect(redactTranscript(rules, out.text, "jsonl").text).toBe(out.text);
  });

  it("redacts a whole JSON document, and a line that is not JSON as text", () => {
    const doc = JSON.stringify({ info: { id: "s1" }, messages: [{ parts: [{ text: GITHUB }] }] });
    expect(JSON.parse(redactTranscript(rules, doc, "json").text).messages[0].parts[0].text).toBe(
      "[redacted:github-token]",
    );
    expect(redactTranscript(rules, `not json ${GITHUB}`, "jsonl").text).toBe(
      "not json [redacted:github-token]",
    );
  });

  it("withholds a result in a later chunk from the carried ids, counting the call once", () => {
    const call = jsonl({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "m", name: "Read", input: { file_path: ".env" } }],
      },
    });
    const first = redactTranscript(rules, call, "jsonl");
    expect(first.summary.counts).toEqual({ "sensitive-file": 1 });
    const again = redactTranscript(rules, call, "jsonl", first.withheld);
    expect(again.summary.counts).toEqual({});
    const result = jsonl({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "m", content: "A=1" }] },
    });
    expect(redactTranscript(rules, result, "jsonl", first.withheld).text).not.toContain("A=1");
  });
});
