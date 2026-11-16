import type { Chunk, FormatAdapter, LlmCall, NormalizedRecord, Normalizer } from "@seshi/model";
import { VERSION } from "@seshi/model";
import { asTranscript } from "./calls";
import { detectFormat } from "./detect";
import { TRAJECTORY_VERSION } from "./letta";

const LEGACY_NORMALIZER_NAME = "@dosu/sessiondb";

export const NORMALIZER = {
  name: LEGACY_NORMALIZER_NAME,
  version: `${VERSION}+trajectory.${TRAJECTORY_VERSION}`,
} as const;

const FIRST_VERSION = "1";

export function compareNormalizerVersions(a: string, b: string): number {
  const numbers = (v: string) => (v.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const EMPTY_CONVERSATION_CODES = new Set(["missing_user_records", "missing_assistant_records"]);

export type NormalizeOutcome =
  | { records: NormalizedRecord[]; llm_calls?: LlmCall[]; empty?: false }
  | { records: []; empty: true };

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
  postprocess?: (records: NormalizedRecord[]) => NormalizedRecord[];
}

export class FormatRegistry {
  private readonly adapters: ReadonlyMap<string, FormatAdapter>;

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

  get sources(): string[] {
    return [...this.adapters.keys()];
  }

  has(source: string): boolean {
    return this.adapters.has(source);
  }

  versionOf(source: string): string | undefined {
    const adapter = this.adapters.get(source);
    return adapter ? (adapter.version ?? FIRST_VERSION) : undefined;
  }

  normalizerFor(source: string): Normalizer {
    const format_version = this.versionOf(source);
    return format_version ? { ...NORMALIZER, format_version } : { ...NORMALIZER };
  }

  isStale(source: string, builtWith: string | undefined): boolean {
    const current = this.versionOf(source);
    if (current === undefined) return false;
    return builtWith === undefined || compareNormalizerVersions(builtWith, current) < 0;
  }

  get(source: string): FormatAdapter | undefined {
    return this.adapters.get(source);
  }

  isChunkable(source: string): boolean {
    return this.adapters.get(source)?.chunkable !== false;
  }

  detect(sample: string): string | null {
    return detectFormat([...this.adapters.values()], sample);
  }

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
