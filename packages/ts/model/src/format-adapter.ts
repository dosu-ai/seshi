import type { LlmCall } from "./schemas/trace";
import type { NormalizedRecord } from "./schemas/trajectory";
import type { SpanAdapter } from "./spans";

/** Where a chunk sits in its log. */
export interface Chunk {
  /** The byte offset of the chunk's first byte in the log. */
  offset: number;
  /** The session the log is of, for an adapter whose chunks do not say (a Codex rollout's
   * `session_meta` is in its first chunk only). */
  session_id: string;
}

/** A top-level key's value in a document's head: its kind, and the text of a string. */
export interface HeadValue {
  kind: "string" | "object" | "array" | "scalar";
  text?: string;
  /** For an array whose first element is an object: that object's own head. */
  first?: DocumentHead;
}

/** The top-level keys of a JSON document, read from its start (a truncated sample still has
 * them). A key whose value was cut short has its kind but no text. */
export type DocumentHead = ReadonlyMap<string, HeadValue>;

export type JsonObject = Record<string, unknown>;

/** How detection recognises a format from the start of a file. A sample is a format's when it
 * matches that format's rule and no other's; a guess would file a session under the wrong
 * archive. */
export interface FormatDetection {
  /** For a format that is one JSON document: whether these top-level keys are this format's. */
  document?: (head: DocumentHead) => boolean;
  /** For a JSONL format: whether this record is one only this format writes. */
  record?: (row: JsonObject) => boolean;
}

/** A transcript's records with the LLM calls their `llm_call` fields name. */
export interface NormalizedTranscript {
  records: NormalizedRecord[];
  llm_calls?: LlmCall[];
}

/** One transcript format: native transcript text to trajectory-v1 records, before redaction.
 *
 * `normalize` throws for a transcript it cannot read; an error with a string `code` keeps its
 * code (`missing_user_records` and `missing_assistant_records` mean the log holds no
 * conversation yet, which the registry reports as empty rather than as a failure). With `chunk`,
 * the transcript is the bytes of a log past a point already normalized: the result is that
 * chunk's records without a meta record, and a log cut at line boundaries must normalize, chunk
 * by chunk, to the records the whole log does.
 *
 * An adapter whose transcripts record what each model call cost returns `NormalizedTranscript`:
 * the records, each assistant or reasoning record naming its call in `llm_call`, and the calls
 * (model, token usage, request id). Raw transcripts are not stored (X6.3), so what the adapter
 * leaves out here is gone for good (X6.2). */
export interface FormatAdapter {
  /** The format's name: the `format` a session is filed under and what archive ids derive from. */
  readonly source: string;
  /** Whether a log in this format can arrive in chunks. */
  readonly chunkable: boolean;
  /** The adapter's normalizer version: what the records a transcript normalizes to depend on,
   * as dotted numbers compared one by one (`1+trajectory.0.3.0` is 1, 0, 3, 0). Raise it with
   * any change that alters the records of a transcript already stored: sessions built by an
   * older one are `stale`, and the uploader sends them again to be rebuilt (X4.9). `1` when
   * omitted. */
  readonly version?: string;
  readonly detect?: FormatDetection;
  normalize(transcript: string, chunk?: Chunk): NormalizedRecord[] | NormalizedTranscript;
  /** For a format that also arrives as span sets (OTLP, Datadog): how its spans are grouped,
   * normalized and assembled (X4.2). A format without it takes logs only. */
  readonly spans?: SpanAdapter;
}
