import { readFileSync } from "node:fs";
import { initSync, parse_sql } from "@guanmingchiu/sqlparser-ts/wasm/sqlparser_rs_wasm.js";
import wasmPath from "@guanmingchiu/sqlparser-ts/wasm/sqlparser_rs_wasm_bg.wasm" with {
  type: "file",
};

/** sqlparser-rs (Apache DataFusion's SQL parser), compiled to WebAssembly: the parser behind
 * `sql`'s statement check on SQLite (docs/seshi/session-tools.md, open question 4). The package's
 * own `init()` reads the `.wasm` by URL, which a compiled seshi binary cannot; importing the file
 * `with { type: "file" }` embeds it, and `patches/` exports the two files this needs. */
let ready = false;

function load(): void {
  if (ready) return;
  initSync({ module: readFileSync(wasmPath) });
  ready = true;
}

export class ParseError extends Error {
  constructor(
    message: string,
    /** Where the parser stopped, as 1-based line and column, when it said. */
    readonly line?: number,
    readonly column?: number,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/** The statements of `sql` as sqlparser-rs's JSON tree, in its SQLite dialect. */
export function parseSqlite(sql: string): unknown[] {
  load();
  try {
    return parse_sql("sqlite", sql) as unknown[];
  } catch (err) {
    const message =
      typeof err === "object" && err !== null && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    const where = /at Line: (\d+), Column: (\d+)/.exec(message);
    const text = message
      .replace(/^sql parser error: /, "")
      .replace(/ at Line: \d+, Column: \d+$/, "");
    throw new ParseError(
      /recursion limit exceeded/.test(text) ? "the statement is nested too deeply" : text,
      where ? Number(where[1]) : undefined,
      where ? Number(where[2]) : undefined,
    );
  }
}
