import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { checkExplain, checkSqlite, type ExplainRow, SqlRefused } from "./check-sqlite";
import { foldName, significant, tokenize } from "./tokenize";

function refusal(sql: string): SqlRefused {
  try {
    checkSqlite(sql);
  } catch (err) {
    if (err instanceof SqlRefused) return err;
    throw err;
  }
  throw new Error(`accepted: ${sql}`);
}

describe("SQLite's tokens (tokenize)", () => {
  const kinds = (sql: string) => significant(tokenize(sql)).map((t) => `${t.kind}:${t.text}`);

  it("read strings, quoted names and comments as SQLite does", () => {
    expect(kinds("SELECT 'it''s' -- x\n, \"a\"\"b\" /* c */")).toEqual([
      "id:SELECT",
      "string:'it''s'",
      "comma:,",
      'id:"a""b"',
    ]);
    // A backslash is no escape: the string ends at the next quote.
    expect(kinds("'a\\', b")).toEqual(["string:'a\\'", "comma:,", "id:b"]);
    expect(significant(tokenize("[a'b] `c'd`")).map((t) => t.name)).toEqual(["a'b", "c'd"]);
  });

  it("treat every character at or above 0x80 as part of a name", () => {
    expect(kinds("SELECT 1；")).toEqual(["id:SELECT", "illegal:1；"]);
    expect(kinds("x y")).toEqual(["id:x y"]);
  });

  it("run an unterminated block comment to the end, and a line comment to a newline only", () => {
    expect(kinds("SELECT 1 /* open")).toEqual(["id:SELECT", "number:1"]);
    expect(kinds("SELECT 1 -- a \r b   c")).toEqual(["id:SELECT", "number:1"]);
    expect(kinds("-- a\nSELECT")).toEqual(["id:SELECT"]);
  });

  it("know variables, numbers, blobs and operators", () => {
    expect(kinds("? ?1 :a @b $c x'00' 1e3 .5 0x1F -> ->> || <> !=")).toEqual([
      "variable:?",
      "variable:?1",
      "variable::a",
      "variable:@b",
      "variable:$c",
      "blob:x'00'",
      "number:1e3",
      "number:.5",
      "number:0x1F",
      "operator:->",
      "operator:->>",
      "operator:||",
      "operator:<>",
      "operator:!=",
    ]);
    expect(kinds("'open")).toEqual(["illegal:'open"]);
    expect(kinds("12abc #")).toEqual(["illegal:12abc", "illegal:#"]);
  });

  it("fold names as SQLite does: ASCII letters only", () => {
    expect(foldName("EVENTS")).toBe("events");
    expect(foldName("Keys")).toBe("Keys");
  });
});

describe("the statement check (checkSqlite)", () => {
  it("accepts one SELECT over the views, CTEs and allowed functions, and gives its body", () => {
    expect(checkSqlite("SELECT 1;  -- done").body).toBe("SELECT 1");
    expect(checkSqlite("WITH t AS (SELECT owner FROM sessions) SELECT * FROM t;").body).toBe(
      "WITH t AS (SELECT owner FROM sessions) SELECT * FROM t",
    );
    for (const sql of [
      "VALUES (1), (2)",
      "SELECT owner FROM sessions UNION SELECT owner FROM events",
      "SELECT * FROM (SELECT owner FROM sessions) AS x",
      "SELECT count(*) FILTER (WHERE role = 'user') FROM events",
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n",
      "SELECT j.value FROM sessions, json_each(sessions.models) AS j",
    ]) {
      expect(() => checkSqlite(sql), sql).not.toThrow();
    }
  });

  it("says what it refused and where", () => {
    expect(refusal("SELECT * FROM meta")).toMatchObject({
      at: 14,
      message: expect.stringMatching(/table meta/),
    });
    expect(refusal("SELECT * FROM main.events")).toMatchObject({ at: 14 });
    expect(refusal("SELECT 1; DROP VIEW events")).toMatchObject({
      at: 8,
      message: "only one statement is allowed",
    });
    expect(refusal("SELECT lower(x), readfile('/etc/passwd')").message).toBe(
      "function readfile is not allowed",
    );
    expect(refusal("SELECT lower(x), readfile('/etc/passwd')").at).toBe(17);
    expect(refusal("SELECT\n  x\nFROM nope").at).toBe(16);
    expect(refusal("PRAGMA query_only = 0").message).toMatch(/PRAGMA is not allowed/);
    expect(refusal("").message).toBe("the statement is empty");
    expect(refusal(" ; ").message).toBe("the statement is empty");
  });

  it("keeps a CTE's name inside its query, and never lets one shadow the index's tables", () => {
    expect(refusal("SELECT * FROM (WITH q AS (SELECT 1) SELECT * FROM q), q").message).toMatch(
      /table q is not allowed/,
    );
    expect(refusal("WITH meta AS (SELECT 1) SELECT * FROM meta").message).toMatch(
      /may not be named meta/,
    );
    expect(() =>
      checkSqlite("WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a"),
    ).not.toThrow();
  });
});

describe("the EXPLAIN check (checkExplain)", () => {
  function plan(sql: string, attach = false): { rows: ExplainRow[]; roots: Set<number> } {
    const db = new Database(":memory:");
    db.run("CREATE TABLE sessions (owner TEXT); CREATE TABLE meta (k TEXT)");
    db.run("CREATE TEMP VIEW v AS SELECT owner FROM main.sessions");
    if (attach) db.run("ATTACH ':memory:' AS other; CREATE TABLE other.t (x)");
    const roots = new Set(
      (
        db
          .query("SELECT rootpage FROM sqlite_schema WHERE tbl_name = 'sessions'")
          .values() as number[][]
      ).map((r) => r[0] as number),
    );
    const rows = db.query(`EXPLAIN ${sql}`).all() as ExplainRow[];
    db.close();
    return { rows, roots };
  }

  it("passes a read of the views with allowed functions", () => {
    const { rows, roots } = plan("SELECT lower(owner), count(*) FROM v GROUP BY 1");
    expect(() => checkExplain(rows, roots)).not.toThrow();
  });

  it("refuses an attached file, a table outside the views, and a function off the list", () => {
    const attached = plan("SELECT * FROM other.t", true);
    expect(() => checkExplain(attached.rows, attached.roots)).toThrow(/other than the index/);
    const meta = plan("SELECT * FROM main.meta");
    expect(() => checkExplain(meta.rows, meta.roots)).toThrow(/outside the views/);
    const schema = plan("SELECT * FROM sqlite_schema");
    expect(() => checkExplain(schema.rows, schema.roots)).toThrow(/outside the views/);
    const random = plan("SELECT random() FROM v");
    expect(() => checkExplain(random.rows, random.roots)).toThrow(/function random/);
  });

  it("refuses a statement that would write", () => {
    expect(() =>
      checkExplain([{ opcode: "OpenWrite", p2: 2, p3: 0, p4: null }], new Set([2])),
    ).toThrow(/would write/);
    expect(() =>
      checkExplain([{ opcode: "Transaction", p2: 1, p3: 0, p4: null }], new Set()),
    ).toThrow(/would write/);
  });
});
