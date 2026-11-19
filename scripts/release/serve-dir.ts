/** Serves a folder over HTTP on 127.0.0.1, for trying the install scripts against a local
 * release (CI's binaries job; PowerShell 7 cannot read file:// URLs).
 *
 *   bun run scripts/release/serve-dir.ts <folder> [port]
 *
 * Lay the folder out as GitHub does (`latest/download/<asset>`, `download/v<X.Y.Z>/<asset>`)
 * and pass `http://127.0.0.1:<port>` as the install script's base URL. */

import { existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

export function serveDir(root: string): (req: Request) => Response {
  const base = resolve(root);
  return (req) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    const file = normalize(join(base, path));
    if (
      (file !== base && !file.startsWith(base + sep)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      return new Response("not found\n", { status: 404 });
    }
    return new Response(Bun.file(file));
  };
}

if (import.meta.main) {
  const [root, port] = process.argv.slice(2);
  if (!root) {
    console.error("usage: bun run scripts/release/serve-dir.ts <folder> [port]");
    process.exit(2);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: port ? Number(port) : 0,
    fetch: serveDir(root),
  });
  console.log(`serving ${resolve(root)} at http://127.0.0.1:${server.port}`);
}
