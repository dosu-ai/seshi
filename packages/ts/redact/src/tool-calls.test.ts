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
});
