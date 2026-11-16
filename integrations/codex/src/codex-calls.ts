/** What each model call in a Codex rollout cost, which `@letta-ai/trajectory` drops.
 *
 * Codex writes a `token_count` event after each model response, with that response's usage in
 * `info.last_token_usage` (input, cached input, output, reasoning output and total tokens), and
 * a `turn_context` at the start of each turn naming the model. The lines a response wrote (its
 * messages, tool calls and reasoning) come before its `token_count`, so each `token_count`
 * closes a call over the model's lines since the previous one in the turn. A rollout line has
 * no id, so a call is named by where its `token_count` sits in the log (`call@<byte offset>`,
 * counted from the log's start for a chunk too), the same whether the log arrives whole or in
 * chunks. Lines whose `token_count` is not in the text read (a chunk cut mid-response) name no
 * call; Codex's notify fires when a turn completes, after its counts are written. */

import type { CallSite, SourceCalls } from "@seshi/formats";
import type { Chunk, JsonObject, LlmCall, TokenUsage } from "@seshi/model";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const MODEL_ITEMS = new Set([
  "function_call",
  "custom_tool_call",
  "web_search_call",
  "tool_search_call",
]);

const USAGE_KEYS: readonly [string, keyof TokenUsage][] = [
  ["input_tokens", "input_tokens"],
  ["cached_input_tokens", "cache_read_input_tokens"],
  ["output_tokens", "output_tokens"],
  ["reasoning_output_tokens", "reasoning_tokens"],
  ["total_tokens", "total_tokens"],
];

function usageOf(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const usage: TokenUsage = {};
  for (const [from, to] of USAGE_KEYS) {
    const n = value[from];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) usage[to] = n;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function isModelLine(type: unknown, payload: JsonObject): boolean {
  if (type === "event_msg") return payload.type === "agent_reasoning";
  if (type !== "response_item") return false;
  if (payload.type === "message") return payload.role === "assistant";
  return MODEL_ITEMS.has(payload.type as string);
}

export function codexCalls(transcript: string, chunk?: Chunk): SourceCalls {
  const calls: LlmCall[] = [];
  const sites: CallSite[] = [];
  let pending: unknown[] = [];
  let model: string | undefined;
  let offset = chunk?.offset ?? 0;
  for (const line of transcript.split("\n")) {
    const at = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(row) || !isObject(row.payload)) continue;
    const payload = row.payload;
    if (row.type === "turn_context") {
      pending = [];
      if (typeof payload.model === "string" && payload.model !== "") model = payload.model;
      continue;
    }
    if (row.type === "response_item" && payload.type === "message" && payload.role === "user") {
      pending = [];
      continue;
    }
    if (isModelLine(row.type, payload)) {
      pending.push(row.timestamp);
      continue;
    }
    if (row.type !== "event_msg" || payload.type !== "token_count") continue;
    const usage = isObject(payload.info) ? usageOf(payload.info.last_token_usage) : undefined;
    if (!usage || pending.length === 0) continue;
    const id = `call@${at}`;
    calls.push({ id, ...(model ? { model } : {}), usage });
    for (const timestamp of pending) sites.push({ timestamp, call: id });
    pending = [];
  }
  return { calls, sites };
}
