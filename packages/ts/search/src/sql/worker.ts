import { Database } from "bun:sqlite";
import {
  checkExplain,
  checkSqlite,
  type ExplainRow,
  SQL_VIEW_NAMES,
  SqlRefused,
} from "./check-sqlite";
import type {
  SqlColumnInfo,
  SqlErrorKind,
  SqlWorkerReady,
  SqlWorkerRequest,
  SqlWorkerResponse,
} from "./protocol";

class QueryFailed extends Error {
  constructor(
    readonly kind: SqlErrorKind,
    message: string,
  ) {
    super(message);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A value as JSON carries it: a blob as hex, an integer past 2^53 as text. */
function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return value;
}

function typeOf(
  declared: string | null | undefined,
  rows: readonly unknown[][],
  i: number,
): string {
  if (declared) return declared.toUpperCase();
  for (const row of rows) {
    const value = row[i];
    if (value === null || value === undefined) continue;
    if (typeof value === "number") return Number.isInteger(value) ? "INTEGER" : "REAL";
    if (value instanceof Uint8Array) return "BLOB";
    return "TEXT";
  }
  return "NULL";
}

/** Run one statement against a SQLite index (docs/seshi/session-tools.md, "A SQLite query"):
 * open the file read-only, create the caller's views as `TEMP` views, turn on `query_only`, check
 * the statement (the parser, then `EXPLAIN`), and read at most `max_rows` rows and `max_bytes` of
 * them. There is no interrupt: the watchdog kills this process at the timeout. */
export function runSqliteQuery(request: SqlWorkerRequest): SqlWorkerResponse {
  const started = performance.now();
  const { id, limits } = request;
  let db: Database | undefined;
  try {
    const checked = checkSqlite(request.sql);
    try {
      db = new Database(request.setup.file, { readonly: true });
    } catch (err) {
      throw new QueryFailed("internal", `cannot open the index: ${messageOf(err)}`);
    }
    db.run("PRAGMA temp_store = MEMORY");
    if (limits.memory_bytes !== undefined && limits.memory_bytes > 0) {
      db.run(`PRAGMA hard_heap_limit = ${Math.floor(limits.memory_bytes)}`);
    }
    for (const view of request.setup.views) db.run(view);
    db.run("PRAGMA query_only = 1");
    const roots = new Set(
      (
        db
          .query(
            `SELECT rootpage FROM main.sqlite_schema WHERE rootpage > 0 AND tbl_name IN (${SQL_VIEW_NAMES.map((n) => `'${n}'`).join(", ")})`,
          )
          .values() as number[][]
      ).map((r) => r[0] as number),
    );
    let plan: ExplainRow[];
    try {
      plan = db.query(`EXPLAIN ${checked.body}`).all() as ExplainRow[];
    } catch (err) {
      throw new QueryFailed("bind", messageOf(err));
    }
    checkExplain(plan, roots);
    let columns: string[];
    try {
      const statement = db.prepare(checked.body);
      columns = statement.columnNames;
      statement.finalize();
    } catch (err) {
      throw new QueryFailed("bind", messageOf(err));
    }
    // Rows as arrays, so columns of the same name stay apart: `values()` over the statement
    // capped one past `max_rows`, which tells a full answer from a cut one.
    let raw: unknown[][];
    let declared: (string | null)[] = [];
    try {
      const capped = db.prepare(
        `SELECT * FROM (\n${checked.body}\n) LIMIT ${Math.floor(limits.max_rows) + 1}`,
      );
      raw = capped.values() as unknown[][];
      // Known once it has run: a column read straight from a view's column has its type.
      declared = capped.declaredTypes;
    } catch (err) {
      const message = messageOf(err);
      throw new QueryFailed(/out of memory/i.test(message) ? "memory" : "runtime", message);
    }
    let truncated = raw.length > limits.max_rows;
    const rows: unknown[][] = [];
    let bytes = 2;
    for (const row of raw.slice(0, limits.max_rows)) {
      const values = row.map(jsonValue);
      bytes += Buffer.byteLength(JSON.stringify(values), "utf8") + 1;
      if (bytes > limits.max_bytes) {
        truncated = true;
        break;
      }
      rows.push(values);
    }
    const info: SqlColumnInfo[] = columns.map((name, i) => ({
      name,
      type: typeOf(declared[i], raw, i),
    }));
    return {
      id,
      ok: true,
      columns: info,
      rows,
      truncated,
      elapsed_ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    if (err instanceof SqlRefused) {
      return {
        id,
        ok: false,
        error: {
          kind: "refused",
          message: err.message,
          ...(err.at !== undefined ? { at: err.at } : {}),
        },
      };
    }
    if (err instanceof QueryFailed)
      return { id, ok: false, error: { kind: err.kind, message: err.message } };
    return { id, ok: false, error: { kind: "internal", message: messageOf(err) } };
  } finally {
    db?.close();
  }
}

/** One request, whatever arrives: a line that is not a request is answered `internal`. */
export function handleLine(line: string): SqlWorkerResponse {
  let request: SqlWorkerRequest;
  try {
    request = JSON.parse(line) as SqlWorkerRequest;
  } catch {
    return { id: "", ok: false, error: { kind: "internal", message: "the request is not JSON" } };
  }
  if (request?.engine !== "sqlite") {
    return {
      id: String(request?.id ?? ""),
      ok: false,
      error: {
        kind: "internal",
        message: `this worker runs SQLite, not ${String(request?.engine)}`,
      },
    };
  }
  return runSqliteQuery(request);
}

/** The lines of `input`, split on `\n` only: JSON may hold U+2028 and U+2029 unescaped, which
 * `node:readline` would take for line breaks. */
async function* linesOf(input: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of input) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl = buffered.indexOf("\n");
    while (nl !== -1) {
      yield buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      nl = buffered.indexOf("\n");
    }
  }
  if (buffered !== "") yield buffered;
}

/** A line of the protocol: JSON with U+2028 and U+2029 escaped, so no reader splits it. */
export function protocolLine(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** `seshi sql-worker`: answer requests on stdin, one at a time, until stdin closes. The parser is
 * loaded before it says it is ready, so the first query does not pay for it. */
export async function runSqlWorker(
  input: AsyncIterable<Uint8Array | string> = process.stdin,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  try {
    checkSqlite("SELECT 1");
  } catch {
    // Loading the parser failed: each query says so.
  }
  const ready: SqlWorkerReady = { ready: true, pid: process.pid };
  write(protocolLine(ready));
  for await (const line of linesOf(input)) {
    if (line.trim() === "") continue;
    write(protocolLine(handleLine(line)));
  }
}
