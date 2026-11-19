/** Span history stored once (F4.4, revised 15 Nov 2026; 22): the span store keeps each input
 * message once per session and the assembler reads the records back streamed, and the session
 * it publishes is byte for byte what assembling the same parts in memory gives, which is what
 * the assembler published when every record held its whole input. Crosses formats, the
 * integrations, the pipeline and the store, so it lives in tests/ (X3.6). */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readExportRequest } from "@seshi/formats";
import {
  ENVELOPE_SCHEMA,
  type Envelope,
  type ReceivedSpan,
  type SpanPart,
  type SpanResource,
} from "@seshi/model";
import {
  assemblePending,
  MemoryHealthCounters,
  Pipeline,
  redactSpanPart,
  SpanStore,
} from "@seshi/pipeline";
import { ruleRedactor } from "@seshi/redact";
import { archiveId, FsStore, keys, listSpanMessages } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../tooling/testdata";

const FIXTURES = join(ROOT, "integrations", "claude-platform", "testdata", "otlp");
const OWNER = "svc:console";
const FORMAT = "otlp-genai";
const formats = buildFormats();
const adapter = formats.get(FORMAT)?.spans as NonNullable<
  ReturnType<typeof formats.get>
>["spans"] & {};

let dir: string;
let store: FsStore;
let clock: Date;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-span-history-"));
  store = new FsStore(dir);
  clock = new Date("2026-11-01T10:00:00Z");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Batch {
  key: string;
  spans: ReceivedSpan[];
  resource: SpanResource;
}

/** An OTLP export's spans, one batch per session and resource, as the receiver groups them. */
function batchesOf(request: unknown): Batch[] {
  const out: Batch[] = [];
  for (const group of readExportRequest(request).groups) {
    const bySession = new Map<string, ReceivedSpan[]>();
    for (const span of group.spans) {
      const key = adapter.sessionKey(span, group.resource);
      bySession.set(key, [...(bySession.get(key) ?? []), span]);
    }
    for (const [key, spans] of bySession) out.push({ key, spans, resource: group.resource });
  }
  return out;
}

/** What assembling the sessions in memory gives: each span normalized and redacted as the
 * pipeline does on arrival, through JSON (as a record at rest), then the format's assembler. */
function inMemory(batches: readonly Batch[]): Record<string, string> {
  const redactor = ruleRedactor();
  const parts = new Map<string, SpanPart[]>();
  for (const batch of batches) {
    for (const span of batch.spans) {
      const { part } = redactSpanPart(redactor, adapter.normalize(span, batch.resource));
      const list = parts.get(batch.key) ?? [];
      list.push(JSON.parse(JSON.stringify(part)));
      parts.set(batch.key, list);
    }
  }
  const out: Record<string, string> = {};
  for (const [key, list] of parts) {
    const { records, llm_calls } = adapter.assemble(list, { source: FORMAT });
    out[key] = JSON.stringify({ records, llm_calls });
  }
  return out;
}

/** What the assembler publishes once the batches are in the span store. */
async function throughTheStore(batches: readonly Batch[]): Promise<Record<string, string>> {
  const now = () => clock;
  const pipeline = new Pipeline({
    store,
    formats,
    now,
    assembler: new SpanStore({ store, now }),
    health: new MemoryHealthCounters(),
    filter: { enabled: false, min_chars: 0, require_user: false, require_reply: false },
  });
  let n = 0;
  for (const batch of batches) {
    const envelope: Envelope = {
      schema: ENVELOPE_SCHEMA,
      source: "otlp",
      source_id: "console",
      format: FORMAT,
      session_key: batch.key,
      payload: {
        kind: "spans",
        spans: batch.spans as unknown as Record<string, unknown>[],
        resource: batch.resource as unknown as Record<string, unknown>[],
      },
      caller: { kind: "service", principal: OWNER, credential_id: "tok1" },
      owner: OWNER,
      owner_basis: "service",
      idempotency_key: `batch-${n++}`,
      received_at: clock.toISOString(),
    };
    expect((await pipeline.submit(envelope)).status).toBe("accepted");
  }
  clock = new Date(clock.getTime() + 60 * 60_000);
  const out: Record<string, string> = {};
  const report = await assemblePending({
    store,
    formats,
    publish: (session) => {
      const { records, llm_calls } = session;
      out[session.envelope.session_key] = JSON.stringify({ records, llm_calls });
      return pipeline.publishAssembled(session);
    },
    quietMs: () => 10 * 60_000,
    now,
  });
  expect(report.errors).toBe(0);
  return out;
}

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.otlp.json`), "utf8"));

const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
const ns = (sec: number) =>
  (BigInt(Date.parse("2026-11-01T10:00:00Z") + sec * 1000) * 1_000_000n).toString();
const text = (role: string, content: string) => ({ role, parts: [{ type: "text", content }] });

/** A long chat session sent a span per batch, with what the assembler has to get right: a
 * history that repeats, a system prompt that changes, reasoning that clients drop from history,
 * an input whose earliest messages were cut, a tool call and its span, and a second thread. */
function longSession(calls: number): Batch[] {
  const history: unknown[] = [];
  const batches: Batch[] = [];
  let span = 0;
  const chat = (thread: string, input: unknown[], output: unknown[], system?: string) => {
    span++;
    return {
      traceId: "ab".repeat(16),
      spanId: span.toString(16).padStart(16, "0"),
      name: "chat claude",
      startTimeUnixNano: ns(span * 10),
      endTimeUnixNano: ns(span * 10 + 5),
      attributes: [
        attr("gen_ai.operation.name", "chat"),
        attr("gen_ai.conversation.id", thread),
        attr("gen_ai.request.model", "claude"),
        ...(system ? [attr("gen_ai.system_instructions", system)] : []),
        attr("gen_ai.input.messages", JSON.stringify(input)),
        attr("gen_ai.output.messages", JSON.stringify(output)),
        { key: "gen_ai.usage.input_tokens", value: { intValue: 10 + span } },
      ],
    };
  };
  for (let i = 0; i < calls; i++) {
    history.push(text("user", `question ${i}: ${"what next ".repeat(20)}`));
    const answer =
      i % 5 === 2
        ? {
            role: "assistant",
            parts: [
              { type: "reasoning", content: `thinking about ${i}` },
              { type: "tool_call", id: `call-${i}`, name: "bash", arguments: { cmd: `ls ${i}` } },
            ],
          }
        : text("assistant", `answer ${i}: ${"here it is ".repeat(20)}`);
    const system = i < calls / 2 ? "You are helpful." : "You are terse.";
    // From the middle on, the client cuts the two earliest messages to fit.
    const sent = i > calls / 2 ? history.slice(2) : [...history];
    batches.push({
      key: "conv-main",
      spans: [chat("conv-main", sent, [answer], system) as unknown as ReceivedSpan],
      resource: [],
    });
    // Clients often drop reasoning from the history they send again.
    history.push(
      answer.role === "assistant" && "parts" in answer
        ? { ...answer, parts: answer.parts.filter((p) => p.type !== "reasoning") }
        : answer,
    );
    if (i % 5 === 2) {
      history.push({
        role: "tool",
        parts: [{ type: "tool_call_response", id: `call-${i}`, response: `file-${i}` }],
      });
      span++;
      batches.push({
        key: "conv-main",
        spans: [
          {
            traceId: "ab".repeat(16),
            spanId: span.toString(16).padStart(16, "0"),
            name: "execute_tool bash",
            startTimeUnixNano: ns(span * 10),
            endTimeUnixNano: ns(span * 10 + 2),
            attributes: [
              attr("gen_ai.operation.name", "execute_tool"),
              attr("gen_ai.tool.name", "bash"),
              attr("gen_ai.tool.call.id", `call-${i}`),
              attr("gen_ai.conversation.id", "conv-main"),
            ],
          } as unknown as ReceivedSpan,
        ],
        resource: [],
      });
    }
    if (i % 7 === 0) {
      batches.push({
        key: "conv-main",
        spans: [
          chat(
            "conv-side",
            [text("user", `side ${i}`)],
            [text("assistant", `side answer ${i}`)],
          ) as unknown as ReceivedSpan,
        ],
        resource: [],
      });
    }
  }
  return batches;
}

describe("span history stored once: the assembled session is unchanged (22)", () => {
  it.each(["managed-agents-session", "messages-tool-runner"])(
    "publishes %s byte for byte as assembling it in memory does",
    async (name) => {
      const batches = batchesOf(fixture(name));
      const expected = inMemory(batches);
      expect(Object.keys(expected).length).toBeGreaterThan(0);
      expect(await throughTheStore(batches)).toEqual(expected);
    },
  );

  it("publishes a long session byte for byte, with each input message stored once", async () => {
    const calls = 40;
    const batches = longSession(calls);
    const expected = inMemory(batches);
    expect(await throughTheStore(batches)).toEqual(expected);
    // Messages grow with the calls, not with the calls times the history.
    const archive = archiveId(OWNER, FORMAT, "conv-main");
    const messages = await listSpanMessages(store, OWNER, archive);
    expect(messages.size).toBeGreaterThan(calls);
    expect(messages.size).toBeLessThan(5 * calls);
    const listed = await store.list(keys.spans(OWNER, archive), { limit: 10_000 });
    expect(listed.keys.length).toBe(batches.length + messages.size);
  });
});
