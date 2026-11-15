/** What each model call in a Claude Code transcript cost, which `@letta-ai/trajectory` drops.
 *
 * Every assistant line carries the API response it is part of: `requestId`, and in `message`
 * the response `id`, the `model`, `stop_reason` and `usage` (input, output and cache tokens).
 * Claude Code writes one line per content block, so several lines can share one request; the
 * call is keyed by `requestId` (else the message id, else the line's uuid), and the last line's
 * usage and stop reason, the most complete, win. Lines Claude Code makes up itself (model
 * `<synthetic>`, such as an API error shown as a reply) are no call. */

import type { CallSite, SourceCalls } from "@seshi/formats";
import type { JsonObject, LlmCall, TokenUsage } from "@seshi/model";

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
] as const;

function usageOf(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const usage: TokenUsage = {};
  for (const key of USAGE_KEYS) {
    const n = value[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) usage[key] = n;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** The model calls a Claude Code transcript (or a chunk of one) records, and its assistant
 * lines. */
export function claudeCodeCalls(transcript: string): SourceCalls {
  const calls = new Map<string, LlmCall>();
  const sites: CallSite[] = [];
  for (const line of transcript.split("\n")) {
    if (!line.includes('"assistant"')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(row) || row.type !== "assistant" || !isObject(row.message)) continue;
    const message = row.message;
    const model = text(message.model);
    if (model === "<synthetic>") continue;
    const requestId = text(row.requestId);
    const id = requestId ?? text(message.id) ?? text(row.uuid);
    if (id === undefined) continue;
    const call: LlmCall = calls.get(id) ?? { id };
    if (model) call.model = model;
    if (requestId) call.request_id = requestId;
    const stop = text(message.stop_reason);
    if (stop) call.stop_reason = stop;
    const usage = usageOf(message.usage);
    if (usage) call.usage = usage;
    calls.set(id, call);
    sites.push({ timestamp: row.timestamp, call: id });
  }
  // A call the log says nothing about (no model, no usage) is only an id: no call at all.
  const known = [...calls.values()].filter((call) => call.model || call.usage);
  return { calls: known, sites };
}
