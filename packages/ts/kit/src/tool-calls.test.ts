import { describe, expect, it } from "vitest";
import { byType, redactRecords, redactTagBodies, reshape, TOOL_CALL_MARKER } from "./tool-calls";

describe("the tool-call redaction helpers", () => {
  it("replaces a tag's body, closed or cut short, and keeps an empty one", () => {
    expect(redactTagBodies("<out>secret</out> kept <out></out>", ["out"])).toBe(
      `<out>${TOOL_CALL_MARKER}</out> kept <out></out>`,
    );
    expect(redactTagBodies("kept <out>secret, cut short", ["out"])).toBe(
      `kept <out>${TOOL_CALL_MARKER}`,
    );
  });

  it("never takes an inherited key for a field or kind it names", () => {
    const record = { type: "constructor", toString: "secret", constructor: "secret" };
    expect(reshape(record, { keep: ["type"], walk: {} })).toEqual({
      type: "constructor",
      toString: TOOL_CALL_MARKER,
      constructor: TOOL_CALL_MARKER,
    });
    const pass = byType({ text: { keep: ["type", "text"] } }, { keep: ["type"] });
    expect(pass({ type: "toString", body: "secret" })).toEqual({
      type: "toString",
      body: TOOL_CALL_MARKER,
    });
    expect(pass({ type: "text", text: "kept" })).toEqual({ type: "text", text: "kept" });
  });

  it("writes one line out per line in", () => {
    const text = '{"a": 1}\n\nnot json\n';
    expect(redactRecords(text, "jsonl", (r) => r)).toBe(
      `{"a":1}\n\n${JSON.stringify(TOOL_CALL_MARKER)}\n`,
    );
  });
});
