import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { attachCalls } from "./calls";

const T1 = "2026-09-02T00:00:01.000Z";
const T2 = "2026-09-02T00:00:02.000Z";
const records = [
  { role: "meta", source: "x" },
  { role: "user", content: "hi", timestamp: T1 },
  { role: "assistant", content: "a", timestamp: T1 },
  { role: "reasoning", content: "r", timestamp: T2 },
  { role: "assistant", content: "b", timestamp: T2 },
] as NormalizedRecord[];

describe("attachCalls", () => {
  it("names the call on the assistant and reasoning records written when its lines were", () => {
    const out = attachCalls(records, {
      calls: [
        { id: "c1", model: "m1" },
        { id: "c2", model: "m2" },
        { id: "unused", model: "m3" },
      ],
      // A source timestamp in another spelling of the same moment still matches.
      sites: [
        { timestamp: "2026-09-02T00:00:01Z", call: "c1" },
        { timestamp: T2, call: "c2" },
      ],
    });
    expect(out.records.map((r) => (r as { llm_call?: string }).llm_call ?? null)).toEqual([
      null,
      null,
      "c1",
      "c2",
      "c2",
    ]);
    expect(out.llm_calls?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("names no call on a record written when lines of two calls were", () => {
    const out = attachCalls(records, {
      calls: [{ id: "c1" }, { id: "c2" }],
      sites: [
        { timestamp: T2, call: "c1" },
        { timestamp: T2, call: "c2" },
      ],
    });
    expect(out.records.some((r) => "llm_call" in r)).toBe(false);
    expect(out.llm_calls).toBeUndefined();
  });
});
