import { canonicalJson, isStub, type NormalizedRecord, type SessionMetadata } from "@seshi/model";
import type { DoctorDeps } from "../doctor/deps";
import type { SessionEvidence } from "../doctor/types";
import type { Pipeline, RecordRow, RecordsView, RowFilter, RowState } from "./types";

export const MARKER = /\[redacted:([a-z0-9]+(?:-[a-z0-9]+)*)\]/g;

export function markersIn(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (value === undefined) return counts;
  for (const m of JSON.stringify(value).matchAll(MARKER)) {
    const rule = m[1] as string;
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
  return counts;
}

export interface Aligned {
  pipeline: Pipeline;
  marks: RecordsView["marks"];
  rows: RecordRow[];
  states: Partial<Record<RowState, number>>;
}

function storedOf(ev: SessionEvidence): SessionMetadata | undefined {
  return ev.server.metadata ?? ev.server.pointer ?? undefined;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function unredactedRecordsUpTo(
  ev: SessionEvidence,
  deps: DoctorDeps,
  end: number,
): NormalizedRecord[] {
  const path = ev.transcript.path as string;
  const capture = ev.capture as NonNullable<SessionEvidence["capture"]>;
  const text = deps.files.read(path, end);
  return deps.normalizer.records(capture.format, deps.redaction.transcript(text, capture.encoding));
}

function serverEnd(ev: SessionEvidence): number | undefined {
  const s = ev.local;
  const n = storedOf(ev)?.normalized;
  if (!s || !n) return undefined;
  if (s.server_offset === n.bytes && s.file_offset !== undefined) return s.file_offset;
  if (s.aligned !== false) return n.bytes;
  return undefined;
}

function storedByIndex(ev: SessionEvidence): Map<number, { record: unknown; trace: number }> {
  const out = new Map<number, { record: unknown; trace: number }>();
  ev.server.traces.forEach((t, trace) => {
    const records = t.records ?? [];
    let at = t.continuation?.from_record ?? 0;
    records.forEach((record, i) => {
      if (i === 0 && t.continuation && record?.role === "meta") {
        if (!out.has(0)) out.set(0, { record, trace });
        return;
      }
      if (!out.has(at)) out.set(at, { record, trace });
      at++;
    });
  });
  return out;
}

export function alignRecords(ev: SessionEvidence, deps: DoctorDeps): Aligned {
  const s = ev.local;
  const m = storedOf(ev);
  const pipeline: Pipeline = {
    transcript: {
      ...(ev.transcript.size !== undefined ? { bytes: ev.transcript.size } : {}),
      ...(s?.file_offset !== undefined ? { sent_bytes: s.file_offset } : {}),
      ...(s?.server_offset !== undefined ? { server_offset: s.server_offset } : {}),
      ...(s?.frozen ? { frozen_offset: s.frozen.offset } : {}),
    },
    records: {},
    redacted: {
      records: 0,
      markers: {},
      withheld: 0,
      rule_set: deps.redaction.rule_set,
      origin: deps.redaction.origin,
    },
    sent: {
      ...(s?.last_status ? { last_status: s.last_status } : {}),
      ...(s?.last_status === "filtered" || (ev.decision && !ev.decision.capture && !s?.stored)
        ? { filtered: true }
        : {}),
    },
    stored: {
      traces: ev.server.traces.length,
      stub: m ? isStub(m) : false,
      ...(m?.normalized ? { records: m.normalized.records } : {}),
      ...(m?.dropped_prefix ? { dropped_prefix: m.dropped_prefix.records } : {}),
      ...(m?.withheld_calls ? { withheld_calls: Object.keys(m.withheld_calls).length } : {}),
      ...(m ? { status: m.status } : {}),
    },
  };

  let local: NormalizedRecord[] = [];
  const size = ev.transcript.size ?? 0;
  const readable = ev.transcript.exists && ev.transcript.path && ev.capture;
  let sentUntil: number | undefined;
  let frozenAt: number | undefined;
  if (!readable) {
    pipeline.transcript.error = ev.transcript.error?.message ?? "the transcript is not here";
  } else {
    try {
      local = deps.redaction.records(unredactedRecordsUpTo(ev, deps, size));
      pipeline.records.count = local.length;
    } catch (err) {
      pipeline.records.error = `the adapter cannot read the transcript now: ${message(err)}`;
    }
    const end = serverEnd(ev);
    if (end !== undefined && !pipeline.records.error) {
      try {
        sentUntil = end >= size ? local.length : unredactedRecordsUpTo(ev, deps, end).length;
        pipeline.sent.records = sentUntil;
      } catch {}
    }
    if (s?.frozen && !pipeline.records.error) {
      try {
        frozenAt =
          s.frozen.offset >= size
            ? local.length
            : unredactedRecordsUpTo(ev, deps, s.frozen.offset).length;
      } catch {}
    }
  }
  for (const record of local) {
    const found = markersIn(record);
    const rules = Object.keys(found);
    if (rules.length > 0) pipeline.redacted.records++;
    for (const rule of rules) {
      pipeline.redacted.markers[rule] =
        (pipeline.redacted.markers[rule] ?? 0) + (found[rule] as number);
    }
    if ((record as { withheld?: string }).withheld) pipeline.redacted.withheld++;
  }

  const stored = storedByIndex(ev);
  const dropped = m?.dropped_prefix?.records;
  const hasTrace = ev.server.traces.length > 0;
  const total = Math.max(
    local.length,
    m?.normalized?.records ?? 0,
    ...[...stored.keys()].map((i) => i + 1),
  );
  const rows: RecordRow[] = [];
  const states: Partial<Record<RowState, number>> = {};
  for (let index = 0; index < total; index++) {
    const l = local[index];
    const st = stored.get(index);
    let state: RowState;
    if (l !== undefined && st) {
      state = canonicalJson(l) === canonicalJson(st.record) ? "same" : "differs";
    } else if (st) state = "stored-only";
    else if (dropped !== undefined && index < dropped) state = "dropped";
    else if (frozenAt !== undefined && index >= frozenAt && l !== undefined) state = "frozen";
    else if (sentUntil !== undefined && index >= sentUntil && l !== undefined) state = "unsent";
    else if (hasTrace || (m?.normalized && index < m.normalized.records)) state = "missing";
    else state = "local";
    states[state] = (states[state] ?? 0) + 1;
    const markers = markersIn(l ?? st?.record);
    const withheld = (l as { withheld?: string } | undefined)?.withheld;
    rows.push({
      index,
      state,
      ...(l !== undefined ? { local: l } : {}),
      ...(st ? { stored: st.record, trace: st.trace } : {}),
      ...(Object.keys(markers).length > 0 ? { markers } : {}),
      ...(withheld ? { withheld } : {}),
    });
  }
  return {
    pipeline,
    marks: {
      ...(dropped !== undefined ? { dropped_until: dropped } : {}),
      ...(frozenAt !== undefined ? { frozen_at: frozenAt } : {}),
      ...(sentUntil !== undefined ? { sent_until: sentUntil } : {}),
      stub: pipeline.stored.stub,
    },
    rows,
    states,
  };
}

const MISMATCH: ReadonlySet<RowState> = new Set(["differs", "missing", "stored-only"]);

export function matches(row: RecordRow, filter: RowFilter): boolean {
  switch (filter) {
    case "mismatch":
      return MISMATCH.has(row.state);
    case "redacted":
      return row.markers !== undefined || row.withheld !== undefined;
    case "local":
      return row.local !== undefined && row.stored === undefined;
    case "stored":
      return row.stored !== undefined;
    default:
      return true;
  }
}

export const MAX_PAGE = 500;

export function page(
  aligned: Aligned,
  options: { offset?: number; limit?: number; filter?: RowFilter } = {},
): RecordsView {
  const filter = options.filter ?? "all";
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(MAX_PAGE, Math.max(0, options.limit ?? 100));
  const matching = filter === "all" ? aligned.rows : aligned.rows.filter((r) => matches(r, filter));
  return {
    pipeline: aligned.pipeline,
    marks: aligned.marks,
    total: aligned.rows.length,
    matching: matching.length,
    offset,
    rows: matching.slice(offset, offset + limit),
    states: aligned.states,
  };
}
