/** Format adapters over `@letta-ai/trajectory`, the vendor-neutral library that normalizes most
 * native transcripts (Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, ATIF) to
 * trajectory-v1. An integration builds its adapter here and adds only what is specific to its
 * agent: a rewrite of the transcript before the library reads it (`prepare`), a rewrite of the
 * records after (`finish`), and the rule detection recognises it by.
 *
 * A whole transcript goes through the library's `normalizeTranscript`. A chunk goes through its
 * canonical API with a `partial` source context, whose records are the same trajectory-v1
 * records; the meta record it emits for a chunk at offset 0 is dropped, since a chunk's records
 * are never the session's meta. */

import {
  normalizeTranscript as letta,
  normalizeToCanonical as lettaCanonical,
  type TranscriptTrajectorySource,
} from "@letta-ai/trajectory";
import type { Chunk, FormatAdapter, FormatDetection, NormalizedRecord } from "@seshi/model";

export { NORMALIZER_VERSION as TRAJECTORY_VERSION } from "@letta-ai/trajectory";

/** The transcript formats `@letta-ai/trajectory` reads, by its source names. */
export type LettaSource = TranscriptTrajectorySource;

export interface LettaAdapterOptions {
  source: LettaSource;
  /** Whether a log can arrive in chunks; default true. */
  chunkable?: boolean;
  detect?: FormatDetection;
  /** The transcript as the library should see it. A chunk past a session's head is prepared
   * the same way as a whole log. */
  prepare?: (transcript: string) => string;
  /** The library's records, adjusted; `transcript` is the one the caller gave, unprepared. */
  finish?: (records: NormalizedRecord[], transcript: string) => NormalizedRecord[];
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

/** An adapter that runs `@letta-ai/trajectory` with the integration's fixups around it. */
export function lettaAdapter(options: LettaAdapterOptions): FormatAdapter {
  const { source, prepare, finish } = options;
  return {
    source,
    chunkable: options.chunkable ?? true,
    detect: options.detect,
    normalize(transcript: string, chunk?: Chunk): NormalizedRecord[] {
      const prepared = prepare ? prepare(transcript) : transcript;
      const records = chunk
        ? lettaChunk(source, prepared, chunk)
        : letta({ source, transcript: prepared }).records;
      return finish ? finish(records, transcript) : records;
    },
  };
}
