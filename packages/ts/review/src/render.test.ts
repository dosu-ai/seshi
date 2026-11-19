import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { entriesOf, fieldText, partsOf } from "./render";

const ts = "2026-11-01T00:00:00Z";
const records = (...list: Record<string, unknown>[]) => list as unknown as NormalizedRecord[];
const user = (content: string) => ({ role: "user", content, timestamp: ts, id: "u-id" });
const reply = (content: string) => ({ role: "assistant", content, timestamp: ts });
const call = (id: string, args: string, name = "Bash") => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id, name, args }],
  timestamp: ts,
});
const result = (id: string, content: string) => ({
  role: "tool",
  tool_call_id: id,
  content,
  timestamp: ts,
});

describe("entriesOf", () => {
  it("shows only the text a reviewer judges, with roles and tool names", () => {
    const entries = entriesOf(
      records(
        { role: "meta", source: "claude-code", cwd: "/home/alice/secret-project" },
        user("fix the build"),
        call("c1", '{"command":"make"}'),
        result("c1", "ok"),
        reply(""),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", name: "Noop", args: "" }],
          timestamp: ts,
        },
      ),
    );
    expect(entries).toEqual([
      { record: 1, role: "user", field: "content", text: "fix the build" },
      {
        record: 2,
        role: "assistant",
        field: "tool_calls[0].args",
        text: '{"command":"make"}',
        tool: "Bash",
      },
      { record: 3, role: "tool", field: "content", text: "ok", tool: "Bash" },
    ]);
    // No ids, timestamps or meta fields leave the server.
    expect(JSON.stringify(entries)).not.toMatch(/u-id|2026-11-01|secret-project/);
  });
});

describe("partsOf", () => {
  it("keeps a short envelope in one part", () => {
    const parts = partsOf(records(user("a"), reply("b")), 10_000);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.map((e) => e.record)).toEqual([0, 1]);
  });

  it("splits by turn, packing whole turns while they fit (F3.7)", () => {
    const turn = (n: number) => [user(`question ${n} ${"q".repeat(300)}`), reply(`answer ${n}`)];
    const list = records(...turn(1), ...turn(2), ...turn(3));
    // Each turn is about 300 chars plus two entries' overhead; two fit in 1200, three do not.
    const parts = partsOf(list, 1_200);
    expect(parts.map((p) => p.map((e) => e.record))).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
  });

  it("packs a turn that alone does not fit field by field", () => {
    const list = records(user("x".repeat(500)), reply("y".repeat(500)), reply("z".repeat(500)));
    const parts = partsOf(list, 700);
    expect(parts.map((p) => p.map((e) => e.record))).toEqual([[0], [1], [2]]);
  });

  it("cuts a field that alone does not fit into overlapping windows of the same field", () => {
    const text = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(
      "",
    );
    const parts = partsOf(records(user(text)), 1_120);
    const pieces = parts.flat();
    expect(pieces.length).toBeGreaterThan(2);
    for (const piece of pieces) {
      expect(piece.field).toBe("content");
      expect(piece.text.length).toBeLessThanOrEqual(1_000);
      expect(text.includes(piece.text)).toBe(true);
    }
    expect(pieces.map((p) => p.part)).toEqual(pieces.map((_, i) => `${i + 1}/${pieces.length}`));
    // Consecutive windows overlap, so a value cut at a boundary is whole in one of them.
    const first = pieces[0]?.text as string;
    const second = pieces[1]?.text as string;
    expect(first.slice(-100)).toBe(second.slice(0, 100));
    // Every character is covered.
    const last = pieces.at(-1)?.text as string;
    expect(text.endsWith(last)).toBe(true);
  });

  it("has no parts when nothing has text", () => {
    expect(partsOf(records({ role: "meta", source: "x" }), 1_000)).toEqual([]);
  });
});

describe("fieldText", () => {
  it("reads content and tool call arguments by name", () => {
    const [a, b] = records(user("hi"), call("c1", "{}"));
    expect(fieldText(a as NormalizedRecord, "content")).toBe("hi");
    expect(fieldText(b as NormalizedRecord, "tool_calls[0].args")).toBe("{}");
    expect(fieldText(b as NormalizedRecord, "content")).toBeUndefined();
    expect(fieldText(b as NormalizedRecord, "tool_calls[1].args")).toBeUndefined();
    expect(fieldText(a as NormalizedRecord, "timestamp")).toBeUndefined();
  });
});
