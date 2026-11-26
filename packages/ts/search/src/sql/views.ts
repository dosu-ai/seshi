import type { SqlDialect } from "@seshi/model";
import { isOwner } from "@seshi/store";
import type { Viewer } from "../viewer";
import type { SqlTables } from "./protocol";

export interface SqlColumn {
  name: string;
  comment?: string;
  /** The column's type in each dialect. Names are the same on both. */
  type: Readonly<Record<SqlDialect, string>>;
  /** How SQLite reads it, over `s` (`main.sessions`), `e` (`main.events`), `t` (`main.events_text`)
   * and `c` (`main.llm_calls`). */
  sqlite: string;
  /** How DuckDB reads it, over the Lance tables `s` (sessions), `e` (events) and `c`
   * (llm_calls). Lance keeps times as `TIMESTAMP_MS` in UTC; the worker's time zone is UTC. */
  duckdb: string;
}

export interface SqlView {
  name: "sessions" | "events" | "llm_calls";
  comment: string;
  columns: readonly SqlColumn[];
}

/** A time column held as epoch milliseconds, as SQLite's own text format in UTC
 * (`YYYY-MM-DD HH:MM:SS.SSS`), so `ts > datetime('now', '-30 days')` and `strftime` work and text
 * order is time order. */
function sqliteTime(column: string): string {
  return `CAST(strftime('%Y-%m-%d %H:%M:%S', ${column} / 1000, 'unixepoch') || printf('.%03d', ${column} % 1000) AS TEXT)`;
}

const TEXT = { sqlite: "TEXT", duckdb: "VARCHAR" } as const;
const INT = { sqlite: "INTEGER", duckdb: "INTEGER" } as const;
const BIG = { sqlite: "INTEGER", duckdb: "BIGINT" } as const;
const TIME = { sqlite: "TEXT", duckdb: "TIMESTAMPTZ" } as const;

/** A text column, read the same way on both engines unless `duckdb` says otherwise. */
const text = (name: string, sqlite: string, comment?: string, duckdb = sqlite): SqlColumn => ({
  name,
  type: TEXT,
  sqlite,
  duckdb,
  ...(comment ? { comment } : {}),
});
/** A time column: epoch ms in SQLite's index, `TIMESTAMP_MS` in Lance's (`duckdb`, the column
 * as Lance names it when it differs). */
const time = (name: string, column: string, comment?: string, duckdb = column): SqlColumn => ({
  name,
  type: TIME,
  sqlite: sqliteTime(column),
  duckdb: `CAST(${duckdb} AS TIMESTAMPTZ)`,
  ...(comment ? { comment } : {}),
});
const big = (name: string): SqlColumn => ({
  name,
  type: BIG,
  sqlite: `c.${name}`,
  duckdb: `c.${name}`,
});
const int = (name: string, column: string, comment: string): SqlColumn => ({
  name,
  type: INT,
  sqlite: column,
  duckdb: column,
  comment,
});

/** The three views `sql` reads, defined once (docs/seshi/session-tools.md, "The views"): the
 * SQLite views, the DDL `GET /v1/sql/schema` serves and the `sql` tool's description are all
 * written from it. The index's internal columns (`id`, `traces`, `read_ms`, `removed`, the integer
 * keys) stay out. */
export const SQL_VIEWS: readonly SqlView[] = [
  {
    name: "sessions",
    comment: "One row per session the caller may see, not removed, overlapping the window.",
    columns: [
      text("owner", "s.owner", "who the session belongs to"),
      text(
        "archive_id",
        "s.archive_id",
        "with owner, the session's key; joins events and llm_calls",
      ),
      text("agent", "s.format", "the session's format: claude-code, codex, cursor…"),
      text("session_id", "s.session_id", "the agent's own id"),
      text("origin_agent", "s.origin_agent"),
      text("project", "s.project"),
      text("repo", "s.repo", "the repository's normalized remote: github.com/acme/app"),
      text("branch", "s.branch"),
      text("harness", "s.harness", "what ran the session: claude-code, cursor…"),
      text("agent_version", "s.agent_version"),
      text("source_id", "s.source_id"),
      text("visibility", "s.visibility", "org | owner"),
      {
        name: "models",
        type: { sqlite: "TEXT", duckdb: "VARCHAR[]" },
        sqlite: "s.models",
        duckdb: "s.models",
        comment: "every model the session used; SQLite: a JSON array",
      },
      {
        name: "labels",
        type: { sqlite: "TEXT", duckdb: "JSON" },
        sqlite: "s.labels",
        duckdb: "CAST(s.labels AS JSON)",
        comment: `{"key": "value"}; SQLite: a JSON object`,
      },
      time("started_at", "s.started_at"),
      time("ended_at", "s.ended_at"),
      time("updated_at", "s.updated_ms", undefined, "epoch_ms(s.updated_ms)"),
    ],
  },
  {
    name: "events",
    comment: "The indexed events of those sessions, in their current trace chain.",
    columns: [
      text("owner", "s.owner", undefined, "e.owner"),
      text("archive_id", "s.archive_id", undefined, "e.archive_id"),
      int("seq", "e.seq", "place in the session, from 0 across its traces (read_session's seq)"),
      text("content_hash", "e.content_hash", "the trace the event is in"),
      int("event_index", "e.event_index", "its index within that trace"),
      text(
        "role",
        "e.role",
        "user | assistant | tool_call | tool_result | system | observation | reasoning",
      ),
      text("tool_name", "e.tool_name"),
      text("tool_call_id", "e.tool_call_id", "pairs a tool_call with its tool_result"),
      {
        name: "ok",
        type: { sqlite: "INTEGER", duckdb: "BOOLEAN" },
        sqlite: "e.ok",
        duckdb: "e.ok",
        comment: "tool results that record success; NULL otherwise; SQLite: 0 or 1",
      },
      time("ts", "e.ts"),
      int("chars", "e.chars", "the event's full length; text is cut by role"),
      text("text", "CAST(t.text AS TEXT)", "indexed text, cut to the role's cap", "e.text"),
    ],
  },
  {
    name: "llm_calls",
    comment: "Every model request the sessions' traces record.",
    columns: [
      text("owner", "s.owner", undefined, "c.owner"),
      text("archive_id", "s.archive_id", undefined, "c.archive_id"),
      text("content_hash", "c.content_hash"),
      text("id", "c.call_id", "unique within the trace"),
      text("model", "c.model"),
      text("provider", "c.provider"),
      time("started_at", "c.started_at"),
      time("ended_at", "c.ended_at"),
      big("duration_ms"),
      big("input_tokens"),
      big("output_tokens"),
      big("cache_read_input_tokens"),
      big("cache_creation_input_tokens"),
      big("reasoning_tokens"),
      big("total_tokens"),
      text("stop_reason", "c.stop_reason"),
      text("error", "c.error"),
    ],
  },
];

/** The instants a query reads sessions between: those overlapping `[since, until)`. */
export interface SqlWindow {
  since: number;
  until: number;
}

/** A string literal, quotes doubled. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ownersLiteral(owners: readonly string[]): string {
  for (const owner of owners) {
    // Owners come from the credential, never the statement; checked all the same.
    if (!isOwner(owner)) throw new Error(`not an owner id: ${JSON.stringify(owner)}`);
  }
  return owners.map(sqlString).join(", ");
}

/** What `viewer` may see of the rows of `alias` (sessions `s`, or Lance's events `e`, which
 * carry their session's owner and visibility), as SQL: nothing more for `everything`. `none` is
 * the dialect's false. */
function visible(viewer: Viewer, alias: string, none: string): string | undefined {
  if (viewer.everything && !viewer.ownOnly) return undefined;
  const own =
    viewer.own.length > 0 ? `${alias}.owner IN (${ownersLiteral(viewer.own)})` : undefined;
  if (viewer.ownOnly) return own ?? none;
  return own ? `(${alias}.visibility = 'org' OR ${own})` : `${alias}.visibility = 'org'`;
}

function integer(ms: number, name: string): string {
  if (!Number.isSafeInteger(ms)) throw new Error(`${name} is not a whole number of milliseconds`);
  return String(ms);
}

/** The condition every view puts on `s`: not removed, visible to the caller, overlapping the
 * window. Written once, from the caller and the window, never from the statement. */
function scopeSqlite(viewer: Viewer, window: SqlWindow): string {
  const since = integer(window.since, "since");
  const until = integer(window.until, "until");
  return [
    "s.removed = 0",
    visible(viewer, "s", "0"),
    `coalesce(s.started_at, s.updated_ms) < ${until}`,
    `coalesce(s.ended_at, s.started_at, s.updated_ms) >= ${since}`,
  ]
    .filter((c): c is string => c !== undefined)
    .join("\n  AND ");
}

/** The same condition over Lance's `sessions` (`s`), whose times are `TIMESTAMP_MS` in UTC: the
 * window's instants are written as `epoch_ms(<ms>)`. */
function scopeDuckdb(viewer: Viewer, window: SqlWindow): string {
  const since = `epoch_ms(${integer(window.since, "since")})`;
  const until = `epoch_ms(${integer(window.until, "until")})`;
  const updated = "epoch_ms(s.updated_ms)";
  return [
    "NOT s.removed",
    visible(viewer, "s", "false"),
    `coalesce(s.started_at, ${updated}) < ${until}`,
    `coalesce(s.ended_at, s.started_at, ${updated}) >= ${since}`,
  ]
    .filter((c): c is string => c !== undefined)
    .join("\n  AND ");
}

const SQLITE_FROM: Record<SqlView["name"], string> = {
  sessions: "main.sessions s",
  events:
    "main.events e\n  JOIN main.sessions s ON s.id = e.session\n  JOIN main.events_text t ON t.rowid = e.id",
  llm_calls: "main.llm_calls c\n  JOIN main.sessions s ON s.id = c.session",
};

/** The aliases the DuckDB views read their tables under. */
const DUCKDB_ALIAS: Record<SqlView["name"], string> = {
  sessions: "s",
  events: "e",
  llm_calls: "c",
};

/** A Lance table's location as DuckDB reads it: a quoted path, which the `lance` extension
 * opens. Locations come from the index's `meta`, never from a statement; checked all the same. */
function lanceTable(location: string): string {
  const control = [...location].some((c) => (c.codePointAt(0) as number) < 0x20);
  if (location === "" || control || !location.endsWith(".lance")) {
    throw new Error(`not a Lance table: ${JSON.stringify(location)}`);
  }
  return sqlString(location);
}

/** The three views of a LanceDB index for one query, over its live generation's tables.
 * `events` and `llm_calls` keep the rows of the sessions `sessions` admits (a semi-join on
 * `owner` and `archive_id`), so the scope is written once. `events` also requires its own row's
 * visibility (Lance's events carry their session's) to admit the row: the indexer writes
 * `events` before `sessions` in a commit, so a session turned owner-only is hidden as soon as
 * either has it. */
function duckdbViews(viewer: Viewer, window: SqlWindow, tables: SqlTables): string[] {
  const scope = scopeDuckdb(viewer, window);
  const sessions = lanceTable(tables.sessions);
  const admitted = (alias: string) =>
    `EXISTS (SELECT 1 FROM ${sessions} s\n  WHERE s.owner = ${alias}.owner AND s.archive_id = ${alias}.archive_id\n  AND ${scope})`;
  return SQL_VIEWS.map((view) => {
    const alias = DUCKDB_ALIAS[view.name];
    const columns = view.columns.map((c) => `  ${c.duckdb} AS ${c.name}`).join(",\n");
    const from = `${lanceTable(tables[view.name])} ${alias}`;
    const where =
      view.name === "sessions"
        ? scope
        : [view.name === "events" ? visible(viewer, alias, "false") : undefined, admitted(alias)]
            .filter((c): c is string => c !== undefined)
            .join("\n  AND ");
    return `CREATE VIEW ${view.name} AS SELECT\n${columns}\nFROM ${from}\nWHERE ${where}`;
  });
}

/** The three views for one query, the caller's scope and the window written in as literals.
 * On SQLite they are `TEMP` views over `main.*`: an unqualified `events` then names the view,
 * not the index's own table. On DuckDB they read `tables`, the LanceDB index's live
 * generation. */
export function sqlViews(
  dialect: SqlDialect,
  viewer: Viewer,
  window: SqlWindow,
  tables?: SqlTables,
): string[] {
  if (dialect === "duckdb") {
    if (tables === undefined) throw new Error("the DuckDB views read a LanceDB index's tables");
    return duckdbViews(viewer, window, tables);
  }
  const scope = scopeSqlite(viewer, window);
  return SQL_VIEWS.map((view) => {
    const columns = view.columns.map((c) => `  ${c.sqlite} AS ${c.name}`).join(",\n");
    return `CREATE TEMP VIEW ${view.name} AS SELECT\n${columns}\nFROM ${SQLITE_FROM[view.name]}\nWHERE ${scope}`;
  });
}

/** The DDL of the three views in `dialect`, with each column's comment: what `GET /v1/sql/schema`
 * serves and the `sql` tool describes. */
export function sqlSchema(dialect: SqlDialect): string {
  return SQL_VIEWS.map((view) => {
    const width = Math.max(...view.columns.map((c) => c.name.length)) + 1;
    const typeWidth = Math.max(...view.columns.map((c) => c.type[dialect].length)) + 1;
    const lines = view.columns.map((c, i) => {
      const comma = i < view.columns.length - 1 ? "," : "";
      const head = `  ${c.name.padEnd(width)} ${(c.type[dialect] + comma).padEnd(typeWidth + 1)}`;
      return c.comment ? `${head} -- ${c.comment}` : head.trimEnd();
    });
    return `-- ${view.comment}\nCREATE VIEW ${view.name} (\n${lines.join("\n")}\n);`;
  }).join("\n\n");
}

/** What `sql` answers, per dialect (the same questions): the schema endpoint serves them and a
 * conformance test runs them. */
export const SQL_EXAMPLES: Readonly<Record<SqlDialect, readonly string[]>> = {
  sqlite: [
    `-- Tokens per person and model, last 30 days
SELECT s.owner, c.model, sum(c.input_tokens + c.output_tokens) AS tokens
FROM llm_calls c JOIN sessions s USING (owner, archive_id)
WHERE c.started_at > datetime('now', '-30 days') GROUP BY 1, 2 ORDER BY tokens DESC;`,
    `-- Tools that fail most, by repo
SELECT repo, tool_name, count(*) FILTER (WHERE NOT ok) AS failed, count(*) AS calls
FROM events e JOIN sessions s USING (owner, archive_id)
WHERE e.role = 'tool_result' GROUP BY 1, 2 HAVING calls > 20 ORDER BY failed DESC;`,
    `-- Sessions with many prompts and few tool calls
SELECT owner, archive_id, count(*) FILTER (WHERE role = 'user') AS prompts,
       count(*) FILTER (WHERE role = 'tool_call') AS tool_calls
FROM events GROUP BY 1, 2 HAVING prompts > 10 AND tool_calls < 5;`,
  ],
  duckdb: [
    `-- Tokens per person and model, last 30 days
SELECT s.owner, c.model, sum(c.input_tokens + c.output_tokens) AS tokens
FROM llm_calls c JOIN sessions s USING (owner, archive_id)
WHERE c.started_at > now() - INTERVAL 30 DAY GROUP BY ALL ORDER BY tokens DESC;`,
    `-- Tools that fail most, by repo
SELECT repo, tool_name, count(*) FILTER (WHERE NOT ok) AS failed, count(*) AS calls
FROM events e JOIN sessions s USING (owner, archive_id)
WHERE e.role = 'tool_result' GROUP BY ALL HAVING calls > 20 ORDER BY failed DESC;`,
    `-- Sessions with many prompts and few tool calls
SELECT owner, archive_id, count(*) FILTER (WHERE role = 'user') AS prompts,
       count(*) FILTER (WHERE role = 'tool_call') AS tool_calls
FROM events GROUP BY ALL HAVING prompts > 10 AND tool_calls < 5;`,
  ],
};

/** How to write the dialect, in one line: what the schema endpoint and the `sql` tool say first. */
export const SQL_DIALECT_HINT: Readonly<Record<SqlDialect, string>> = {
  sqlite:
    "SQLite: use datetime('now', '-30 days'), json_each(models), labels ->> '$.team' and GROUP BY 1, 2; times are UTC text (YYYY-MM-DD HH:MM:SS.SSS), ok is 0 or 1.",
  duckdb:
    "DuckDB: use now() - INTERVAL 30 DAY, list_contains(models, …), labels ->> '$.team' and GROUP BY ALL.",
};
