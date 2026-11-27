/** The `sql` tool's description and answers. The description is written from `GET /v1/sql/schema`
 * (or, on a serverless laptop, the same function run locally), so it is the DDL, dialect, scope
 * and limits of this version, this engine and this caller, and cannot drift from the views.
 * docs/seshi/session-tools.md ("The `sql` tool's description", "Results"). */
import type { SqlResult, SqlSchema, SqlScope } from "@seshi/model";
import { printable } from "../cli/style";

/** A cell is cut here, saying how much was left out. */
export const SQL_CELL_CHARS = 300;

/** Whose sessions the views hold, said to the agent. */
export function sqlScopeText(scope: SqlScope): string {
  switch (scope.role) {
    case "admin":
    case "service":
      return `You query as ${scope.as} (${scope.role}): the views hold every session in the store.`;
    case "local":
      return `You query this machine's own search index as ${scope.as}: your sessions and the org's in its bucket.`;
    default:
      return `You query as ${scope.as} (${scope.role}): the views hold your own sessions and the org's, not other people's owner-only ones.`;
  }
}

const kib = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${Math.round(bytes / 1024)} KiB`;

/** The `sql` tool's description: the dialect first, then what the tool is for, the views' DDL in
 * that dialect, the caller's scope, the window rule, the limits and the examples. */
export function sqlToolDescription(schema: SqlSchema): string {
  const { limits } = schema;
  return [
    `Write ${schema.hint}`,
    "",
    "One read-only SELECT (WITH … SELECT is fine) over three views of the coding-agent sessions you may read, for questions across sessions: counts, token use, which tools fail, who worked where. Use search to find sessions by words, and read_session to read one session (events' text here is cut by role; read_session has it whole).",
    "",
    schema.ddl,
    "",
    sqlScopeText(schema.scope),
    "Join the views USING (owner, archive_id); pass owner/archive_id to read_session, and an event's seq as its around.",
    "",
    "The window: since and until (an ISO time or an age: 30d, 12h) pick the sessions the views hold, those overlapping it; by default the last 30 days, at most 400 days. A WHERE on time narrows it but cannot widen it: pass since for older sessions.",
    `Limits: one statement of at most ${kib(limits.max_sql_bytes)}; ${limits.timeout_ms / 1000} s; at most ${limits.max_rows.toLocaleString("en-US")} rows and ${kib(limits.max_bytes)} of them (max_rows asks for fewer, 200 by default). No tables, files or functions beyond the views and ordinary SQL functions. A refused statement says what and at which character.`,
    "",
    "Examples:",
    ...schema.examples.flatMap((e, i) => (i === 0 ? [e] : ["", e])),
  ].join("\n");
}

/** One cell: `NULL`, text as is, anything else as JSON; on one line, `|` escaped, cut at
 * `SQL_CELL_CHARS` with how much was left out. */
export function sqlCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const one = printable(raw.replaceAll("\r\n", "\n").replaceAll("\n", "\\n"));
  const cut =
    one.length > SQL_CELL_CHARS
      ? `${one.slice(0, SQL_CELL_CHARS)}…[+${(one.length - SQL_CELL_CHARS).toLocaleString("en-US")}]`
      : one;
  return cut.replaceAll("|", "\\|");
}

/** The answer as a pipe table (column names, then one line a row), then the count and time, or
 * that it was truncated. */
export function sqlResultLines(result: SqlResult): string[] {
  const row = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  const lines =
    result.columns.length === 0
      ? []
      : [
          row(result.columns.map((c) => sqlCell(c.name))),
          row(result.columns.map(() => "---")),
          ...result.rows.map((r) => row(result.columns.map((_, i) => sqlCell(r[i])))),
        ];
  const n = result.rows.length;
  const count = `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;
  lines.push(
    result.truncated
      ? `truncated at ${count}: add LIMIT or aggregate · ${result.elapsed_ms} ms`
      : `${count} · ${result.elapsed_ms} ms`,
  );
  return lines;
}
