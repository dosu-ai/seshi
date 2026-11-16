/** A session the daemon imported from a client's own history (`trajectory session import`,
 * `_backfilled: true`) is thinner than one it captured live: `session_start` carries `cwd`
 * instead of `project_dir`, a tool call appears only as its `phase: post` event, and the
 * agent's prose is not in it at all. */

import type {
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ToolResultRecord,
} from "@seshi/model";

export const DATADOG_TRAJECTORY = "datadog-trajectory" as const;

type Event = Record<string, unknown>;

class DatadogTrajectoryError extends Error {
  constructor(
    readonly code: "missing_session_start" | "missing_user_records" | "missing_assistant_records",
    message: string,
  ) {
    super(message);
    this.name = "DatadogTrajectoryError";
  }
}

function parseEvents(transcript: string): Event[] {
  const events: Event[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        events.push(value as Event);
      }
    } catch {}
  }
  return events;
}

function present(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sessionStart(events: readonly Event[]): Event {
  const start = events.find((event) => event.event_type === "session_start");
  if (!start || !present(start.session_id)) {
    throw new DatadogTrajectoryError(
      "missing_session_start",
      "stream has no session_start event with a session_id",
    );
  }
  return start;
}

function metaOf(start: Event): MetaRecord {
  const client = present(start.client_source) ?? "unknown";
  const meta: MetaRecord = { role: "meta", source: `${DATADOG_TRAJECTORY}:${client}` };
  const cwd = present(start.project_dir) ?? present(start.cwd);
  const branch = present(start.git_branch);
  const model = present(start.model);
  if (cwd !== undefined) meta.cwd = cwd;
  if (branch !== undefined) meta.git_branch = branch;
  if (model !== undefined) meta.model = model;
  return meta;
}

function typedByHuman(event: Event): boolean {
  const provenance = event.provenance;
  if (typeof provenance !== "object" || provenance === null) return true;
  const actor = (provenance as Event).actor_type;
  return actor === undefined || actor === "human";
}

export interface DatadogNormalizeOptions {
  /** The transcript is a chunk of a stream past its `session_start`: no meta record is made,
   * no conversation is demanded of it, and a tool result whose call is not in the chunk
   * answers a call shipped in an earlier one (unless the event is backfilled, which never had
   * one). */
  partial?: boolean;
}

/** The records of one stream, meta first. Throws `DatadogTrajectoryError` when the stream has
 * no `session_start`, or holds no conversation (no prompt, or nothing answering one). A partial
 * stream's records are those of its events alone. */
export function normalizeDatadogTrajectory(
  transcript: string,
  options: DatadogNormalizeOptions = {},
): NormalizedRecord[] {
  const events = parseEvents(transcript);
  const start = options.partial ? undefined : sessionStart(events);
  const records: NormalizedRecord[] = start ? [metaOf(start)] : [];
  let last = present(start?.timestamp) ?? present(start?.started_at) ?? "";
  let asked = false;
  let answered = false;
  const called = new Set<string>();

  function toolCall(event: Event, id: string, timestamp: string): AssistantToolCallRecord | null {
    const name = present(event.native_tool_name) ?? present(event.tool_name);
    if (name === undefined) return null;
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id, name, args: JSON.stringify(event.input ?? {}) }],
      timestamp,
    };
  }

  for (const event of events) {
    const timestamp = present(event.timestamp) ?? last;
    last = timestamp;
    switch (event.event_type) {
      case "user_prompt":
      case "input_prompt": {
        const prompt = present(event.prompt);
        if (prompt === undefined) break;
        if (typedByHuman(event)) {
          asked = true;
          records.push({ role: "user", content: prompt, timestamp });
        } else {
          records.push({ role: "observation", content: prompt, timestamp });
        }
        break;
      }
      case "tool_use": {
        const id = present(event.tool_use_id);
        if (id === undefined) break;
        if (event.phase === "pre") {
          const call = toolCall(event, id, timestamp);
          if (call === null) break;
          answered = true;
          called.add(id);
          records.push(call);
        } else if (event.phase === "post") {
          const orphan = !options.partial || event._backfilled === true;
          if (!called.has(id) && orphan) {
            const call = toolCall(event, id, timestamp);
            if (call === null) break;
            answered = true;
            called.add(id);
            records.push(call);
          }
          const error = typeof event.error === "string" ? event.error : undefined;
          const result: ToolResultRecord = {
            role: "tool",
            tool_call_id: id,
            content:
              typeof event.output_summary === "string" ? event.output_summary : (error ?? ""),
            timestamp,
          };
          if (typeof event.success === "boolean") result.ok = event.success;
          else if (error !== undefined) result.ok = false;
          records.push(result);
        }
        break;
      }
      case "agent_message": {
        const thinking = present(event.thinking_text);
        const text = present(event.text);
        if (thinking !== undefined)
          records.push({ role: "reasoning", content: thinking, timestamp });
        if (text !== undefined) {
          answered = true;
          records.push({ role: "assistant", content: text, timestamp });
        }
        break;
      }
      default:
        break;
    }
  }

  if (options.partial) return records;
  if (!asked) {
    throw new DatadogTrajectoryError("missing_user_records", "stream has no user prompt");
  }
  if (!answered) {
    throw new DatadogTrajectoryError(
      "missing_assistant_records",
      "stream has no assistant message or tool call",
    );
  }
  return records;
}
