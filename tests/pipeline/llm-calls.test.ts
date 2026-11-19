/** Log adapters keep what each model call cost (X6.2): raw is not stored (X6.3), so the
 * token usage and the model of every turn must reach the stored trace from a Claude Code or
 * Codex log, whether it arrives whole or in chunks. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmCall } from "@seshi/model";
import { getSession, getTrace, storeSession } from "@seshi/pipeline";
import { archiveId, FsStore } from "@seshi/store";
import { buildFormats } from "seshi/integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { golden, transcript } from "../tooling/testdata";

const formats = buildFormats();
const owner = "acme";
// The fixtures are short: the session filter (X4.10) is not what these tests are about.
const filter = { enabled: false, min_chars: 0, require_user: false, require_reply: false };

let dir: string;
let store: FsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seshi-llm-calls-"));
  store = new FsStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every stored trace of a session, head first. */
async function tracesOf(agent: string, sessionId: string) {
  const session = await getSession(store, owner, agent, sessionId);
  const archive = archiveId(owner, agent, sessionId);
  const refs = session?.traces ?? [];
  return Promise.all(refs.map((ref) => getTrace(store, owner, archive, ref.content_hash)));
}

/** The calls each assistant or reasoning record names, in order. */
function namedCalls(traces: Awaited<ReturnType<typeof tracesOf>>) {
  const calls = new Map<string, LlmCall>();
  for (const trace of traces) for (const call of trace?.llm_calls ?? []) calls.set(call.id, call);
  return traces
    .flatMap((trace) => trace?.records ?? [])
    .filter((r) => r.role === "assistant" || r.role === "reasoning")
    .map((r) => {
      const id = (r as { llm_call?: string }).llm_call;
      return id === undefined
        ? null
        : { id, model: calls.get(id)?.model, usage: calls.get(id)?.usage };
    });
}

describe("LLM calls from a log", () => {
  it("stores a Claude Code session's usage and the model of each turn", async () => {
    const result = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: "usage-whole",
        transcript: transcript("claude-usage.claude-code.jsonl"),
        format: "jsonl",
      },
      { store, formats, filter },
    );
    expect(result.status).toBe("stored");
    const [head] = await tracesOf("claude-code", "usage-whole");
    expect(head?.llm_calls).toEqual(golden("claude-usage.llm_calls.json"));
    expect(head?.llm_calls?.map((c) => c.model)).toEqual(["claude-opus-9", "claude-haiku-9"]);
    expect(head?.llm_calls?.[0]?.usage).toEqual({
      input_tokens: 1234,
      output_tokens: 56,
      cache_read_input_tokens: 789,
      cache_creation_input_tokens: 10,
    });
    // The error Claude Code shows as a reply was no model call.
    expect(namedCalls([head]).at(-1)).toBeNull();
  });

  it("keeps them when the log arrives in chunks", async () => {
    const log = transcript("claude-usage.claude-code.jsonl");
    const lines = log.split("\n");
    // Cut inside the first request: its text line in the head, its tool call in the chunk.
    const head = `${lines.slice(0, 2).join("\n")}\n`;
    const tail = lines.slice(2).join("\n");
    const first = await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: "usage-chunks",
        transcript: head,
        format: "jsonl",
      },
      { store, formats, filter },
    );
    await storeSession(
      {
        owner,
        agent: "claude-code",
        session_id: "usage-chunks",
        transcript: tail,
        format: "jsonl",
        offset: first.bytes_total,
      },
      { store, formats, filter },
    );
    const traces = await tracesOf("claude-code", "usage-chunks");
    expect(traces).toHaveLength(2);
    const whole = await storeSession(
      { owner, agent: "claude-code", session_id: "usage-one", transcript: log, format: "jsonl" },
      { store, formats, filter },
    );
    expect(whole.status).toBe("stored");
    const ids = namedCalls(traces).map((c) => c?.id ?? null);
    expect(ids).toEqual(
      namedCalls(await tracesOf("claude-code", "usage-one")).map((c) => c?.id ?? null),
    );
    expect(ids).toEqual(["req_011CUsage0001", "req_011CUsage0001", "req_011CUsage0002", null]);
    expect(namedCalls(traces)[2]).toMatchObject({ model: "claude-haiku-9" });
  });

  it("stores a Codex rollout's token counts against the turns they count", async () => {
    await storeSession(
      {
        owner,
        agent: "codex",
        session_id: "01a0ff74-0000-7ad0-83ee-000000000001",
        transcript: transcript("codex-usage.codex.jsonl"),
        format: "jsonl",
      },
      { store, formats, filter },
    );
    const [head] = await tracesOf("codex", "01a0ff74-0000-7ad0-83ee-000000000001");
    expect(head?.llm_calls).toEqual(golden("codex-usage.llm_calls.json"));
    expect(namedCalls([head]).map((c) => c?.model)).toEqual([
      "gpt-9-codex",
      "gpt-9-codex",
      "gpt-9-codex",
      "gpt-9-codex-mini",
    ]);
  });
});
