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
import type { RecordLabels } from "./injected";

export { NORMALIZER_VERSION as TRAJECTORY_VERSION } from "@letta-ai/trajectory";

export type LettaSource = TranscriptTrajectorySource;

export interface LettaAdapterOptions {
  source: LettaSource;
  chunkable?: boolean;
  revision?: number;
  detect?: FormatDetection;
  prepare?: (transcript: string) => string;
  /** Labels for user records the library has no field for, read from the transcript as it came
   * (before `prepare`), keyed by the id of the source item they normalize from: the library's
   * `stable_source_record_id`, an OpenCode part id or a pi entry id. A record labelled `omitted`
   * has its content emptied, so `prepare` need only make sure the item's text never reaches the
   * library. Applied to user records only. */
  label?: (transcript: string) => ReadonlyMap<string, RecordLabels>;
  finish?: (records: NormalizedRecord[], transcript: string) => NormalizedRecord[];
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

/** Each record's source item id, for a whole transcript's records. The library's plain records
 * carry none, so its canonical run (the same records, with identities) supplies them. */
function wholeIds(source: LettaSource, transcript: string, records: NormalizedRecord[]): string[] {
  const run = canonical(source, transcript, {}, "seshi");
  const inStep =
    run.records.length === records.length &&
    run.records.every((record, i) => record.role === records[i]?.role);
  if (!inStep) {
    throw new Error(`${source}: the library's canonical records do not match its records`);
  }
  return run.ids;
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

export function lettaAdapter(options: LettaAdapterOptions): FormatAdapter {
  const { source, prepare, label, finish, calls } = options;
  return {
    source,
    chunkable: options.chunkable ?? true,
    version: `${options.revision ?? 1}+trajectory.${NORMALIZER_VERSION}`,
    detect: options.detect,
    normalize(transcript: string, chunk?: Chunk): NormalizedRecord[] | NormalizedTranscript {
      const prepared = prepare ? prepare(transcript) : transcript;
      const labels = label?.(transcript);
      let records: NormalizedRecord[];
      if (chunk) {
        const run = lettaChunk(source, prepared, chunk);
        records = labels?.size ? applyLabels(run.records, run.ids, labels) : run.records;
      } else {
        records = letta({ source, transcript: prepared }).records;
        if (labels?.size) {
          records = applyLabels(records, wholeIds(source, prepared, records), labels);
        }
      }
      const finished = finish ? finish(records, transcript) : records;
      return calls ? attachCalls(finished, calls(transcript, chunk)) : finished;
    },
  };
}
