import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The `sql` worker's environment variables (`sqlWorkerEnv` in `@seshi/instance` sets them, the
 * names kept the same there): the index's storage options, which are the read-only credential
 * (`[search.sql.storage]`), and where DuckDB's extensions are, when not beside the binary
 * (`[search.sql] extensions`). Only a worker's environment holds them. */
export const SQL_STORAGE_ENV = "SESHI_SQL_STORAGE";
export const DUCKDB_EXTENSIONS_ENV = "SESHI_DUCKDB_EXTENSIONS";

/** Where DuckDB looks for its `lance` extension (`<dir>/<version>/<platform>/`): the folder
 * `SESHI_DUCKDB_EXTENSIONS` names, else `duckdb/` beside the binary, where the `-sql` build's
 * archive and image put it. */
export function extensionDirectory(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): string {
  return env[DUCKDB_EXTENSIONS_ENV] || join(dirname(execPath), "duckdb");
}

/** DuckDB's own library, by platform: `@duckdb/node-bindings`' `duckdb.node` links it from its
 * own folder (`$ORIGIN`, `@loader_path`). */
export const LIBDUCKDB: Partial<Record<NodeJS.Platform, string>> = {
  linux: "libduckdb.so",
  darwin: "libduckdb.dylib",
};

/** Where a compiled `-sql` binary's archive and image put DuckDB's library: `duckdb/lib/`
 * beside the binary. */
export function libduckdbPath(
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const name = LIBDUCKDB[platform];
  return name === undefined ? undefined : join(dirname(execPath), "duckdb", "lib", name);
}

/** A compiled binary embeds `duckdb.node` and writes it to a temporary folder when it is
 * loaded, but not the library it links (`bun build --compile` carries single `.node` files
 * only), so the loader would look for that library in the temporary folder and fail. Loading
 * the library first, from beside the binary, settles the binding's link to it: the loader
 * finds a library of that name already loaded. Nothing to do when there is none there (run from
 * source, where `node_modules` has both files side by side). */
export async function preloadLibduckdb(execPath = process.execPath): Promise<void> {
  const file = libduckdbPath(execPath);
  if (file === undefined || !existsSync(file)) return;
  const { dlopen, FFIType } = await import("bun:ffi");
  // dlopen needs a symbol to bind; this one is in every libduckdb. The handle is never closed.
  dlopen(file, { duckdb_library_version: { args: [], returns: FFIType.cstring } });
}
