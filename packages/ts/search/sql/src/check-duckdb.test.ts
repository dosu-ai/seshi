import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { MAX_SQL_BYTES, SqlRefused } from "@seshi/search";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDuckdb, checkDuckdbTree, SqlUnparsed } from "./check-duckdb";
import { DUCKDB_FUNCTIONS } from "./functions";

// DuckDB's parser only: no extension, no views. What the corpus does not cover by shape.
let instance: DuckDBInstance;
let connection: DuckDBConnection;

beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:");
  connection = await DuckDBConnection.create(instance);
});

afterAll(() => {
  connection?.closeSync();
  instance?.closeSync();
});

async function refusal(sql: string): Promise<SqlRefused> {
  try {
    await checkDuckdb(connection, sql);
  } catch (err) {
    if (err instanceof SqlRefused) return err;
    throw err;
  }
  throw new Error(`accepted: ${sql}`);
}

const accepts = (sql: string) => expect(checkDuckdb(connection, sql)).resolves.toBeUndefined();

describe("the statement check on DuckDB (checkDuckdb)", () => {
  it("accepts one SELECT over the views, with DuckDB's own clauses", async () => {
    for (const sql of [
      "SELECT 1",
      "FROM sessions",
      "SELECT * FROM events e JOIN sessions s USING (owner, archive_id)",
      "SELECT owner, count(*) FROM sessions GROUP BY ALL ORDER BY ALL",
      "SELECT DISTINCT ON (owner) owner, started_at FROM sessions ORDER BY owner, started_at DESC",
      "SELECT * FROM events ASOF JOIN llm_calls c ON events.ts >= c.started_at",
      "SELECT * FROM sessions UNION ALL BY NAME SELECT * FROM sessions",
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t",
      "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT * FROM b, a",
      "SELECT (WITH q AS (SELECT 1) SELECT * FROM q)",
      "SELECT * FROM events WHERE seq IN (SELECT seq FROM events) WINDOW w AS (ORDER BY ts) QUALIFY row_number() OVER w = 1",
      'SELECT count(*) FROM "Events"',
      "SELECT * FROM sessions s, LATERAL (SELECT s.owner) x",
    ]) {
      await accepts(sql);
    }
  });

  it("lets a CTE read only the CTEs before it (and itself when recursive), as DuckDB binds", async () => {
    expect(
      (await refusal("WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a")).message,
    ).toMatch(/^b: only sessions, events, llm_calls and CTEs defined before it/);
    await refusal("WITH a AS (SELECT * FROM a) SELECT * FROM a");
    await refusal("SELECT * FROM (WITH x AS (SELECT 1) SELECT * FROM x) JOIN x USING (owner)");
    await refusal(
      "WITH x AS (SELECT 1) SELECT * FROM (SELECT * FROM x), (WITH y AS (SELECT 1) SELECT 1), y",
    );
    await accepts("WITH x AS (SELECT 1) SELECT * FROM (SELECT * FROM x)");
  });

  it("says where a refused table or function is, in characters", async () => {
    const table = await refusal("SELECT 'é', * FROM read_csv('x.csv')");
    expect(table.message).toBe("table function read_csv is not allowed");
    expect(table.at).toBe(19);
    const fn = await refusal("SELECT  version()");
    expect(fn.message).toBe("function version is not allowed");
    expect(fn.at).toBe(8);
    expect((await refusal("SELECT main.lower('x')")).message).toMatch(/may not name a schema/);
    expect((await refusal("SELECT * FROM events WHERE owner = $1")).message).toMatch(/parameters/);
  });

  it("refuses by kind before it reads a tree, and bounds the text", async () => {
    expect((await refusal("COPY events TO 'x.csv'")).message).toMatch(/only one SELECT/);
    // DESCRIBE, SHOW and SUMMARIZE are SELECTs over a SHOW_REF in DuckDB's tree.
    expect((await refusal("DESCRIBE events")).message).toBe("show ref is not allowed");
    expect((await refusal("SELECT 1; SELECT 2")).message).toBe("only one statement is allowed");
    await expect(checkDuckdb(connection, "SELEC 1")).rejects.toBeInstanceOf(SqlUnparsed);
    const pad = (n: number) => `SELECT 1 AS x${" ".repeat(n - "SELECT 1 AS x".length)}`;
    await accepts(pad(MAX_SQL_BYTES));
    expect((await refusal(pad(MAX_SQL_BYTES + 1))).message).toMatch(/longer than 16384 bytes/);
    expect((await refusal("SELECT 1\u0000; DROP VIEW events")).at).toBe(8);
    // Deep nesting stops at DuckDB's own parser, not this process's stack.
    await expect(
      checkDuckdb(connection, `SELECT ${"(".repeat(5_000)}1${")".repeat(5_000)}`),
    ).rejects.toThrow();
  });

  it("fails closed on a node it does not know", () => {
    const tree = (node: object) =>
      JSON.stringify({ error: false, statements: [{ node, named_param_map: [] }] });
    const select = (fields: object) => ({
      type: "SELECT_NODE",
      modifiers: [],
      cte_map: { map: [] },
      select_list: [],
      from_table: { type: "EMPTY", alias: "", sample: null },
      ...fields,
    });
    expect(() => checkDuckdbTree(tree(select({})), "")).not.toThrow();
    expect(() => checkDuckdbTree(tree({ type: "INSERT_NODE", cte_map: { map: [] } }), "")).toThrow(
      /insert node is not allowed/,
    );
    expect(() =>
      checkDuckdbTree(
        tree(select({ from_table: { type: "SHOW_REF", alias: "", sample: null } })),
        "",
      ),
    ).toThrow(/show ref is not allowed/);
    expect(() =>
      checkDuckdbTree(
        tree(select({ from_table: { type: "NEW_KIND_REF", alias: "", sample: null } })),
        "",
      ),
    ).toThrow(/new kind ref is not allowed/);
    expect(() =>
      checkDuckdbTree(tree(select({ select_list: [{ class: "NEW_EXPRESSION" }] })), ""),
    ).toThrow(/new expression is not allowed/);
  });

  it("keeps the allowlist to functions DuckDB has", async () => {
    const reader = await connection.runAndReadAll(
      "SELECT DISTINCT function_name FROM duckdb_functions()",
    );
    const known = new Set(reader.getRows().map((r) => String(r[0])));
    const missing = [...DUCKDB_FUNCTIONS].filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });
});
