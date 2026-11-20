/** The team UI's files: bundled into the binary as an HTML import, or built from source. */

import { type Assets, bundleAssets } from "../web/assets";

let loaded: Promise<Assets> | undefined;

export function loadUiAssets(): Promise<Assets> {
  // `await import`, not `import().then`: `bun build --compile` turns an HTML import into a
  // value that is not a promise, and only `await` takes both.
  loaded ??= (async () => bundleAssets((await import("./page/index.html")).default, "team UI"))();
  return loaded;
}
