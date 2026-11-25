import type { OpenIndex } from "./backend";
import type { LanceIndexOptions } from "./lance";

export type { LanceIndexOptions } from "./lance";

/** Opens the LanceDB index (F10.6): what `SearchService` is given in place of SQLite. LanceDB
 * is imported only here, when the index is opened, so it stays off every other path (X3.3).
 * It is exported as `@seshi/search/lance`, not from the package's index: `bun build --compile`
 * bundles every module a dynamic import names, LanceDB's native library included (about 250
 * MB), so only a build that means to carry it may import this. */
export function lanceIndex(options: LanceIndexOptions): OpenIndex {
  return async (index) => {
    const { openLanceIndex } = await import("./lance");
    return openLanceIndex(options, index);
  };
}
