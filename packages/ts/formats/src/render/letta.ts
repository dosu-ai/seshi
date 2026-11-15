/** The canonical trace as Letta trajectory-v1 (X6.2): the `sessionstorage/trace/1` object
 * sessiondb stored before seshi, so a reader of those objects reads this one unchanged. The
 * records lose the fields the canonical trace added to trajectory-v1; the trace loses
 * `llm_calls` and `provenance`. Events, `content_hash` and metadata stay as they are: the hash
 * never read the added fields. */

import {
  LETTA_TRACE_SCHEMA,
  type LettaTrace,
  type NormalizedRecord,
  type Trace,
  type TraceRecord,
} from "@seshi/model";

/** One canonical record as plain trajectory-v1, field order as `validateRecords` writes it. */
export function lettaRecord(record: TraceRecord): NormalizedRecord {
  switch (record.role) {
    case "meta": {
      const { agent_version: _version, ...meta } = record;
      return meta;
    }
    case "user":
    case "system":
    case "observation":
    case "reasoning":
      return { role: record.role, content: record.content, timestamp: record.timestamp };
    case "assistant":
      if (record.tool_calls !== undefined) {
        return {
          role: "assistant",
          content: record.content,
          tool_calls: record.tool_calls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
          timestamp: record.timestamp,
        } as NormalizedRecord;
      }
      return {
        role: "assistant",
        content: record.content,
        timestamp: record.timestamp,
      } as NormalizedRecord;
    case "tool": {
      const out: NormalizedRecord = {
        role: "tool",
        tool_call_id: record.tool_call_id,
        content: record.content,
        timestamp: record.timestamp,
      };
      if (record.ok !== undefined) out.ok = record.ok;
      return out;
    }
  }
}

/** Canonical records as plain trajectory-v1. */
export function lettaRecords(records: readonly TraceRecord[]): NormalizedRecord[] {
  return records.map(lettaRecord);
}

/** The trace as Letta trajectory-v1, keys in the order sessiondb wrote them. */
export function toLetta(trace: Trace): LettaTrace {
  return {
    schema: LETTA_TRACE_SCHEMA,
    content_hash: trace.content_hash,
    source: trace.source,
    agent: trace.agent,
    session_id: trace.session_id,
    started_at: trace.started_at,
    ended_at: trace.ended_at,
    records: lettaRecords(trace.records),
    events: trace.events,
    metadata: trace.metadata,
    ...(trace.project !== undefined ? { project: trace.project } : {}),
    ...(trace.branch !== undefined ? { branch: trace.branch } : {}),
  };
}
