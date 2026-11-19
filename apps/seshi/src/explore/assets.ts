/** The page's files, served by `seshi explore`'s own handler (never as a native `Bun.serve`
 * route, which would bypass its token and Host checks and its headers).
 *
 * The page is an HTML import, so `bun build --compile` bundles it into the binary: there the
 * import's `files` are the built files under `/$bunfs/root/`, which the HTML links from `/`.
 * Run from source, the import names only the source HTML, which is bundled here once with
 * `Bun.build` (`publicPath: "/"`, the same root-level paths). */

import { basename } from "node:path";

export interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export interface Assets {
  index: string;
  files: Map<string, Asset>;
}

export async function buildAssets(indexPath: string): Promise<Assets> {
  const built = await Bun.build({
    entrypoints: [indexPath],
    target: "browser",
    publicPath: "/",
    minify: true,
  });
  if (!built.success) {
    throw new Error(`the explore page did not build: ${built.logs.map(String).join("\n")}`);
  }
  let index: string | undefined;
  const files = new Map<string, Asset>();
  for (const output of built.outputs) {
    const path = `/${basename(output.path)}`;
    if (path.endsWith(".html")) index = await output.text();
    else files.set(path, { body: new Uint8Array(await output.arrayBuffer()), type: output.type });
  }
  if (index === undefined) throw new Error("the explore page built no HTML");
  return { index, files };
}

let loaded: Promise<Assets> | undefined;

export function loadAssets(): Promise<Assets> {
  loaded ??= (async () => {
    const bundle = (await import("./page/index.html")).default;
    if (!bundle.files) return buildAssets(bundle.index);
    let index: string | undefined;
    const files = new Map<string, Asset>();
    for (const file of bundle.files) {
      const blob = Bun.file(file.path);
      if (file.loader === "html") index = await blob.text();
      else {
        files.set(`/${basename(file.path)}`, {
          body: new Uint8Array(await blob.arrayBuffer()),
          type: file.headers["content-type"] ?? blob.type,
        });
      }
    }
    if (index === undefined) throw new Error("the binary carries no explore page");
    return { index, files };
  })();
  return loaded;
}
