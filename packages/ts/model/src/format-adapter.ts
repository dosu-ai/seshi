/** The contract between a transcript format and the code that runs it: one adapter per format
 * name (`claude-code`, `codex`, `atif`, …). Integrations implement it (through `@seshi/kit`,
 * which re-exports these types as part of the integration contract), `@seshi/formats` holds the
 * registry that detects and normalizes through it, and the pipeline asks that registry.
 *
 * The types live here, in the lowest layer, because `@seshi/kit` and `@seshi/formats` sit on
 * the same layer and may not import each other (X3.2). */

import type { NormalizedRecord } from "./schemas/trajectory";

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

/** One transcript format: native transcript text to trajectory-v1 records, before redaction.
 *
 * `normalize` throws for a transcript it cannot read; an error with a string `code` keeps its
 * code (`missing_user_records` and `missing_assistant_records` mean the log holds no
 * conversation yet, which the registry reports as empty rather than as a failure). With `chunk`,
 * the transcript is the bytes of a log past a point already normalized: the result is that
 * chunk's records without a meta record, and a log cut at line boundaries must normalize, chunk
 * by chunk, to the records the whole log does. */
export interface FormatAdapter {
  /** The format's name: the `agent` a client sends and what archive ids derive from. */
  readonly source: string;
  /** Whether a log in this format can arrive in chunks. */
  readonly chunkable: boolean;
  readonly detect?: FormatDetection;
  normalize(transcript: string, chunk?: Chunk): NormalizedRecord[];
}
