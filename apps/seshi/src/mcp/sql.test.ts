import type { SqlDialect, SqlResult, SqlSchema } from "@seshi/model";
import { SQL_DIALECT_HINT, SQL_EXAMPLES, SQL_VIEWS, sqlSchema } from "@seshi/search";
import { describe, expect, it } from "vitest";
import { SQL_CELL_CHARS, sqlCell, sqlResultLines, sqlToolDescription } from "./sql";

function schemaOf(dialect: SqlDialect, role = "member"): SqlSchema {
  return {
    dialect,
    hint: SQL_DIALECT_HINT[dialect],
    ddl: sqlSchema(dialect),
    examples: [...SQL_EXAMPLES[dialect]],
    scope: { as: "alice", role, since: "2026-10-26T12:00:00Z", until: "2026-11-25T12:00:00Z" },
    index: { backend: dialect === "sqlite" ? "sqlite" : "lance", dialect },
    limits: { max_rows: 1000, max_bytes: 1_048_576, timeout_ms: 15_000, max_sql_bytes: 16_384 },
  };
}

describe("the sql tool's description", () => {
  for (const dialect of ["sqlite", "duckdb"] as const) {
    it(`is written from the ${dialect} schema: dialect first, every view's column, the examples`, () => {
      const text = sqlToolDescription(schemaOf(dialect));
      expect(text.startsWith(`Write ${SQL_DIALECT_HINT[dialect]}`)).toBe(true);
      expect(text).toContain(sqlSchema(dialect));
      for (const view of SQL_VIEWS) {
        expect(text).toContain(`CREATE VIEW ${view.name} (`);
        for (const column of view.columns) expect(text).toMatch(new RegExp(`\\n  ${column.name} `));
      }
      for (const example of SQL_EXAMPLES[dialect]) expect(text).toContain(example);
      expect(text).toContain("at most 16 KiB; 15 s; at most 1,000 rows and 1 MB");
      // About 4,500 characters: worth its place in the tool list, not more.
      expect(text.length).toBeLessThan(6000);
    });
  }

  it("names the dialect's own idioms, not the other's", () => {
    expect(sqlToolDescription(schemaOf("sqlite"))).not.toContain("GROUP BY ALL");
    expect(sqlToolDescription(schemaOf("duckdb"))).toContain("GROUP BY ALL");
    expect(sqlToolDescription(schemaOf("duckdb"))).not.toContain("datetime('now'");
  });

  it("says whose sessions the views hold", () => {
    expect(sqlToolDescription(schemaOf("sqlite", "admin"))).toContain("every session");
    expect(sqlToolDescription(schemaOf("sqlite", "service"))).toContain("every session");
    expect(sqlToolDescription(schemaOf("duckdb", "member"))).toContain(
      "your own sessions and the org's",
    );
    expect(sqlToolDescription(schemaOf("sqlite", "local"))).toContain(
      "this machine's own search index",
    );
  });
});

describe("sql answers", () => {
  const result = (rows: unknown[][], truncated = false): SqlResult => ({
    now: "2026-11-25T12:00:00Z",
    scope: { as: "alice", role: "admin", since: "", until: "" },
    index: { backend: "sqlite", dialect: "sqlite" },
    columns: [
      { name: "owner", type: "TEXT" },
      { name: "tokens", type: "INTEGER" },
    ],
    rows,
    truncated,
    elapsed_ms: 231,
  });

  it("are a pipe table, NULL for nulls, then the count and time", () => {
    expect(
      sqlResultLines(
        result([
          ["alice", 1200],
          [null, 3],
        ]),
      ),
    ).toEqual([
      "| owner | tokens |",
      "| --- | --- |",
      "| alice | 1200 |",
      "| NULL | 3 |",
      "2 rows · 231 ms",
    ]);
  });

  it("say when they were truncated", () => {
    expect(sqlResultLines(result([["a", 1]], true)).at(-1)).toBe(
      "truncated at 1 row: add LIMIT or aggregate · 231 ms",
    );
  });

  it("keep a cell on one line, escape pipes, and cut it saying how much was left", () => {
    expect(sqlCell("a|b\nc")).toBe("a\\|b\\nc");
    expect(sqlCell(["x", 1])).toBe('["x",1]');
    expect(sqlCell(false)).toBe("false");
    const long = sqlCell("x".repeat(SQL_CELL_CHARS + 1234));
    expect(long).toBe(`${"x".repeat(SQL_CELL_CHARS)}…[+1,234]`);
  });
});
