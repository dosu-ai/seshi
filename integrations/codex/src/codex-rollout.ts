/** Codex rollouts, adjusted around what @letta-ai/trajectory's codex adapter does with them.
 *
 * A subagent spawned with its parent's context (`fork_turns`, "all" by default in multi-agent v2)
 * starts its rollout with a copy of the parent's history: the parent's `session_meta`, prompts and
 * turns, then the subagent's own task. The parent's trace already carries that history, so
 * shipping it again would have it learned from twice, the second time as the subagent's. Codex
 * marks where the subagent's own records begin (`subagent_history_start_ordinal` in its
 * `session_meta`, paginated rollouts: 0.160), and only those ship.
 *
 * When a subagent finishes, Codex tells its parent by injecting a user message that starts with
 * `<subagent_notification>` and carries the subagent's final answer. The adapter keeps it as a
 * user record, which passes the report off as something the user said. It is input the parent
 * received and acted on next, so it ships in place as an `observation` record (the subagent's
 * own work ships separately, linked by `parent_session_id`), the way Claude Code's
 * `<task-notification>` does. */

import type { NormalizedRecord } from "@seshi/model";

const SUBAGENT_REPORT_PREFIX = "<subagent_notification>";

export function subagentReportsAsObservations(records: NormalizedRecord[]): NormalizedRecord[] {
  return records.map((record) =>
    record.role === "user" && record.content.trimStart().startsWith(SUBAGENT_REPORT_PREFIX)
      ? { role: "observation", content: record.content, timestamp: record.timestamp }
      : record,
  );
}

/** A rollout with its `agent_reasoning` events blanked out, each line kept as spaces of the same
 * byte length so every other line keeps its byte offset (and so its record id).
 *
 * Codex writers that emit `agent_reasoning` events also store the same text as the `response_item`
 * reasoning item's `summary`; newer writers store only the summary. The library reads both and
 * drops a summary only when a matching event is in the same text, which a chunk cut between the
 * two defeats: the reasoning would be stored twice. Reading the summaries alone gives the same
 * records whether the log arrives whole or in chunks. */
export function withoutReasoningEvents(transcript: string): string {
  if (!transcript.includes("agent_reasoning")) return transcript;
  return transcript
    .split("\n")
    .map((line) => (isReasoningEvent(line) ? " ".repeat(Buffer.byteLength(line, "utf8")) : line))
    .join("\n");
}

function isReasoningEvent(line: string): boolean {
  if (!line.includes("agent_reasoning")) return false;
  const record = parsed(line);
  const payload = record?.payload as Record<string, unknown> | undefined;
  return record?.type === "event_msg" && payload?.type === "agent_reasoning";
}

/** A forked subagent's rollout without the parent history copied into it: its own
 * `session_meta`, then the records from `subagent_history_start_ordinal` on. Any other rollout,
 * or one this cannot read, comes back as it was. */
export function withoutInheritedHistoryInHead(transcript: string): string {
  const lines = transcript.split("\n");
  const start = lines.findIndex((line) => line.trim() !== "");
  const ownFrom = subagentHistoryStart(lines[start]);
  if (ownFrom === null) return transcript;
  const kept = lines.slice(0, start + 1);
  for (let i = start + 1; i < lines.length; i++) {
    const ordinal = ordinalOf(lines[i]);
    // Ordinals only grow: from the first record of the subagent's own, everything stays.
    if (ordinal !== null && ordinal < ownFrom) continue;
    if (ordinal !== null) return [...kept, ...lines.slice(i)].join("\n");
    kept.push(lines[i]);
  }
  return kept.join("\n");
}

function parsed(line: string | undefined): Record<string, unknown> | null {
  if (line === undefined) return null;
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function subagentHistoryStart(line: string | undefined): number | null {
  const record = parsed(line);
  if (record?.type !== "session_meta") return null;
  const start = (record.payload as Record<string, unknown> | undefined)
    ?.subagent_history_start_ordinal;
  return typeof start === "number" && Number.isInteger(start) && start > 0 ? start : null;
}

function ordinalOf(line: string): number | null {
  if (line.trim() === "") return null;
  const ordinal = parsed(line)?.ordinal;
  return typeof ordinal === "number" ? ordinal : null;
}
