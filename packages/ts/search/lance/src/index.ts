import type { OpenIndex } from "@seshi/search";
import type { LanceIndexOptions } from "./lance";

// The registry alone, which imports nothing: the server build loads this module on every
// command, and the rest of `@seshi/search` only when a command needs it.
export { type LanceSettings, provideLance } from "@seshi/search/backends";
export type { LanceIndexOptions } from "./lance";

/** Opens the LanceDB index (F10.6): what `SearchService` is given in place of SQLite. LanceDB
 * is imported only here, when the index is opened. This package is the only one that depends
 * on LanceDB and Apache Arrow: only the server build (apps/seshi/src/main-server.ts) imports
 * it, because `bun build --compile` bundles every module an import names, LanceDB's native
 * library included (about 200 MB), and laptops' binaries must not carry it. */
export function lanceIndex(options: LanceIndexOptions): OpenIndex {
  return async (index) => {
    const { openLanceIndex } = await import("./lance");
    return openLanceIndex(options, index);
  };
}
