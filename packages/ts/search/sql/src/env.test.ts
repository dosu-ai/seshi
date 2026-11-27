import { describe, expect, it } from "vitest";
import { DUCKDB_EXTENSIONS_ENV, extensionDirectory, libduckdbPath, preloadLibduckdb } from "./env";

describe("where a -sql binary finds DuckDB's files", () => {
  it("looks in duckdb/ beside the binary unless the worker's environment names a folder", () => {
    expect(extensionDirectory({}, "/opt/seshi/seshi")).toBe("/opt/seshi/duckdb");
    expect(extensionDirectory({ [DUCKDB_EXTENSIONS_ENV]: "/ext" }, "/opt/seshi/seshi")).toBe(
      "/ext",
    );
    expect(libduckdbPath("/opt/seshi/seshi", "linux")).toBe("/opt/seshi/duckdb/lib/libduckdb.so");
    expect(libduckdbPath("/opt/seshi/seshi", "darwin")).toBe(
      "/opt/seshi/duckdb/lib/libduckdb.dylib",
    );
    expect(libduckdbPath("C:\\seshi\\seshi.exe", "win32")).toBeUndefined();
  });

  it("loads nothing when there is no library beside the binary (run from source)", async () => {
    await expect(preloadLibduckdb("/nowhere/seshi")).resolves.toBeUndefined();
  });
});
