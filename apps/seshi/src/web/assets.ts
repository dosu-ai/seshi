/** A page's files, for a server's own handler to serve (never a native `Bun.serve` HTML route,
 * which would bypass the handler's checks and its headers). `seshi explore` and the team UI
 * (`seshi serve`, `/ui/`) both load theirs here.
 *
 * A page is an HTML import, so `bun build --compile` bundles it into the binary: there the
 * import's `files` are the built files under `/$bunfs/root/`, which the HTML links from `/`.
 * Run from source, the import names only the source HTML, which is bundled here once with
 * `Bun.build` (`publicPath: "/"`, the same root-level paths). Either way the HTML links its
 * files from `/<name>`, and `files` holds them under that path. */

import { basename } from "node:path";

export interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

export interface Assets {
  index: string;
  files: Map<string, Asset>;
}

/** What an HTML import is: `files` only in a compiled binary. */
export interface HtmlBundle {
  index: string;
  files?: readonly { path: string; loader: string; headers: Record<string, string> }[];
}

/** Bundle the page at `indexPath` (a source run, and tests). `name` is for the error. */
export async function buildAssets(indexPath: string, name = "page"): Promise<Assets> {
  const built = await Bun.build({
    entrypoints: [indexPath],
    target: "browser",
    publicPath: "/",
    minify: true,
  });
  if (!built.success) {
    throw new Error(`the ${name} did not build: ${built.logs.map(String).join("\n")}`);
  }
  let index: string | undefined;
  const files = new Map<string, Asset>();
  for (const output of built.outputs) {
    const path = `/${basename(output.path)}`;
    if (path.endsWith(".html")) index = await output.text();
    else files.set(path, { body: new Uint8Array(await output.arrayBuffer()), type: output.type });
  }
  if (index === undefined) throw new Error(`the ${name} built no HTML`);
  return { index, files };
}

/** The files of an imported HTML bundle: read from the binary, or built from source. */
export async function bundleAssets(bundle: HtmlBundle, name = "page"): Promise<Assets> {
  if (!bundle.files) return buildAssets(bundle.index, name);
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
  if (index === undefined) throw new Error(`the binary carries no ${name}`);
  return { index, files };
}
