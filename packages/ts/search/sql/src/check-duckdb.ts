import type { DuckDBConnection } from "@duckdb/node-api";
import { MAX_SQL_BYTES, SQL_VIEW_NAMES, SqlRefused } from "@seshi/search";
import { DUCKDB_EXPRESSIONS, DUCKDB_FUNCTIONS } from "./functions";

/** A statement DuckDB's parser could not read: the worker answers it `bind`, as SQLite's
 * compile errors are. */
export class SqlUnparsed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlUnparsed";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Node = { [key: string]: Json };

/** The table references a statement may hold besides `BASE_TABLE`s that name a view or a CTE in
 * scope. Not `TABLE_FUNCTION` (which reads files, settings and other Lance tables), `PIVOT`,
 * `SHOW_REF`, or any kind a newer DuckDB adds. */
const TABLE_REFS: ReadonlySet<string> = new Set([
  "BASE_TABLE",
  "JOIN",
  "SUBQUERY",
  "EMPTY",
  "EXPRESSION_LIST",
]);

/** The query nodes a statement may hold. */
const QUERY_NODES: ReadonlySet<string> = new Set([
  "SELECT_NODE",
  "SET_OPERATION_NODE",
  "RECURSIVE_CTE_NODE",
]);

/** DuckDB's identifiers fold ASCII case only; anything else must match exactly. */
function fold(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

const VIEWS: ReadonlySet<string> = new Set(SQL_VIEW_NAMES);

/** Where a node starts in the statement, as a character offset (DuckDB gives UTF-8 bytes), when
 * it says. */
function at(node: Node, text: Buffer): number | undefined {
  const location = node.query_location;
  if (typeof location !== "number" || location < 0 || location > text.length) return undefined;
  return text.subarray(0, location).toString("utf8").length;
}

function isNode(value: Json): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameOf(value: Json): string {
  return typeof value === "string" ? value : "";
}

/** Walks the tree `json_serialize_sql` gives for one statement and refuses what the rules in
 * docs/seshi/session-tools.md ("The statement check") leave out. It refuses by shape: every
 * node is looked at, and a table reference, query node or expression of a kind it does not
 * know is refused, so a DuckDB that adds one fails closed. */
class Walker {
  constructor(private readonly text: Buffer) {}

  refuse(message: string, node?: Node): never {
    throw new SqlRefused(message, node ? at(node, this.text) : undefined);
  }

  /** Any value, with the CTE names in scope where it sits. */
  value(value: Json, scope: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) this.value(item, scope);
      return;
    }
    if (!isNode(value)) return;
    if (typeof value.class === "string") {
      this.expression(value, scope);
      return;
    }
    if ("cte_map" in value) {
      this.query(value, scope);
      return;
    }
    if ("sample" in value && "alias" in value && typeof value.type === "string") {
      this.table(value, scope);
      return;
    }
    if (typeof value.type === "string" && /TABLE_FUNCTION|PIVOT|SHOW/.test(value.type)) {
      this.refuse(`${value.type.toLowerCase().replaceAll("_", " ")} is not allowed`, value);
    }
    for (const child of Object.values(value)) this.value(child, scope);
  }

  /** A query node: its CTEs first, each seeing only those before it (and itself when
   * recursive), as DuckDB binds them; then the rest, seeing them all. */
  query(node: Node, outer: ReadonlySet<string>): void {
    const type = nameOf(node.type);
    if (!QUERY_NODES.has(type)) {
      this.refuse(`${type.toLowerCase().replaceAll("_", " ")} is not allowed`, node);
    }
    const scope = new Set(outer);
    const ctes = isNode(node.cte_map) ? node.cte_map.map : undefined;
    for (const entry of Array.isArray(ctes) ? ctes : []) {
      if (!isNode(entry)) continue;
      const name = fold(nameOf(entry.key));
      const cte = isNode(entry.value) ? entry.value : {};
      const body = cte.query_node ?? (isNode(cte.query) ? cte.query.node : null);
      const recursive = isNode(body) && body.type === "RECURSIVE_CTE_NODE";
      const own = recursive ? new Set([...scope, name]) : scope;
      for (const [key, child] of Object.entries(cte)) {
        if (key !== "query_node" && key !== "query") this.value(child, scope);
      }
      if (!isNode(body)) this.refuse(`the CTE ${name} has no query`);
      this.query(body, own);
      scope.add(name);
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "cte_map") this.value(child, scope);
    }
  }

  /** A table reference: an unqualified name that is a view or a CTE in scope, or a join,
   * subquery or `VALUES` of them. */
  table(node: Node, scope: ReadonlySet<string>): void {
    const type = nameOf(node.type);
    if (!TABLE_REFS.has(type)) {
      if (type === "TABLE_FUNCTION") {
        const fn = isNode(node.function) ? nameOf(node.function.function_name) : "";
        this.refuse(`table function ${fn || "(unnamed)"} is not allowed`, node);
      }
      this.refuse(`${type.toLowerCase().replaceAll("_", " ")} is not allowed`, node);
    }
    if (type === "BASE_TABLE") {
      const name = nameOf(node.table_name);
      const path = isNode(node.qualified_name) ? node.qualified_name.path : undefined;
      if (
        nameOf(node.schema_name) !== "" ||
        nameOf(node.catalog_name) !== "" ||
        (Array.isArray(path) && path.length !== 1)
      ) {
        this.refuse(
          `${[node.catalog_name, node.schema_name, name].filter((p) => p).join(".")}: only sessions, events and llm_calls, unqualified, may be read`,
          node,
        );
      }
      if (node.at_clause !== null && node.at_clause !== undefined) {
        this.refuse(`${name} AT (…): reading an earlier version is not allowed`, node);
      }
      const folded = fold(name);
      if (!VIEWS.has(folded) && !scope.has(folded)) {
        this.refuse(
          `${name}: only sessions, events, llm_calls and CTEs defined before it may be read`,
          node,
        );
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type") this.value(child, scope);
    }
  }

  expression(node: Node, scope: ReadonlySet<string>): void {
    const kind = nameOf(node.class);
    if (kind === "PARAMETER") this.refuse("parameters are not allowed", node);
    if (!DUCKDB_EXPRESSIONS.has(kind)) {
      this.refuse(`${kind.toLowerCase().replaceAll("_", " ")} is not allowed`, node);
    }
    if (kind === "FUNCTION" || kind === "WINDOW") {
      const name = nameOf(node.function_name);
      const path = isNode(node.qualified_name) ? node.qualified_name.path : undefined;
      if (
        nameOf(node.schema) !== "" ||
        nameOf(node.catalog) !== "" ||
        (Array.isArray(path) && path.length > 1)
      ) {
        this.refuse(`${name}: a function may not name a schema`, node);
      }
      if (!DUCKDB_FUNCTIONS.has(fold(name))) this.refuse(`function ${name} is not allowed`, node);
    }
    for (const child of Object.values(node)) this.value(child, scope);
  }
}

/** Check a tree `json_serialize_sql` gave for `sql`: exactly one statement, every table a view
 * or a CTE in scope, no table function, no time travel, every function on the allowlist. */
export function checkDuckdbTree(serialized: string, sql: string): void {
  let tree: Json;
  try {
    tree = JSON.parse(serialized) as Json;
  } catch {
    throw new SqlRefused("the statement could not be read");
  }
  if (!isNode(tree)) throw new SqlRefused("the statement could not be read");
  if (tree.error === true) {
    const message = nameOf(tree.error_message);
    if (/only select statements/i.test(message)) {
      throw new SqlRefused("only one SELECT is allowed: not another kind of statement");
    }
    throw new SqlUnparsed(message || "the statement could not be parsed");
  }
  const statements = tree.statements;
  if (!Array.isArray(statements) || statements.length !== 1) {
    throw new SqlRefused("only one statement is allowed");
  }
  const statement = statements[0];
  if (!isNode(statement) || !isNode(statement.node)) {
    throw new SqlRefused("the statement could not be read");
  }
  const params = statement.named_param_map;
  if (Array.isArray(params) && params.length > 0)
    throw new SqlRefused("parameters are not allowed");
  new Walker(Buffer.from(sql, "utf8")).query(statement.node, new Set());
}

/** The statement check on DuckDB (docs/seshi/session-tools.md): its size, then DuckDB's own
 * parser (`json_serialize_sql`, which serializes only `SELECT`s), then `checkDuckdbTree`.
 * `connection` is the query's own, before its catalog holds anything but the views. Throws
 * `SqlRefused`, or `SqlUnparsed` for a statement DuckDB cannot parse. */
export async function checkDuckdb(connection: DuckDBConnection, sql: string): Promise<void> {
  if (Buffer.byteLength(sql, "utf8") > MAX_SQL_BYTES) {
    throw new SqlRefused(`the statement is longer than ${MAX_SQL_BYTES} bytes`);
  }
  // DuckDB reads text as a C string: whatever followed a NUL would not be what it checked.
  const nul = sql.indexOf("\u0000");
  if (nul !== -1) throw new SqlRefused("the statement holds a NUL character", nul);
  const prepared = await connection.prepare("SELECT json_serialize_sql($1)");
  try {
    prepared.bindVarchar(1, sql);
    const reader = await prepared.runAndReadAll();
    const serialized = reader.getRows()[0]?.[0];
    if (typeof serialized !== "string") throw new SqlRefused("the statement could not be read");
    checkDuckdbTree(serialized, sql);
  } finally {
    prepared.destroySync();
  }
}
