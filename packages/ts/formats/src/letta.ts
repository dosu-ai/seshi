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

export { NORMALIZER_VERSION as TRAJECTORY_VERSION } from "@letta-ai/trajectory";

export type LettaSource = TranscriptTrajectorySource;

export interface LettaAdapterOptions {
  source: LettaSource;
  chunkable?: boolean;
  revision?: number;
  detect?: FormatDetection;
  prepare?: (transcript: string) => string;
  finish?: (records: NormalizedRecord[], transcript: string) => NormalizedRecord[];
  calls?: (transcript: string, chunk?: Chunk) => SourceCalls;
}

/** The library's records for a chunk: its canonical records' `record_json`, which is the
 * trajectory-v1 record each stands for, less the meta record. The session id is declared only
 * when the library asks for it, since an adapter that reads its own id refuses a declared one
 * that differs. */
function lettaChunk(source: LettaSource, transcript: string, chunk: Chunk): NormalizedRecord[] {
  const run = (groupId?: string) =>
    lettaCanonical({
      source,
      transcript,
      sourceContext: { baseByteOffset: chunk.offset, partial: true, groupId },
    })
      .records.filter((record) => record.record_type !== "meta")
      .map((record) => JSON.parse(record.record_json) as NormalizedRecord);
  try {
    return run();
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== "source_group_required") throw err;
    return run(chunk.session_id);
  }
}

export function lettaAdapter(options: LettaAdapterOptions): FormatAdapter {
  const { source, prepare, finish, calls } = options;
  return {
    source,
    chunkable: options.chunkable ?? true,
    version: `${options.revision ?? 1}+trajectory.${NORMALIZER_VERSION}`,
    detect: options.detect,
    normalize(transcript: string, chunk?: Chunk): NormalizedRecord[] | NormalizedTranscript {
      const prepared = prepare ? prepare(transcript) : transcript;
      const records = chunk
        ? lettaChunk(source, prepared, chunk)
        : letta({ source, transcript: prepared }).records;
      const finished = finish ? finish(records, transcript) : records;
      return calls ? attachCalls(finished, calls(transcript, chunk)) : finished;
    },
  };
}
