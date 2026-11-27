/** `seshi mcp`'s tools, apart from the protocol: their schemas, and each call turned into a
 * backend call and its answer into text for a model. docs/seshi/session-tools.md ("seshi mcp"). */
import { ServerError } from "@seshi/client";
import {
  DEFAULT_READ_CONTEXT,
  EVENT_ROLES,
  Forbidden,
  type Identity,
  MAX_READ_CHARS,
  MAX_READ_CONTEXT,
  MIN_READ_CHARS,
  SEARCH_SORTS,
  SESSION_READ_MODES,
  type SearchIndexState,
  type SearchRequest,
  type SessionEventsRequest,
  type SessionListRequest,
  type SqlRequest,
  type SqlSchema,
  type SqlScope,
} from "@seshi/model";
import {
  IndexUnavailable,
  SearchUnavailable,
  SqlBusy,
  SqlFailed,
  SqlRequestError,
  SqlUnavailable,
} from "@seshi/search";
import type { Backend } from "../backend";
import { parseSessionRef } from "../backend";
import { classify, Refused } from "../cli/failures";
import { caret } from "../commands/sql";
import { eventsLines, listLines, searchLines, timeOrAge, utc } from "../session-text";
import { sqlResultLines, sqlToolDescription } from "./sql";

/** A result's text stops here, at a line boundary. */
export const MAX_RESULT_CHARS = 30_000;

/** The `sql` tool's statement, at most (the API counts 16 KiB of UTF-8; this is the schema's
 * `maxLength`, in characters). */
const SQL_MAX_CHARS = 16_384;
/** Rows a `sql` answer holds unless the agent asks for more (the API's `max_rows` allows 1,000). */
export const SQL_DEFAULT_ROWS = 200;
/** How long `tools/list` waits for the `sql` schema before listing the tools without it; the
 * schema still arriving later lists `sql` (`tools/list_changed`). */
export const SQL_LIST_WAIT_MS = 5_000;

export const TOOL_NAMES = ["list_sessions", "read_session", "search", "sql"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: { readOnlyHint: true; openWorldHint: false; title: string };
}

const str = (description?: string): JsonSchema => ({
  type: "string",
  ...(description ? { description } : {}),
});
const roles = { type: "array", items: { enum: [...EVENT_ROLES] } };
const labels = {
  type: "object",
  additionalProperties: { type: "string" },
  description: "labels a session must carry, key to value",
};
const filters = {
  owner: str("only this person's sessions (an owner id)"),
  agent: str("only sessions of this agent or format: claude-code, codex, cursor…"),
  repo: str("a repository: github.com/acme/app, acme/app or app"),
  branch: str(),
  model: str("only sessions that used this model"),
  labels,
};

function tool(
  name: ToolName,
  title: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    annotations: { title, readOnlyHint: true, openWorldHint: false },
  };
}

export const TOOLS: readonly ToolDefinition[] = [
  tool(
    "list_sessions",
    "List sessions",
    "List the coding-agent sessions you may read, newest first, by who ran them, where (repo, branch) and when; no search words needed. Each line is one session: owner/archive_id (what read_session takes), format/session_id, repo@branch, start → end (UTC), models, labels. Page with `after`.",
    {
      ...filters,
      since: str(
        "ISO date or duration (7d, 24h); by default the 7 days before until, or before now",
      ),
      until: str("ISO date or duration (7d, 24h)"),
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      after: str("the cursor from the last page"),
    },
  ),
  tool(
    "read_session",
    "Read a session",
    "Read part of one session's events, as lines `#seq role tool ok time text`. `seq` numbers the session's events from 0. Read a range (from/to), the events around one (around, with context), or one long event in pieces (event, offset). Condensed mode (the default) cuts tool results to 200 characters; full gives them whole. A search match `#213` is the event with seq 213: pass it as around to read around it. Answers stop at max_chars and say `next: <seq>` to read on from.",
    {
      session: str("owner/archive_id, format/session_id, or a seshi URL"),
      from: { type: "integer", minimum: 0 },
      to: { type: "integer", minimum: 0 },
      around: {
        type: "integer",
        minimum: 0,
        description: "a seq, as search and sql give them; reads context events either side",
      },
      context: {
        type: "integer",
        minimum: 0,
        maximum: MAX_READ_CONTEXT,
        default: DEFAULT_READ_CONTEXT,
      },
      mode: { enum: [...SESSION_READ_MODES], default: "condensed" },
      roles,
      event: {
        type: "integer",
        minimum: 0,
        description: "read one event's text in pieces, with offset",
      },
      offset: { type: "integer", minimum: 0 },
      max_chars: {
        type: "integer",
        minimum: MIN_READ_CHARS,
        maximum: MAX_READ_CHARS,
        default: MAX_READ_CHARS,
      },
      head: str("fail if the session changed since this head"),
    },
    ["session"],
  ),
  tool(
    "search",
    "Search sessions",
    "Full-text search over the sessions you may read: prompts, answers and tool calls. Each result is a session line, then its best matches as `#seq role tool: excerpt` (read around one with read_session's around).",
    {
      query: str('words; "a phrase", a OR b, -word, prefix*'),
      ...filters,
      since: str("ISO date or duration (7d, 24h)"),
      until: str("ISO date or duration (7d, 24h)"),
      sort: { enum: [...SEARCH_SORTS], default: "relevance" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      matches: { type: "integer", minimum: 1, maximum: 5, default: 3 },
      cursor: str("the cursor from the last page"),
    },
    ["query"],
  ),
  tool(
    "sql",
    "Query sessions with SQL",
    // Replaced by the description written from the schema (`sqlToolDescription`): the tool is
    // listed only once the schema is in.
    "One read-only SELECT over the views sessions, events and llm_calls.",
    {
      sql: {
        type: "string",
        maxLength: SQL_MAX_CHARS,
        description: "one SELECT over sessions, events and llm_calls, in the dialect above",
      },
      since: str(
        "ISO date or duration (30d, 12h): the views hold the sessions overlapping since → until; 30 days by default, at most 400",
      ),
      until: str("ISO date or duration (30d, 12h); now by default"),
      max_rows: { type: "integer", minimum: 1, maximum: 1000, default: SQL_DEFAULT_ROWS },
    },
    ["sql"],
  ),
];

const SQL_TOOL = TOOLS.find((t) => t.name === "sql") as ToolDefinition;

/** A backend for one call, and anything the caller must know about how it reads (the login
 * could not be renewed, so it reads with the device token, which sees only its own sessions). */
export interface HostBackend {
  backend: Backend;
  notice?: string;
}

/** What the tools run against. */
export interface ToolHost {
  /** The backend to call; it may throw (not signed in, the server down), and every tool then
   * answers that error. */
  backend(): Promise<HostBackend>;
  now(): Date;
  /** The tools listed changed: `sql` came in after a `tools/list` that went without it. */
  onListChanged?(): void;
  /** How long `tools/list` waits for the `sql` schema (`SQL_LIST_WAIT_MS`). */
  sqlListWaitMs?: number;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

class BadArguments extends Error {}

/** `sql` cannot be used by this caller here, and the agent should not try again. */
class SqlNotListed extends Error {}

/** Why `sql` is not listed, when that will not change while the command runs: the credential
 * lacks the scope, the server has no `sql`, or the index is off. Anything else (the server
 * down, the index still building) is asked again at the next `tools/list`. */
function sqlRefusal(err: unknown): string | undefined {
  if (err instanceof Forbidden) {
    return "this credential has no sql scope (admins have it, and service tokens created with --scope sql)";
  }
  if (err instanceof ServerError) {
    if (err.status === 403) {
      return "this credential has no sql scope (admins have it, and service tokens created with --scope sql)";
    }
    if (err.status === 404 && err.code === "not_found") {
      return "this server runs a seshi older than sql";
    }
    if (err.status === 404 || err.status === 501) return err.message;
    return undefined;
  }
  if (err instanceof SqlUnavailable) return err.message;
  if (err instanceof Refused && err.code === "search_disabled") return err.message;
  return undefined;
}

/** Who a `sql` answer was answered as, as a result's header says it. */
export function sqlScopeOf(scope: SqlScope): string {
  if (scope.role === "local") return `as ${scope.as} (this machine's index: own + org)`;
  if (scope.role === "admin" || scope.role === "service") {
    return `as ${scope.as} (${scope.role}: every session)`;
  }
  return `as ${scope.as} (${scope.role}: own + org)`;
}

type SqlState =
  | { listed: true; schema: SqlSchema; definition: ToolDefinition }
  | { listed: false; reason: string };

type Args = Record<string, unknown>;

function check(definition: ToolDefinition, args: Args): void {
  const properties = definition.inputSchema.properties as Record<string, JsonSchema>;
  for (const name of (definition.inputSchema.required as string[] | undefined) ?? []) {
    if (args[name] === undefined) throw new BadArguments(`${name} is required`);
  }
  for (const [name, value] of Object.entries(args)) {
    const schema = properties[name];
    if (schema === undefined) throw new BadArguments(`unknown argument ${name}`);
    if (value === undefined || value === null) continue;
    const problem = problemOf(name, value, schema);
    if (problem) throw new BadArguments(problem);
  }
}

function problemOf(name: string, value: unknown, schema: JsonSchema): string | undefined {
  if (schema.enum !== undefined) {
    return (schema.enum as unknown[]).includes(value)
      ? undefined
      : `${name} must be one of ${(schema.enum as string[]).join(", ")}`;
  }
  switch (schema.type) {
    case "string": {
      if (typeof value !== "string") return `${name} must be a string`;
      const max = schema.maxLength as number | undefined;
      return max !== undefined && value.length > max
        ? `${name} must be at most ${max.toLocaleString("en-US")} characters`
        : undefined;
    }
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        return `${name} must be a whole number`;
      }
      const min = schema.minimum as number | undefined;
      const max = schema.maximum as number | undefined;
      if (min !== undefined && value < min) return `${name} must be at least ${min}`;
      if (max !== undefined && value > max) return `${name} must be at most ${max}`;
      return undefined;
    }
    case "array": {
      if (!Array.isArray(value)) return `${name} must be an array`;
      for (const item of value) {
        const problem = problemOf(`each of ${name}`, item, schema.items as JsonSchema);
        if (problem) return problem;
      }
      return undefined;
    }
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) return `${name} must be an object`;
      for (const v of Object.values(value as object)) {
        if (typeof v !== "string") return `each of ${name} must be a string`;
      }
      return undefined;
  }
  return undefined;
}

function when(value: unknown, name: string, now: Date): string | undefined {
  if (value === undefined || value === null) return undefined;
  const at = timeOrAge(value as string, now);
  if (at === undefined) throw new BadArguments(`${name} must be an ISO date or a duration (7d)`);
  return at;
}

function pick<T extends object>(args: Args, names: readonly string[]): Partial<T> {
  const out: Args = {};
  for (const name of names)
    if (args[name] !== undefined && args[name] !== null) out[name] = args[name];
  return out as Partial<T>;
}

/** Who is asking, as a result's header says it. */
export function scopeOf(me: Identity, mode: Backend["mode"]): string {
  if (mode === "serverless") return `as ${me.owner} (this machine's bucket key: own + org)`;
  const role = me.role ?? "member";
  const scopes = me.scopes ?? [];
  if (!scopes.includes("search")) return `as ${me.owner} (${role}: own sessions only)`;
  if (role === "admin" || role === "service") return `as ${me.owner} (${role}: every session)`;
  return `as ${me.owner} (${role}: own + org)`;
}

function ago(iso: string | undefined, now: Date): string {
  if (iso === undefined) return "";
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  const span =
    s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
  return ` · index updated ${span} ago`;
}

/** The first line of every result: when, as whom, over which window, how fresh the index. */
export function headerLine(
  now: Date,
  scope: string,
  window?: { since?: string; until?: string },
  index?: Pick<SearchIndexState, "caught_up_at">,
): string {
  const parts = [`now ${utc(now.toISOString())}`, scope];
  if (window !== undefined) {
    parts.push(
      `window ${window.since === undefined ? "all time" : utc(window.since)} → ${
        window.until === undefined ? "now" : utc(window.until)
      }`,
    );
  }
  return `${parts.join(" · ")}${ago(index?.caught_up_at, now)}`;
}

/** Lines joined, stopped at `MAX_RESULT_CHARS` on a line boundary, saying so. A line too long
 * to fit on its own (one huge event) is cut rather than dropped when it would be the first, or
 * when much room is left. */
export function capped(lines: readonly string[], max = MAX_RESULT_CHARS): string {
  const note = `… cut at ${max.toLocaleString("en-US")} characters: narrow the query, page, or read less at a time`;
  const budget = max - note.length - 1;
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    const gap = kept.length > 0 ? 1 : 0;
    if (size + gap + line.length <= budget) {
      kept.push(line);
      size += gap + line.length;
      continue;
    }
    const room = budget - size - gap;
    if (kept.length === 0 || room >= 1000) kept.push(line.slice(0, room));
    kept.push(note);
    return kept.join("\n");
  }
  return kept.join("\n");
}

function text(t: string, isError = false): ToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** Where a refused statement goes wrong, for the agent to correct it: the offset, then its line
 * with a caret under the character. */
function atLines(statement: string | undefined, at: number | undefined): string[] {
  if (statement === undefined || at === undefined) return [];
  return [`at character ${at} (from 0) of the statement:`, ...caret(statement, at)];
}

/** An error as a tool result: the API's code and message, and for a refused statement where it
 * went wrong. `statement` is the `sql` call's. */
export function errorResult(err: unknown, header: string, statement?: string): ToolResult {
  if (err instanceof BadArguments)
    return text(`${header}\nerror bad_arguments: ${err.message}`, true);
  if (err instanceof ServerError) {
    return text(
      [
        `${header}\nerror ${err.code} (HTTP ${err.status}): ${err.message}`,
        ...atLines(statement, err.at),
      ].join("\n"),
      true,
    );
  }
  // `sql` on a serverless laptop runs here, and fails as the API's own errors do.
  if (err instanceof SqlFailed) {
    return text(
      [`${header}\nerror ${err.code}: ${err.message}`, ...atLines(statement, err.at)].join("\n"),
      true,
    );
  }
  if (
    err instanceof SqlRequestError ||
    err instanceof SqlBusy ||
    err instanceof SqlUnavailable ||
    err instanceof IndexUnavailable ||
    err instanceof SearchUnavailable
  ) {
    return text(`${header}\nerror ${err.code}: ${err.message}`, true);
  }
  const known = classify(err);
  if (known) return text(`${header}\nerror ${known.code}: ${known.message}`, true);
  const message = err instanceof Error ? err.message : String(err);
  return text(`${header}\nerror internal: ${message}`, true);
}

export class Tools {
  /** Who each backend reads as: a backend made afresh for a call (a renewed login, or the
   * device token after a failed renewal) is asked again. */
  private readonly identities = new WeakMap<Backend, Identity>();
  /** Whether `sql` is listed, with the description written from the schema, once known. */
  private sqlState: SqlState | undefined;
  private sqlLoading: Promise<void> | undefined;
  /** A `tools/list` went without `sql` while its schema was on the way. */
  private sqlLate = false;

  constructor(
    private readonly host: ToolHost,
    readonly enabled: readonly ToolName[] = TOOL_NAMES,
  ) {}

  /** Ask for the `sql` schema, once at a time. Its answer lists `sql` (with a description written
   * from it), a refusal that will not change keeps it unlisted, and anything else leaves it to be
   * asked again. */
  private loadSql(): Promise<void> {
    if (this.sqlLoading !== undefined) return this.sqlLoading;
    const loading = (async () => {
      try {
        const { backend } = await this.host.backend();
        const schema = await backend.sqlSchema();
        const definition = SQL_TOOL;
        this.sqlState = {
          listed: true,
          schema,
          definition: { ...definition, description: sqlToolDescription(schema) },
        };
        if (this.sqlLate) this.host.onListChanged?.();
      } catch (err) {
        const reason = sqlRefusal(err);
        if (reason !== undefined) this.sqlState = { listed: false, reason };
      } finally {
        this.sqlLoading = undefined;
      }
    })();
    this.sqlLoading = loading;
    return loading;
  }

  /** The tools, `sql` among them once its schema is in: a server lists it to a caller with the
   * `sql` scope whose server can run it, a laptop over its own index. The first list waits a
   * little for the schema; one that comes later lists `sql` then (`onListChanged`). */
  async list(): Promise<ToolDefinition[]> {
    if (this.enabled.includes("sql") && this.sqlState === undefined) {
      const loading = this.loadSql();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), this.host.sqlListWaitMs ?? SQL_LIST_WAIT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      if ((await Promise.race([loading, waited])) === "late") this.sqlLate = true;
      clearTimeout(timer);
    }
    return TOOLS.flatMap((t) => {
      if (!this.enabled.includes(t.name)) return [];
      if (t.name !== "sql") return [t];
      return this.sqlState?.listed ? [this.sqlState.definition] : [];
    });
  }

  /** The tool called `name`, as listed: `sql` is asked for its schema first if it has not come. */
  private async definitionOf(name: string): Promise<ToolDefinition> {
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined || !this.enabled.includes(tool.name)) {
      throw new BadArguments(`no tool ${name}`);
    }
    if (tool.name !== "sql") return tool;
    if (this.sqlState === undefined) await this.loadSql();
    const state = this.sqlState;
    if (state?.listed) return state.definition;
    if (state !== undefined) throw new SqlNotListed(`sql is not available: ${state.reason}`);
    // Asked again: the error itself is the answer.
    const { backend } = await this.host.backend();
    await backend.sqlSchema();
    return SQL_TOOL;
  }

  private async scope({ backend, notice }: HostBackend): Promise<string> {
    let me = this.identities.get(backend);
    if (me === undefined) {
      me = await backend.me();
      this.identities.set(backend, me);
    }
    const scope = scopeOf(me, backend.mode);
    return notice === undefined ? scope : `${scope} · warning: ${notice}`;
  }

  async call(name: string, args: Args = {}): Promise<ToolResult> {
    const now = this.host.now();
    let header = `now ${utc(now.toISOString())}`;
    try {
      const definition = await this.definitionOf(name);
      check(definition, args);
      const opened = await this.host.backend();
      const { backend } = opened;
      const scope = await this.scope(opened);
      header = headerLine(now, scope);
      switch (definition.name) {
        case "list_sessions":
          return text(await this.listSessions(backend, args, now, scope));
        case "read_session":
          return text(await this.readSession(backend, args, header));
        case "search":
          return text(await this.search(backend, args, now, scope));
        case "sql":
          return await this.sql(backend, args, now, opened.notice);
      }
    } catch (err) {
      if (err instanceof SqlNotListed) {
        return text(`${header}\nerror sql_unavailable: ${err.message}`, true);
      }
      return errorResult(err, header, name === "sql" ? (args.sql as string) : undefined);
    }
  }

  /** One statement; its answer as a pipe table, the rows that fit in the text also in
   * `structuredContent` for clients that read it. */
  private async sql(
    backend: Backend,
    args: Args,
    now: Date,
    notice: string | undefined,
  ): Promise<ToolResult> {
    const since = when(args.since, "since", now);
    const until = when(args.until, "until", now);
    const request: SqlRequest = {
      sql: args.sql as string,
      max_rows: (args.max_rows as number | undefined) ?? SQL_DEFAULT_ROWS,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const result = await backend.sql(request);
    const scope = sqlScopeOf(result.scope);
    const header = headerLine(
      now,
      `${notice === undefined ? scope : `${scope} · warning: ${notice}`} · ${result.index.backend} index, ${result.index.dialect}`,
      { since: result.scope.since, until: result.scope.until },
      result.index.updated_at !== undefined ? { caught_up_at: result.index.updated_at } : undefined,
    );
    const lines = [header, ...sqlResultLines(result)];
    const out = capped(lines);
    // The header, the column names and the rule come first: row i is line 3 + i.
    const kept = out.split("\n");
    let rows = 0;
    while (rows < result.rows.length && kept[3 + rows] === lines[3 + rows]) rows++;
    return {
      content: [{ type: "text", text: out }],
      structuredContent: {
        columns: result.columns,
        rows: result.rows.slice(0, rows),
        truncated: result.truncated || rows < result.rows.length,
      },
    };
  }

  private async listSessions(backend: Backend, args: Args, now: Date, scope: string) {
    // Without since, the server's window is the 7 days before until (or now).
    const since = when(args.since, "since", now);
    const until = when(args.until, "until", now);
    const request: SessionListRequest = {
      ...pick<SessionListRequest>(args, [
        "owner",
        "agent",
        "repo",
        "branch",
        "model",
        "labels",
        "limit",
        "after",
      ]),
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const list = await backend.searchSessions(request);
    return capped([headerLine(now, scope, list.window, list.index), ...listLines(list)]);
  }

  private async readSession(backend: Backend, args: Args, header: string) {
    const ref = parseSessionRef(args.session as string);
    if (ref === undefined) {
      throw new BadArguments("session must be owner/archive_id, format/session_id or a seshi URL");
    }
    const request = pick<SessionEventsRequest>(args, [
      "from",
      "to",
      "around",
      "context",
      "mode",
      "roles",
      "event",
      "offset",
      "max_chars",
      "head",
    ]) as SessionEventsRequest;
    const read = await backend.sessionEvents(ref, request);
    return capped([header, ...eventsLines(read)]);
  }

  private async search(backend: Backend, args: Args, now: Date, scope: string) {
    const since = when(args.since, "since", now);
    const until = when(args.until, "until", now);
    const request: SearchRequest = {
      q: args.query as string,
      ...pick<SearchRequest>(args, [
        "owner",
        "agent",
        "repo",
        "branch",
        "model",
        "labels",
        "sort",
        "matches",
        "cursor",
      ]),
      limit: (args.limit as number | undefined) ?? 10,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {}),
    };
    const results = await backend.search(request);
    return capped([
      headerLine(
        now,
        scope,
        { ...(since !== undefined ? { since } : {}), ...(until !== undefined ? { until } : {}) },
        results.index,
      ),
      ...searchLines(results),
    ]);
  }
}
