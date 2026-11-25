import type { OpenIndex } from "./backend";
import type { LanceIndexOptions } from "./lance";

/** Opens the LanceDB index from its settings: `lanceIndex` in `@seshi/search/lance`. */
export type LanceOpener = (options: LanceIndexOptions) => OpenIndex;

let lance: LanceOpener | undefined;

/** Give this process the LanceDB backend (F10.6). Only the server build's entry point calls it
 * (`apps/seshi/src/main-server.ts`): importing `@seshi/search/lance` puts LanceDB's native
 * library in the compiled binary, which laptops' binaries must not carry. */
export function provideLance(open: LanceOpener): void {
  lance = open;
}

/** The LanceDB backend, when this build carries it. */
export function lanceBackend(): LanceOpener | undefined {
  return lance;
}
