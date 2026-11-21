import { asTranscript } from "@seshi/formats";
import type { NormalizedRecord } from "@seshi/model";
import { describe, expect, it } from "vitest";
import { CODEX_FORMAT, withoutReasoningEvents } from "./index";

const SESSION = "019a0000-0000-7000-8000-0000000000aa";
const at = (n: number) => `2026-11-20T00:00:${String(n).padStart(2, "0")}.000Z`;
const line = (n: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at(n), type, payload });

const head = [
  line(0, "session_meta", { id: SESSION, timestamp: at(0), cwd: "/repo" }),
  line(0, "turn_context", { cwd: "/repo", model: "gpt-x" }),
  line(1, "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Count the files" }],
  }),
];
const summary = (n: number) =>
  line(n, "response_item", {
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Run ls first." }],
    encrypted_content: "gAAAA",
  });
const reasoningEvent = (n: number) =>
  line(n, "event_msg", { type: "agent_reasoning", text: "Run ls first." });
const tail = [
  line(3, "response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Two files." }],
  }),
  line(4, "event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
  }),
];

const records = (transcript: string, chunk?: { offset: number; session_id: string }) =>
  asTranscript(CODEX_FORMAT.normalize(transcript, chunk));

/** The log cut in two after `lines` lines, each part normalized as the chunk it would arrive as. */
function inChunks(log: string[], lines: number): NormalizedRecord[] {
  const first = `${log.slice(0, lines).join("\n")}\n`;
  const second = `${log.slice(lines).join("\n")}\n`;
  return [
    ...records(first, { offset: 0, session_id: SESSION }).records,
    ...records(second, { offset: Buffer.byteLength(first, "utf8"), session_id: SESSION }).records,
  ];
}

const reasoning = (all: readonly NormalizedRecord[]) => all.filter((r) => r.role === "reasoning");

describe("Codex reasoning", () => {
  const older = [...head, summary(2), reasoningEvent(2), ...tail];

  it("keeps a summary an older writer also wrote as an agent_reasoning event once", () => {
    expect(reasoning(records(`${older.join("\n")}\n`).records)).toHaveLength(1);
  });

  it("keeps it once when a chunk boundary falls between the summary and the event", () => {
    expect(reasoning(inChunks(older, head.length + 1))).toHaveLength(1);
  });

  it("keeps every other line's byte offset when it blanks the events", () => {
    const log = older.join("\n");
    const blanked = withoutReasoningEvents(log);
    expect(Buffer.byteLength(blanked, "utf8")).toBe(Buffer.byteLength(log, "utf8"));
    expect(blanked).not.toContain("agent_reasoning");
  });

  it("names the model call a newer writer's summary-only reasoning came from", () => {
    const newer = [...head, summary(2), ...tail];
    const out = records(`${newer.join("\n")}\n`);
    const [thought] = reasoning(out.records);
    expect(thought?.content).toBe("Run ls first.");
    expect((thought as { llm_call?: string } | undefined)?.llm_call).toBe(out.llm_calls?.[0]?.id);
    expect(out.llm_calls?.[0]?.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});
