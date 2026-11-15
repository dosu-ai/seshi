import { describe, expect, it } from "vitest";
import { Attributes } from "./attributes";
import {
  argsOf,
  flattenedMessages,
  jsonAttribute,
  messagesRecords,
  systemRecords,
  textOf,
} from "./messages";

const ts = "2026-11-01T10:00:00.000Z";
const ctx = { timestamp: ts, idPrefix: "span1" };

describe("GenAI messages → records", () => {
  it("reads the conventions' parts: text, tool calls, results and reasoning", () => {
    const records = messagesRecords(
      JSON.stringify([
        { role: "system", parts: [{ type: "text", content: "Be brief." }] },
        { role: "user", parts: [{ type: "text", content: "Weather?" }] },
        {
          role: "assistant",
          parts: [
            { type: "reasoning", content: "Need the tool." },
            { type: "text", content: "Checking." },
            { type: "tool_call", id: "t1", name: "get_weather", arguments: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "tool_call_response", id: "t1", response: [{ type: "text", text: "18°C" }] },
            { type: "text", content: "And tomorrow?" },
          ],
        },
        { role: "tool", parts: [{ type: "tool_call_response", id: "t2", response: { ok: 1 } }] },
      ]),
      ctx,
    );
    expect(records).toEqual([
      { role: "system", content: "Be brief.", timestamp: ts },
      { role: "user", content: "Weather?", timestamp: ts },
      { role: "reasoning", content: "Need the tool.", timestamp: ts },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [{ id: "t1", name: "get_weather", args: '{"city":"Paris"}' }],
        timestamp: ts,
      },
      { role: "tool", tool_call_id: "t1", content: "18°C", timestamp: ts },
      { role: "user", content: "And tomorrow?", timestamp: ts },
      { role: "tool", tool_call_id: "t2", content: '{"ok":1}', timestamp: ts },
    ]);
  });

  it("writes parts that are not text as their type, and keeps an assistant without text", () => {
    const records = messagesRecords(
      [
        {
          role: "user",
          parts: [
            { type: "text", content: "Look:" },
            { type: "anthropic_image" },
            { type: "blob", modality: "image", mime_type: "image/png" },
          ],
        },
        { role: "assistant", parts: [{ type: "tool_call", name: "bash", arguments: "ls" }] },
      ],
      ctx,
    );
    expect(records[0]).toEqual({ role: "user", content: "Look:\n[image]\n[image]", timestamp: ts });
    expect(records[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "span1#0", name: "bash", args: "ls" }],
      timestamp: ts,
    });
  });

  it("reads OpenAI-style and Anthropic-style messages", () => {
    expect(
      messagesRecords(
        [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", function: { name: "f", arguments: '{"a":1}' } }],
          },
          { role: "tool", tool_call_id: "c1", content: "done" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "ok" },
              { type: "tool_use", id: "u1", name: "Read", input: { path: "a" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "u1", content: "x", is_error: true }],
          },
        ],
        ctx,
      ),
    ).toEqual([
      { role: "user", content: "hi", timestamp: ts },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", name: "f", args: '{"a":1}' }],
        timestamp: ts,
      },
      { role: "tool", tool_call_id: "c1", content: "done", timestamp: ts },
      { role: "reasoning", content: "hmm", timestamp: ts },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [{ id: "u1", name: "Read", args: '{"path":"a"}' }],
        timestamp: ts,
      },
      { role: "tool", tool_call_id: "u1", content: "x", ok: false, timestamp: ts },
    ]);
  });

  it("reads a bare string as the user's, and ignores what is not JSON or empty", () => {
    expect(messagesRecords("plain prompt", ctx)).toEqual([
      { role: "user", content: "plain prompt", timestamp: ts },
    ]);
    expect(messagesRecords("", ctx)).toEqual([]);
    expect(messagesRecords(undefined, ctx)).toEqual([]);
    expect(messagesRecords("[not json", ctx)).toEqual([
      { role: "user", content: "[not json", timestamp: ts },
    ]);
  });

  it("reads system instructions as one system record", () => {
    expect(
      systemRecords('[{"type":"text","content":"A"},{"type":"text","content":"B"}]', ts),
    ).toEqual([{ role: "system", content: "A\nB", timestamp: ts }]);
    expect(systemRecords("Just text", ts)).toEqual([
      { role: "system", content: "Just text", timestamp: ts },
    ]);
    expect(systemRecords("  ", ts)).toEqual([]);
  });

  it("reads the flattened gen_ai.prompt.<i>.* form in index order", () => {
    const attrs = new Attributes([
      { key: "gen_ai.prompt.1.role", value: { stringValue: "assistant" } },
      { key: "gen_ai.prompt.1.tool_calls.0.name", value: { stringValue: "f" } },
      { key: "gen_ai.prompt.1.tool_calls.0.id", value: { stringValue: "c9" } },
      { key: "gen_ai.prompt.1.tool_calls.0.arguments", value: { stringValue: "{}" } },
      { key: "gen_ai.prompt.0.role", value: { stringValue: "user" } },
      { key: "gen_ai.prompt.0.content", value: { stringValue: "first" } },
      { key: "gen_ai.prompt.2.role", value: { stringValue: "tool" } },
      { key: "gen_ai.prompt.2.tool_call_id", value: { stringValue: "c9" } },
      { key: "gen_ai.prompt.2.content", value: { stringValue: "out" } },
      { key: "gen_ai.prompt.x.content", value: { stringValue: "ignored" } },
    ]);
    expect(messagesRecords(flattenedMessages(attrs, "gen_ai.prompt"), ctx)).toEqual([
      { role: "user", content: "first", timestamp: ts },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c9", name: "f", args: "{}" }],
        timestamp: ts,
      },
      { role: "tool", tool_call_id: "c9", content: "out", timestamp: ts },
    ]);
  });
});

describe("helpers", () => {
  it("textOf reads content blocks as their text, other values as JSON", () => {
    expect(
      textOf([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
    expect(textOf([{ type: "image" }])).toBe("[image]");
    expect(textOf({ k: 1 })).toBe('{"k":1}');
    expect(textOf(null)).toBe("");
  });

  it("argsOf keeps strings and writes objects as JSON", () => {
    expect(argsOf('{"a":1}')).toBe('{"a":1}');
    expect(argsOf({ a: 1 })).toBe('{"a":1}');
    expect(argsOf(undefined)).toBe("{}");
  });

  it("jsonAttribute parses JSON strings and leaves other text", () => {
    expect(jsonAttribute('{"a":1}')).toEqual({ a: 1 });
    expect(jsonAttribute("text")).toBe("text");
    expect(jsonAttribute("")).toBeUndefined();
    expect(jsonAttribute(["x"])).toEqual(["x"]);
  });
});
