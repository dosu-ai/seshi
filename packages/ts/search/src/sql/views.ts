import type { SqlDialect } from "@seshi/model";
import { isOwner } from "@seshi/store";
import type { Viewer } from "../viewer";

export interface SqlColumn {
  name: string;
  comment?: string;
  /** The column's type in each dialect. Names are the same on both. */
  type: Readonly<Record<SqlDialect, string>>;
  /** How SQLite reads it, over `s` (`main.sessions`), `e` (`main.events`), `t` (`main.events_text`)
   * and `c` (`main.llm_calls`). DuckDB's expressions come with the LanceDB engine. */
  sqlite: string;
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

const text = (name: string, sqlite: string, comment?: string): SqlColumn => ({
  name,
  type: TEXT,
  sqlite,
  ...(comment ? { comment } : {}),
});
const time = (name: string, column: string, comment?: string): SqlColumn => ({
  name,
  type: TIME,
  sqlite: sqliteTime(column),
  ...(comment ? { comment } : {}),
});
const big = (name: string): SqlColumn => ({ name, type: BIG, sqlite: `c.${name}` });

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
        comment: "every model the session used; SQLite: a JSON array",
      },
      {
        name: "labels",
        type: { sqlite: "TEXT", duckdb: "JSON" },
        sqlite: "s.labels",
        comment: `{"key": "value"}; SQLite: a JSON object`,
      },
      time("started_at", "s.started_at"),
      time("ended_at", "s.ended_at"),
      time("updated_at", "s.updated_ms"),
    ],
  },
  {
    name: "events",
    comment: "The indexed events of those sessions, in their current trace chain.",
    columns: [
      text("owner", "s.owner"),
      text("archive_id", "s.archive_id"),
      {
        name: "seq",
        type: INT,
        sqlite: "e.seq",
        comment: "place in the session, from 0 across its traces (read_session's seq)",
      },
      text("content_hash", "e.content_hash", "the trace the event is in"),
      {
        name: "event_index",
        type: INT,
        sqlite: "e.event_index",
        comment: "its index within that trace",
      },
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
        comment: "tool results that record success; NULL otherwise; SQLite: 0 or 1",
      },
      time("ts", "e.ts"),
      {
        name: "chars",
        type: INT,
        sqlite: "e.chars",
        comment: "the event's full length; text is cut by role",
      },
      text("text", "CAST(t.text AS TEXT)", "indexed text, cut to the role's cap"),
    ],
  },
  {
    name: "llm_calls",
    comment: "Every model request the sessions' traces record.",
    columns: [
      text("owner", "s.owner"),
      text("archive_id", "s.archive_id"),
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

/** What `viewer` may see of sessions, over `s`, as SQL: nothing more for `everything`. */
function visibleSqlite(viewer: Viewer): string | undefined {
  if (viewer.everything && !viewer.ownOnly) return undefined;
  const own = viewer.own.length > 0 ? `s.owner IN (${ownersLiteral(viewer.own)})` : undefined;
  if (viewer.ownOnly) return own ?? "0";
  return own ? `(s.visibility = 'org' OR ${own})` : "s.visibility = 'org'";
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
    visibleSqlite(viewer),
    `coalesce(s.started_at, s.updated_ms) < ${until}`,
    `coalesce(s.ended_at, s.started_at, s.updated_ms) >= ${since}`,
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

/** The three views of a SQLite index for one query, as `TEMP` views over `main.*`: an
 * unqualified `events` then names the view, not the index's own table. The caller's scope and the
 * window are written in as literals. */
export function sqlViews(dialect: SqlDialect, viewer: Viewer, window: SqlWindow): string[] {
  if (dialect !== "sqlite") throw new Error("the DuckDB views come with sql on LanceDB");
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
