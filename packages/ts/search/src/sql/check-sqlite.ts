import { SQLITE_FUNCTIONS, SQLITE_TABLE_FUNCTIONS } from "./functions";
import { ParseError, parseSqlite } from "./sqlparser";
import { foldName, significant, type Token, tokenize } from "./tokenize";

/** The longest statement `sql` takes, in UTF-8 bytes. It also bounds how deeply one can nest. */
export const MAX_SQL_BYTES = 16 * 1024;

/** The views a statement may read. */
export const SQL_VIEW_NAMES: readonly string[] = ["sessions", "events", "llm_calls"];

/** The SQLite index's own tables and indexes. A CTE may not take one of their names, so that a
 * mistake in the scope rules below could never let a name reach the index's table. */
const INDEX_TABLES = new Set([
  "meta",
  "feeds",
  "seen",
  "changes",
  "events_text",
  "events_text_data",
  "events_text_idx",
  "events_text_content",
  "events_text_docsize",
  "events_text_config",
  "events_by_session",
]);

/** Bare keywords no SELECT needs, which the statement kinds and clauses below refuse anyway:
 * refused again here, on SQLite's own tokens. */
const FORBIDDEN_KEYWORDS = new Set([
  "attach",
  "detach",
  "pragma",
  "vacuum",
  "insert",
  "update",
  "delete",
  "create",
  "drop",
  "alter",
  "reindex",
  "analyze",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "explain",
  "indexed",
]);

/** The statement check refused a statement: `message` says what, `at` where (a 0-based offset
 * into the text, in UTF-16 code units). */
export class SqlRefused extends Error {
  readonly kind = "refused";
  constructor(
    message: string,
    readonly at?: number,
  ) {
    super(message);
    this.name = "SqlRefused";
  }
}

export interface CheckedSql {
  /** The statement up to its last token: no trailing `;` or comment. */
  body: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The check before `prepare` (docs/seshi/session-tools.md, "The statement check"): SQLite's
 * own tokens first, then sqlparser-rs's tree. Throws `SqlRefused`. */
export function checkSqlite(sql: string): CheckedSql {
  if (typeof sql !== "string" || sql.trim() === "") throw new SqlRefused("the statement is empty");
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    throw new SqlRefused(`the statement is longer than ${MAX_SQL_BYTES} bytes`);
  }
  const body = checkTokens(sql);
  checkTree(sql);
  return { body };
}

/** The rules SQLite's own tokens can decide, whatever the parser makes of the text. */
function checkTokens(sql: string): string {
  const nul = sql.indexOf("\0");
  // SQLite stops reading at a NUL: what follows would be checked but never run, or the reverse.
  if (nul !== -1) throw new SqlRefused("the statement contains a NUL character", nul);
  const tokens = significant(tokenize(sql));
  let end = tokens.length;
  while (end > 0 && tokens[end - 1]?.kind === "semi") end--;
  if (end === 0) throw new SqlRefused("the statement is empty");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.kind === "illegal") {
      throw new SqlRefused(
        `SQLite cannot read ${JSON.stringify(token.text.slice(0, 20))}`,
        token.at,
      );
    }
    if (token.kind === "semi" && i < end) {
      throw new SqlRefused("only one statement is allowed", token.at);
    }
    if (token.kind === "variable") {
      throw new SqlRefused(`parameters are not allowed (${token.text})`, token.at);
    }
    if (token.kind !== "id") continue;
    const name = foldName(token.name ?? token.text);
    if (!token.quoted && FORBIDDEN_KEYWORDS.has(name)) {
      throw new SqlRefused(`${name.toUpperCase()} is not allowed: only SELECT`, token.at);
    }
    if (name.startsWith("sqlite_") || name.startsWith("pragma_")) {
      throw new SqlRefused(`${token.name} is not allowed`, token.at);
    }
    if ((name === "main" || name === "temp") && tokens[i + 1]?.kind === "dot") {
      throw new SqlRefused(
        `qualified names are not allowed (${token.name}.…): name the views sessions, events and llm_calls alone, and give no alias the name main or temp`,
        token.at,
      );
    }
  }
  const last = tokens[end - 1] as Token;
  return sql.slice(0, last.at + last.text.length);
}

/** Offsets of each line's start, for turning the parser's line and column into an offset. */
function lineStarts(sql: string): number[] {
  const starts = [0];
  for (let i = 0; i < sql.length; i++) if (sql.charCodeAt(i) === 0x0a) starts.push(i + 1);
  return starts;
}

/** The offset of a 1-based line and column (columns count code points, as Rust's `char`s). */
function offsetOf(
  sql: string,
  starts: number[],
  line?: number,
  column?: number,
): number | undefined {
  if (line === undefined || column === undefined) return undefined;
  let at = starts[line - 1];
  if (at === undefined) return undefined;
  for (let c = 1; c < column && at < sql.length; c++) {
    const code = sql.codePointAt(at) as number;
    at += code > 0xffff ? 2 : 1;
  }
  return at;
}

interface Part {
  name: string;
  at?: number;
}

/** An `ObjectName`'s parts: `[{"Identifier": {"value", "span"}}, …]`. */
function partsOf(name: unknown, where: (span: unknown) => number | undefined): Part[] | null {
  if (!Array.isArray(name)) return null;
  const parts: Part[] = [];
  for (const part of name) {
    const id = isObject(part) ? part.Identifier : undefined;
    if (!isObject(id) || typeof id.value !== "string") return null;
    const at = where(id.span);
    parts.push({ name: id.value, ...(at !== undefined ? { at } : {}) });
  }
  return parts;
}

/** The kinds of FROM item a statement may use. A table function in FROM comes as a `Table` with
 * `args`, or a `Function`. */
const RELATIONS = new Set(["Table", "Derived", "NestedJoin", "Function"]);

/** The rules on the parsed tree: one query; tables only the three views or a CTE in scope;
 * table functions and functions only from the allowlists; none of the clauses SQLite's SELECT
 * does not have. */
function checkTree(sql: string): void {
  let statements: unknown[];
  try {
    statements = parseSqlite(sql);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new SqlRefused(err.message, offsetOf(sql, lineStarts(sql), err.line, err.column));
    }
    throw err;
  }
  if (statements.length !== 1) throw new SqlRefused("only one statement is allowed");
  const statement = statements[0];
  const kind = isObject(statement) ? Object.keys(statement)[0] : String(statement);
  if (kind !== "Query" || !isObject(statement)) {
    throw new SqlRefused(`${kind} statements are not allowed: only SELECT`);
  }
  const starts = lineStarts(sql);
  const where = (span: unknown): number | undefined => {
    if (!isObject(span) || !isObject(span.start)) return undefined;
    const { line, column } = span.start as { line?: number; column?: number };
    return line ? offsetOf(sql, starts, line, column) : undefined;
  };

  const table = (value: Json, scope: ReadonlySet<string>): void => {
    const parts = partsOf(value.name, where);
    if (parts === null) throw new SqlRefused("a TABLE statement is not allowed");
    const last = parts[parts.length - 1] as Part;
    const display = parts.map((p) => p.name).join(".");
    if ("args" in value && value.args !== undefined && value.args !== null) {
      if (parts.length > 1 || !SQLITE_TABLE_FUNCTIONS.has(foldName(last.name))) {
        throw new SqlRefused(`table function ${display} is not allowed`, parts[0]?.at);
      }
      return;
    }
    if (parts.length > 1) {
      throw new SqlRefused(
        `qualified table names are not allowed (${display}): name sessions, events or llm_calls alone`,
        parts[0]?.at,
      );
    }
    const name = foldName(last.name);
    if (!SQL_VIEW_NAMES.includes(name) && !scope.has(name)) {
      throw new SqlRefused(
        `table ${last.name} is not allowed: read sessions, events, llm_calls or a CTE`,
        last.at,
      );
    }
    for (const hint of ["index_directives", "with_hints", "partitions"] as const) {
      const list = value[hint];
      if (Array.isArray(list) && list.length > 0) {
        throw new SqlRefused(
          hint === "index_directives" ? "INDEXED BY is not allowed" : `${hint} is not allowed`,
          last.at,
        );
      }
    }
    for (const key of ["version", "sample", "json_path", "index_hints"] as const) {
      if (value[key] !== undefined && value[key] !== null) {
        throw new SqlRefused(`${key} on a table is not allowed`, last.at);
      }
    }
  };

  const fn = (value: Json, scope: ReadonlySet<string>, relation: boolean): void => {
    const parts = partsOf(value.name, where);
    if (parts === null) throw new SqlRefused("a function with an unusual name is not allowed");
    const display = parts.map((p) => p.name).join(".");
    if (parts.length > 1) {
      throw new SqlRefused(`function ${display} is not allowed: no schema`, parts[0]?.at);
    }
    const name = foldName((parts[0] as Part).name);
    const allowed = relation ? SQLITE_TABLE_FUNCTIONS : SQLITE_FUNCTIONS;
    if (!allowed.has(name)) {
      throw new SqlRefused(
        `${relation ? "table function" : "function"} ${display} is not allowed`,
        parts[0]?.at,
      );
    }
    for (const [key, child] of Object.entries(value)) if (key !== "name") walk(child, scope);
  };

  const relationOf = (value: unknown, scope: ReadonlySet<string>): void => {
    if (!isObject(value)) return;
    const variant = Object.keys(value)[0] as string;
    if (!RELATIONS.has(variant)) {
      throw new SqlRefused(`${variant} in FROM is not allowed`);
    }
    if (variant === "Function") {
      fn(value.Function as Json, scope, true);
      return;
    }
    walk(value, scope);
  };

  const walk = (node: unknown, scope: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, scope);
      return;
    }
    if (!isObject(node)) return;
    let inner = scope;
    // A query: its CTEs are visible in each other's bodies (forward too, as in SQLite) and in
    // the query, never outside it.
    if ("body" in node && "locks" in node) {
      for (const key of ["locks", "pipe_operators"] as const) {
        const list = node[key];
        if (Array.isArray(list) && list.length > 0) throw new SqlRefused(`${key} is not allowed`);
      }
      for (const key of ["for_clause", "settings", "format_clause", "fetch"] as const) {
        if (node[key] !== undefined && node[key] !== null) {
          throw new SqlRefused(`${key} is not allowed`);
        }
      }
      const withClause = node.with;
      if (isObject(withClause) && Array.isArray(withClause.cte_tables)) {
        const names = new Set(scope);
        for (const cte of withClause.cte_tables) {
          const alias = isObject(cte) && isObject(cte.alias) ? cte.alias : undefined;
          const id = alias && isObject(alias.name) ? alias.name : undefined;
          const name = typeof id?.value === "string" ? id.value : undefined;
          if (name === undefined) throw new SqlRefused("a CTE without a name is not allowed");
          const folded = foldName(name);
          if (INDEX_TABLES.has(folded)) {
            throw new SqlRefused(`a CTE may not be named ${name}`, where(id?.span));
          }
          names.add(folded);
        }
        inner = names;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") continue;
      if (key === "relation") {
        relationOf(value, inner);
        continue;
      }
      if (key === "Table" && isObject(value)) {
        table(value, inner);
        walk(value.args, inner);
        continue;
      }
      if (key === "Function" && isObject(value) && Array.isArray(value.name)) {
        fn(value, inner, false);
        continue;
      }
      if (key === "Placeholder") throw new SqlRefused("parameters are not allowed");
      if (key === "into" && value !== null && value !== undefined) {
        throw new SqlRefused("SELECT INTO is not allowed");
      }
      if (key === "lateral_views" && Array.isArray(value) && value.length > 0) {
        throw new SqlRefused("LATERAL VIEW is not allowed");
      }
      if (["Insert", "Update", "Delete", "Merge"].includes(key)) {
        throw new SqlRefused(`${key.toUpperCase()} is not allowed: only SELECT`);
      }
      walk(value, inner);
    }
  };

  walk(statement.Query, new Set());
}

/** One row of SQLite's `EXPLAIN`. */
export interface ExplainRow {
  opcode: string;
  p2: number;
  p3: number;
  p4: unknown;
}

/** Opcodes a read never needs. `query_only` refuses writes when they run; refused here before
 * anything runs. */
const WRITE_OPCODES = new Set([
  "OpenWrite",
  "VUpdate",
  "VCreate",
  "VDestroy",
  "VRename",
  "SqlExec",
  "ParseSchema",
  "Vacuum",
  "IncrVacuum",
  "JournalMode",
  "CreateBtree",
  "Destroy",
  "Clear",
  "DropTable",
  "DropIndex",
  "DropTrigger",
]);

const FUNCTION_OPCODES = new Set([
  "Function",
  "PureFunc",
  "AggStep",
  "AggStep1",
  "AggInverse",
  "AggValue",
  "AggFinal",
]);

/** The check on what SQLite compiled (docs/seshi/session-tools.md): every `OpenRead` on main (0)
 * or temp (1), never an attached file; on main, only a table or index the views read (the root
 * pages in `roots`), never the index's own tables or `sqlite_schema`; no write; and every
 * function on the allowlist, the views' own included. It cannot tell the scoped view from a
 * direct read of `main.events`, which open the same table: the parser check decides that. */
export function checkExplain(rows: readonly ExplainRow[], roots: ReadonlySet<number>): void {
  for (const row of rows) {
    if (WRITE_OPCODES.has(row.opcode)) {
      throw new SqlRefused(`the statement would write (${row.opcode})`);
    }
    if (row.opcode === "Transaction" && row.p2 !== 0) {
      throw new SqlRefused("the statement would write (a write transaction)");
    }
    if (row.opcode === "OpenRead") {
      if (row.p3 !== 0 && row.p3 !== 1) {
        throw new SqlRefused("the statement reads a database other than the index");
      }
      if (row.p3 === 0 && !roots.has(row.p2)) {
        throw new SqlRefused("the statement reads a table outside the views");
      }
    }
    if (FUNCTION_OPCODES.has(row.opcode)) {
      const name = /^(.+?)\(-?\d+\)$/.exec(String(row.p4 ?? ""))?.[1] ?? String(row.p4);
      if (!SQLITE_FUNCTIONS.has(name.toLowerCase())) {
        throw new SqlRefused(`function ${name} is not allowed`);
      }
    }
  }
}
