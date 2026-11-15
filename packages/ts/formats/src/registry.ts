/** The format registry: every transcript format a deployment reads, by name, built from the
 * adapters the integrations provide plus the built-in vendor-neutral ones (ATIF,
 * trajectory-v1). `apps/seshi` builds it from its static integration registry and passes it
 * down (X3.11); nothing below the app imports an integration.
 *
 * A transcript comes in whole or as a chunk: the bytes of a log past a point already
 * normalized. A chunk is normalized on its own and yields the records those lines stand for,
 * without the meta record (the session's meta was made from its first chunk) and without the
 * demand that it hold a conversation. Cut at a line boundary, a log's chunks normalize to
 * exactly the records the whole log does, in order.
 *
 * Redaction is not this layer's: the pipeline passes it as `postprocess`, so that the registry
 * reports a chunk empty by what is left after it, as it always has. */

import type { Chunk, FormatAdapter, LlmCall, NormalizedRecord } from "@seshi/model";
import { VERSION } from "@seshi/model";
import { asTranscript } from "./calls";
import { detectFormat } from "./detect";
import { TRAJECTORY_VERSION } from "./letta";

/** What a stored trace records as its normalizer: this release plus the `@letta-ai/trajectory`
 * it ran, as semver build metadata. Either changing can change the records a transcript
 * normalizes to, so a reader can tell which traces a change affected. The name is the one
 * traces have always recorded, kept so a reader's filters still match. */
export const NORMALIZER = {
  name: "@dosu/sessiondb",
  version: `${VERSION}+trajectory.${TRAJECTORY_VERSION}`,
} as const;

/** The adapter's refusals that only mean "no conversation here": the session is trivial, not
 * unsupported. */
const EMPTY_CONVERSATION_CODES = new Set(["missing_user_records", "missing_assistant_records"]);

export type NormalizeOutcome =
  /** `llm_calls`: the model calls the records' `llm_call` fields name, when the log records
   * them. */
  | { records: NormalizedRecord[]; llm_calls?: LlmCall[]; empty?: false }
  /** A log with no conversation in it. */
  | { records: []; empty: true };

/** Thrown when a transcript cannot be normalized (unsupported source, unparseable transcript). */
export class NormalizeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "NormalizeError";
    this.code = code;
  }
}

export interface NormalizeInput {
  source: string;
  transcript: string;
  chunk?: Chunk;
}

export interface NormalizeOptions {
  /** Runs on the adapter's records before the outcome is decided (the pipeline's redaction). */
  postprocess?: (records: NormalizedRecord[]) => NormalizedRecord[];
}

export class FormatRegistry {
  private readonly adapters: ReadonlyMap<string, FormatAdapter>;

  /** `adapters` in the order `sources` lists them; two adapters for one name are refused. */
  constructor(adapters: readonly FormatAdapter[]) {
    const byName = new Map<string, FormatAdapter>();
    for (const adapter of adapters) {
      if (byName.has(adapter.source)) {
        throw new Error(`two format adapters are named '${adapter.source}'`);
      }
      byName.set(adapter.source, adapter);
    }
    this.adapters = byName;
  }

  /** Every format name, in registration order: the `agent` values a client may send. */
  get sources(): string[] {
    return [...this.adapters.keys()];
  }

  has(source: string): boolean {
    return this.adapters.has(source);
  }

  get(source: string): FormatAdapter | undefined {
    return this.adapters.get(source);
  }

  /** Whether a format's transcript can arrive in chunks. An ATIF document is one JSON value, so
   * it is always sent whole, whatever `format` the client says. */
  isChunkable(source: string): boolean {
    return this.adapters.get(source)?.chunkable !== false;
  }

  /** The format whose distinctive shape `sample` (the start of one file) matches, or `null` when
   * it matches none or more than one. */
  detect(sample: string): string | null {
    return detectFormat([...this.adapters.values()], sample);
  }

  /** Normalize one transcript to trajectory-v1 records. `empty` for a transcript the adapter
   * reads but finds no conversation in; throws `NormalizeError` for one it cannot read or a
   * format it does not know. With `chunk`, the transcript is a chunk of a log and the records are
   * the chunk's own: no meta record, and `empty` only when it holds no records at all. */
  normalize(input: NormalizeInput, options: NormalizeOptions = {}): NormalizeOutcome {
    const { source, transcript, chunk } = input;
    if (transcript.trim() === "") return { records: [], empty: true };
    try {
      const adapter = this.adapters.get(source);
      if (!adapter) throw new NormalizeError("unsupported_source", `no format named '${source}'`);
      const { records: raw, llm_calls } = asTranscript(adapter.normalize(transcript, chunk));
      const records = options.postprocess ? options.postprocess(raw) : raw;
      if (chunk && records.length === 0) return { records: [], empty: true };
      return llm_calls && llm_calls.length > 0 ? { records, llm_calls } : { records };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === "string" && EMPTY_CONVERSATION_CODES.has(code)) {
        return { records: [], empty: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new NormalizeError(typeof code === "string" ? code : "normalize_failed", message);
    }
  }
}
