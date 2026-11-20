/** What a session did, read from its traces: how long it ran, its prompts and tool calls, the
 * tools it used, the files it touched, the models and tokens its calls record. No DOM here. */

import type { Trace, TraceEvent } from "@seshi/model";
import { splitPrompt } from "@seshi/model/prompts";

export interface SessionStats {
  started?: string;
  ended?: string;
  events: number;
  prompts: number;
  answers: number;
  toolCalls: number;
  failedCalls: number;
  tools: [string, number][];
  files: [string, number][];
  models: string[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  llmCalls: number;
}

const FILE_KEYS = ["file_path", "path", "notebook_path", "filePath", "filename"];

/** Files a tool call names: the usual path arguments, and the files an `apply_patch` touches. */
export function filesOf(event: TraceEvent): string[] {
  const name = event.tool_name ?? "";
  const args = name && event.text.startsWith(name) ? event.text.slice(name.length) : event.text;
  const out = new Set<string>();
  for (const m of args.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    out.add((m[1] as string).trim());
  }
  try {
    const value = JSON.parse(args) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const o = value as Record<string, unknown>;
      for (const key of FILE_KEYS) {
        const v = o[key];
        if (typeof v === "string" && v.trim() && !v.includes("\n")) out.add(v.trim());
      }
      if (typeof o.input === "string") {
        for (const m of o.input.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
          out.add((m[1] as string).trim());
        }
      }
    }
  } catch {}
  return [...out];
}

const byCount = (map: Map<string, number>): [string, number][] =>
  [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export function sessionStats(
  traces: readonly Trace[],
  models: readonly string[] = [],
): SessionStats {
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  const seenModels = new Set(models);
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let events = 0;
  let prompts = 0;
  let answers = 0;
  let toolCalls = 0;
  let failedCalls = 0;
  let llmCalls = 0;
  let started: string | undefined;
  let ended: string | undefined;
  for (const trace of traces) {
    if (trace.started_at && (!started || trace.started_at < started)) started = trace.started_at;
    if (trace.ended_at && (!ended || trace.ended_at > ended)) ended = trace.ended_at;
    if (trace.metadata.model) seenModels.add(trace.metadata.model);
    for (const call of trace.llm_calls ?? []) {
      llmCalls++;
      if (call.model) seenModels.add(call.model);
      tokens.input += call.usage?.input_tokens ?? 0;
      tokens.output += call.usage?.output_tokens ?? 0;
      tokens.cacheRead += call.usage?.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += call.usage?.cache_creation_input_tokens ?? 0;
    }
    for (const event of trace.events) {
      events++;
      if (event.role === "user" && splitPrompt(event.text).prompt !== "") prompts++;
      else if (event.role === "assistant") answers++;
      else if (event.role === "tool_result" && event.ok === false) failedCalls++;
      else if (event.role === "tool_call") {
        toolCalls++;
        const name = event.tool_name ?? "tool";
        tools.set(name, (tools.get(name) ?? 0) + 1);
        for (const file of filesOf(event)) files.set(file, (files.get(file) ?? 0) + 1);
      }
    }
  }
  return {
    ...(started ? { started } : {}),
    ...(ended ? { ended } : {}),
    events,
    prompts,
    answers,
    toolCalls,
    failedCalls,
    tools: byCount(tools),
    files: byCount(files),
    models: [...seenModels],
    tokens,
    llmCalls,
  };
}
