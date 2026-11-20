import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { redactionRules, ruleRedactor } from "./index";
import { redactToolCallRecords, TOOL_CALL_MARKER, withToolCallsRedacted } from "./tool-calls";

const records = [
  { role: "meta", source: "trajectory" },
  { role: "user", content: "how many customers?" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", name: "Bash", args: '{"command":"psql -c count","timeout":30,"dry":false}' },
      { id: "c2", name: "Grep", args: "not json at all" },
      { id: "c3", name: "Noop", args: "" },
    ],
  },
  { role: "tool", tool_call_id: "c1", content: "4812 rows", ok: false },
  { role: "assistant", content: "There are 4812." },
] as unknown as NormalizedRecord[];

describe("the tool-call pass over records (redact_tool_calls)", () => {
  it("replaces calls' arguments and results, keeping ids, names, numbers and failure", () => {
    const { records: out, count } = redactToolCallRecords(records);
    expect(out[2]).toMatchObject({
      tool_calls: [
        {
          id: "c1",
          name: "Bash",
          args: `{"command":"${TOOL_CALL_MARKER}","timeout":30,"dry":false}`,
        },
        { id: "c2", name: "Grep", args: TOOL_CALL_MARKER },
        { id: "c3", name: "Noop", args: "" },
      ],
    });
    expect(out[3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: TOOL_CALL_MARKER,
      ok: false,
    });
    expect(out[1]).toBe(records[1]);
    expect(out[4]).toBe(records[4]);
    expect(count).toBe(3);
    // Again: nothing more to do.
    expect(redactToolCallRecords(out).count).toBe(0);
  });

  it("runs before the rules, under their rule set, and counts what it replaced", () => {
    const inner = ruleRedactor(redactionRules());
    const redactor = withToolCallsRedacted(inner);
    expect(redactor.rule_set).toBe(inner.rule_set);
    const out = redactor.redact(records);
    expect(out.summary.counts["tool-call"]).toBe(3);
    expect(JSON.stringify(out.records)).not.toContain("psql");
    expect(out.records[4]).toMatchObject({ content: "There are 4812." });
  });

  it("takes out what tools and the person's commands returned in what was said for them", () => {
    const said = [
      {
        role: "user",
        content: "<bash-input>cat .env</bash-input><bash-stdout>KEY=1</bash-stdout>",
      },
      {
        role: "observation",
        content: "<task-notification><result>KEY=2</result></task-notification>",
      },
      {
        role: "user",
        content:
          "<user_shell_command><command>ls</command><result>secret.txt</result></user_shell_command>",
      },
      { role: "user", content: "a plain prompt" },
      { role: "assistant", content: "a reply quoting KEY=3" },
    ] as unknown as NormalizedRecord[];
    const { records: out, count } = redactToolCallRecords(said);
    expect(out.map((r) => (r as { content: string }).content)).toEqual([
      `<bash-input>cat .env</bash-input><bash-stdout>${TOOL_CALL_MARKER}</bash-stdout>`,
      `<task-notification>${TOOL_CALL_MARKER}</task-notification>`,
      `<user_shell_command><command>ls</command><result>${TOOL_CALL_MARKER}</result></user_shell_command>`,
      "a plain prompt",
      "a reply quoting KEY=3",
    ]);
    expect(count).toBe(3);
  });

  it("blanks everything a subagent's session said", () => {
    const { records: out } = redactToolCallRecords(records, { subagent: true });
    expect(out[1]).toMatchObject({ content: TOOL_CALL_MARKER });
    expect(out[4]).toMatchObject({ content: TOOL_CALL_MARKER });
    expect(out[0]).toBe(records[0]);
  });

  it("keeps arguments a laptop already redacted as written, however they are spaced", () => {
    const sent = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", name: "Read", args: `{"path": "${TOOL_CALL_MARKER}", "n": 1.0}` },
          { id: "c2", name: "Grep", args: TOOL_CALL_MARKER },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: TOOL_CALL_MARKER },
    ] as unknown as NormalizedRecord[];
    const { records: out, count } = redactToolCallRecords(sent);
    expect(out[0]).toBe(sent[0]);
    expect(out[1]).toBe(sent[1]);
    expect(count).toBe(0);
  });
});
