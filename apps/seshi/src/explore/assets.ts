/** The explore page's files, served by `seshi explore`'s own handler (never as a native
 * `Bun.serve` route, which would bypass its token and Host checks and its headers). How a page
 * is bundled and loaded is in `../web/assets`. */

import { type Assets, buildAssets as build, bundleAssets } from "../web/assets";

export type { Asset, Assets } from "../web/assets";

export function buildAssets(indexPath: string): Promise<Assets> {
  return build(indexPath, "explore page");
}

let loaded: Promise<Assets> | undefined;

export function loadAssets(): Promise<Assets> {
  // `await import`, not `import().then`: `bun build --compile` turns an HTML import into a
  // value that is not a promise, and only `await` takes both.
  loaded ??= (async () =>
    bundleAssets((await import("./page/index.html")).default, "explore page"))();
  return loaded;
}
