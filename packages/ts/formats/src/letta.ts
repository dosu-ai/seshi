import {
  normalizeTranscript as letta,
  normalizeToCanonical as lettaCanonical,
  NORMALIZER_VERSION,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";
import type {
  Chunk,
  FormatAdapter,
  FormatDetection,
  NormalizedRecord,
  NormalizedTranscript,
} from "@seshi/model";
import { attachCalls, type SourceCalls } from "./calls";
import type { Injected, RecordLabels } from "./injected";

export { NORMALIZER_VERSION as TRAJECTORY_VERSION } from "@letta-ai/trajectory";

export type LettaSource = TranscriptTrajectorySource;

export interface LettaAdapterOptions {
  source: LettaSource;
  chunkable?: boolean;
  revision?: number;
  detect?: FormatDetection;
  prepare?: (transcript: string) => string;
  /** Content an agent or a plugin added to a user turn, run on the transcript after `prepare`: the
   * transcript with flagged items' text gone, and labels for the user records the items
   * normalize to (`synthetic`, `omitted`), which the library has no field for. A record labelled
   * `omitted` has its content emptied. Applied to user records only. */
  inject?: (transcript: string) => Injected;
  finish?: (records: NormalizedRecord[], transcript: string) => NormalizedRecord[];
  /** The version of the harness that wrote the transcript, which the library leaves out of the
   * meta record: set as its `agent_version`. Read from the whole transcript only (a chunk has no
   * meta record), so the first version the log names, which stays as the log grows. */
  agentVersion?: (transcript: string) => string | undefined;
  calls?: (transcript: string, chunk?: Chunk) => SourceCalls;
}

interface Canonical {
  records: NormalizedRecord[];
  /** Each record's source item id, in step with `records`. */
  ids: string[];
}

/** The library's canonical records, as trajectory-v1 records with each one's source item id.
 * The session id is declared only when the library asks for it, since an adapter that reads its
 * own id refuses a declared one that differs. */
function canonical(
  source: LettaSource,
  transcript: string,
  context: { baseByteOffset?: number; partial?: boolean },
  groupId: string,
): Canonical {
  const run = (declared?: string) =>
    lettaCanonical({ source, transcript, sourceContext: { ...context, groupId: declared } })
      .records;
  let rows: ReturnType<typeof run>;
  try {
    rows = run();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "source_group_required") throw err;
    rows = run(groupId);
  }
  return {
    records: rows.map((row) => JSON.parse(row.record_json) as NormalizedRecord),
    ids: rows.map((row) => row.stable_source_record_id),
  };
}

/** The library's records for a chunk: its canonical records less the meta record. */
function lettaChunk(source: LettaSource, transcript: string, chunk: Chunk): Canonical {
  const all = canonical(
    source,
    transcript,
    { baseByteOffset: chunk.offset, partial: true },
    chunk.session_id,
  );
  const keep = all.records.map((record) => record.role !== "meta");
  return {
    records: all.records.filter((_, i) => keep[i]),
    ids: all.ids.filter((_, i) => keep[i]),
  };
}

/** Labels applied to the user records they name. An `omitted` count goes on the first record of
 * its item only, and that record's content is emptied. */
function applyLabels(
  records: NormalizedRecord[],
  ids: readonly string[],
  labels: ReadonlyMap<string, RecordLabels>,
): NormalizedRecord[] {
  const counted = new Set<string>();
  return records.map((record, i) => {
    const id = ids[i];
    const label = id === undefined ? undefined : labels.get(id);
    if (!label || record.role !== "user" || id === undefined) return record;
    const out: Record<string, unknown> = { ...record };
    if (label.synthetic) out.synthetic = true;
    if (label.omitted && !counted.has(id)) {
      counted.add(id);
      out.content = "";
      out.omitted = label.omitted;
    }
    return out as unknown as NormalizedRecord;
  });
}

/** `records` with the meta record's `agent_version` set to `version`, when both are there. */
export function withAgentVersion(
  records: NormalizedRecord[],
  version: string | undefined,
): NormalizedRecord[] {
  const meta = records[0];
  if (!version || meta?.role !== "meta") return records;
  return [{ ...meta, agent_version: version } as NormalizedRecord, ...records.slice(1)];
}

/** The first value of a top-level string field across a JSONL log's lines, reading at most
 * `limit` lines: `pick` takes each parsed line and says the field's value. */
export function firstJsonlField(
  transcript: string,
  pick: (row: Record<string, unknown>) => unknown,
  limit = 200,
): string | undefined {
  let start = 0;
  for (let n = 0; n < limit && start < transcript.length; n++) {
    const end = transcript.indexOf("\n", start);
    const line = transcript.slice(start, end === -1 ? undefined : end).trim();
    start = end === -1 ? transcript.length : end + 1;
    if (line === "") continue;
    try {
      const row = JSON.parse(line) as unknown;
      if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
      const value = pick(row as Record<string, unknown>);
      if (typeof value === "string" && value !== "") return value;
    } catch {}
  }
  return undefined;
}

export function lettaAdapter(options: LettaAdapterOptions): FormatAdapter {
  const { source, prepare, inject, finish, calls } = options;
  return {
    source,
    chunkable: options.chunkable ?? true,
    version: `${options.revision ?? 1}+trajectory.${NORMALIZER_VERSION}`,
    detect: options.detect,
    normalize(transcript: string, chunk?: Chunk): NormalizedRecord[] | NormalizedTranscript {
      const ready = prepare ? prepare(transcript) : transcript;
      const injected = inject?.(ready);
      const prepared = injected?.transcript ?? ready;
      const labels = injected?.labels;
      let records: NormalizedRecord[];
      if (chunk) {
        const run = lettaChunk(source, prepared, chunk);
        records = labels?.size ? applyLabels(run.records, run.ids, labels) : run.records;
      } else if (labels?.size) {
        // The canonical run, which the chunk path uses too: the same records, each with the id
        // of the item it came from, so labels are matched by construction.
        const run = canonical(source, prepared, {}, "seshi");
        records = applyLabels(run.records, run.ids, labels);
      } else {
        records = letta({ source, transcript: prepared }).records;
      }
      const finished = withAgentVersion(
        finish ? finish(records, transcript) : records,
        chunk ? undefined : options.agentVersion?.(transcript),
      );
      return calls ? attachCalls(finished, calls(transcript, chunk)) : finished;
    },
  };
}
