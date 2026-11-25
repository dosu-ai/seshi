import type { OpenIndex } from "./backend";

/** What the server configures the LanceDB index with (`[search.lance]`, F10.6). `@seshi/lance`'s
 * `LanceIndexOptions` adds what only its tests set. */
export interface LanceSettings {
  /** A folder, or a bucket URI LanceDB takes (`s3://`, `gs://`, `az://`). Never credentials:
   * those go in `storageOptions`. */
  uri: string;
  storageOptions?: Record<string, string>;
  /** How soon, in seconds, a reader sees another process's commit (5). 0 checks on every read. */
  readConsistency?: number;
  /** `optimize()` at most this often, in ms, and only after a commit (an hour). */
  optimizeEvery?: number;
  /** A due scrub at most this often, in ms (a day). */
  scrubEvery?: number;
  /** Rows a relevance search scores at most (10,000). */
  maxScoredRows?: number;
  /** Rows a recent search reads at most (100,000). */
  maxRecentRows?: number;
  /** An API instance: it reads and never writes, not even `meta`. */
  readOnly?: boolean;
}

/** Opens the LanceDB index from its settings: `lanceIndex` in `@seshi/lance`. */
export type LanceOpener = (options: LanceSettings) => OpenIndex;

let lance: LanceOpener | undefined;

/** Give this process the LanceDB backend (F10.6). Only the server build's entry point calls it
 * (`apps/seshi/src/main-server.ts`): `@seshi/lance` puts LanceDB's native library in the
 * compiled binary, which laptops' binaries must not carry. */
export function provideLance(open: LanceOpener): void {
  lance = open;
}

/** The LanceDB backend, when this build carries it. */
export function lanceBackend(): LanceOpener | undefined {
  return lance;
}
