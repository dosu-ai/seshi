import {
  LETTA_TRACE_SCHEMA,
  type LettaTrace,
  type NormalizedRecord,
  type Trace,
  type TraceRecord,
} from "@seshi/model";

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

export function lettaRecords(records: readonly TraceRecord[]): NormalizedRecord[] {
  return records.map(lettaRecord);
}

export function toLetta(trace: Trace): LettaTrace {
  return {
    schema: LETTA_TRACE_SCHEMA,
    content_hash: trace.content_hash,
    source: trace.source,
    agent: trace.format,
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
