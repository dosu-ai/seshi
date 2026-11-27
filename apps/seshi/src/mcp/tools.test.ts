import { ServerError } from "@seshi/client";
import {
  Forbidden,
  type SearchRequest,
  type SearchResults,
  type SessionEvents,
  type SessionEventsRequest,
  type SessionList,
  type SessionListRequest,
  type SqlRequest,
  type SqlResult,
  type SqlSchema,
} from "@seshi/model";
import { SQL_DIALECT_HINT, SQL_EXAMPLES, SqlFailed, sqlSchema } from "@seshi/search";
import { describe, expect, it } from "vitest";
import { NotSignedIn } from "../account/credential";
import type { Backend, SessionRef } from "../backend";
import { capped, MAX_RESULT_CHARS, TOOLS, type ToolHost, Tools } from "./tools";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const A = "a".repeat(64);
const INDEX = {
  ready_at: "2026-11-20T00:00:00Z",
  caught_up_at: "2026-11-25T11:59:20Z",
  sessions: 3,
};

const LIST: SessionList = {
  sessions: [
    {
      owner: "alice",
      archive_id: A,
      format: "claude-code",
      session_id: "s1",
      repo: "github.com/acme/app",
      branch: "main",
      models: ["claude-opus-5-5"],
      labels: { team: "core" },
      visibility: "org",
      started_at: "2026-11-25T09:00:00.000Z",
      ended_at: "2026-11-25T10:02:41.000Z",
      updated_at: "2026-11-25T10:03:00.000Z",
    },
  ],
  window: { since: "2026-11-18T12:00:00.000Z" },
  cursor: "abc",
  index: INDEX,
};

const READ: SessionEvents = {
  session: {
    owner: "alice",
    archive_id: A,
    format: "claude-code",
    session_id: "s1",
    repo: "github.com/acme/app",
    branch: "main",
    visibility: "org",
    started_at: "2026-11-25T09:00:00.000Z",
    ended_at: "2026-11-25T10:02:41.000Z",
    updated_at: "2026-11-25T10:03:00.000Z",
    head: "b".repeat(64),
    traces: 2,
    events: 240,
    models: ["claude-opus-5-5"],
    llm_calls: 71,
    tokens: {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
    },
  },
  mode: "condensed",
  from: 212,
  to: 214,
  events: [
    {
      seq: 212,
      role: "tool_call",
      content_hash: "b".repeat(64),
      event_index: 12,
      tool_name: "Bash",
      timestamp: "2026-11-25T10:02:03.000Z",
      text: "Bash bun test packages/ts/search",
      chars: 32,
    },
    {
      seq: 213,
      role: "tool_result",
      content_hash: "b".repeat(64),
      event_index: 13,
      tool_name: "Bash",
      ok: false,
      timestamp: "2026-11-25T10:02:41.000Z",
      text: "FAIL src/lance.test.ts > scrub",
      chars: 18_452,
      cut: 18_422,
    },
  ],
  next: 214,
};

const RESULTS: SearchResults = {
  query: "scrub",
  total: 1,
  results: [
    {
      ...LIST.sessions[0],
      score: 4.2,
      hits: 2,
      matches: [
        {
          content_hash: "c".repeat(64),
          event_index: 7,
          seq: 213,
          role: "tool_result",
          tool_name: "Bash",
          snippet: "FAIL src/lance.test.ts > scrub",
          highlights: [[24, 29]],
        },
      ],
    } as SearchResults["results"][number],
  ],
  index: INDEX,
};

interface Calls {
  list: SessionListRequest[];
  read: [SessionRef, SessionEventsRequest][];
  search: SearchRequest[];
}

function fake(overrides: Partial<Backend> = {}): { backend: Backend; calls: Calls } {
  const calls: Calls = { list: [], read: [], search: [] };
  const backend = {
    mode: "server",
    where: "https://seshi.example.com",
    me: async () => ({
      owner: "alice",
      role: "member",
      scopes: ["sessions:read", "search"],
      storage: { url: "s3://b" },
    }),
    searchSessions: async (request: SessionListRequest) => {
      calls.list.push(request);
      return LIST;
    },
    sessionEvents: async (ref: SessionRef, request: SessionEventsRequest) => {
      calls.read.push([ref, request]);
      return READ;
    },
    search: async (request: SearchRequest) => {
      calls.search.push(request);
      return RESULTS;
    },
    // A member: no sql scope.
    sqlSchema: async () => {
      throw new Forbidden("this credential cannot do that: it needs the sql scope");
    },
    ...overrides,
  } as unknown as Backend;
  return { backend, calls };
}

function tools(backend: Backend | (() => Promise<Backend>), notice?: string) {
  return new Tools({
    backend: async () => ({
      backend: typeof backend === "function" ? await backend() : backend,
      ...(notice !== undefined ? { notice } : {}),
    }),
    now: () => NOW,
  });
}

const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("");

describe("seshi mcp's tools", () => {
  it("lists read-only tools with the design's schemas; sql only once its schema is in", async () => {
    expect(
      (
        await new Tools({
          backend: async () => ({ backend: fake().backend }),
          now: () => NOW,
        }).list()
      ).map((t) => t.name),
    ).toEqual(["list_sessions", "read_session", "search"]);
    for (const t of TOOLS) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(t.inputSchema.type).toBe("object");
    }
    const read = TOOLS.find((t) => t.name === "read_session");
    expect(read?.inputSchema.required).toEqual(["session"]);
    expect(Object.keys(read?.inputSchema.properties as object)).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(
      await new Tools({ backend: async () => ({ backend: fake().backend }), now: () => NOW }, [
        "search",
      ]).list(),
    ).toHaveLength(1);
  });

  it("list_sessions: a header, one line a session, then the cursor; 7 days by default", async () => {
    const { backend, calls } = fake();
    const result = await tools(backend).call("list_sessions", {
      repo: "app",
      labels: { team: "core" },
    });
    expect(result.isError).toBeUndefined();
    expect(textOf(result).split("\n")).toEqual([
      "now 2026-11-25T12:00:00Z · as alice (member: own + org) · window 2026-11-18T12:00:00Z → now · index updated 40 s ago",
      `alice/${A} · claude-code/s1 · github.com/acme/app@main · 2026-11-25T09:00:00Z → 10:02:41Z · claude-opus-5-5 · team=core`,
      "after: abc",
    ]);
    expect(calls.list[0]).toEqual({
      repo: "app",
      labels: { team: "core" },
    });
    await tools(backend).call("list_sessions", {
      since: "24h",
      until: "2026-11-25",
      limit: 5,
      after: "x",
    });
    expect(calls.list[1]).toEqual({
      since: "2026-11-24T12:00:00.000Z",
      until: "2026-11-25T00:00:00.000Z",
      limit: 5,
      after: "x",
    });
    // An until alone leaves the window to the server: the 7 days before it.
    await tools(backend).call("list_sessions", { until: "2026-10-31" });
    expect(calls.list[2]).toEqual({ until: "2026-10-31T00:00:00.000Z" });
    const bare = await tools(backend).call("list_sessions", { since: "7" });
    expect(bare.isError).toBe(true);
  });

  it("read_session: the session's header, lines of events, then next", async () => {
    const { backend, calls } = fake();
    const result = await tools(backend).call("read_session", {
      session: `alice/${A}`,
      around: 213,
      context: 2,
      mode: "full",
    });
    expect(textOf(result).split("\n")).toEqual([
      "now 2026-11-25T12:00:00Z · as alice (member: own + org)",
      `session alice/${A} · claude-code/s1 · github.com/acme/app@main · 2026-11-25T09:00:00Z → 10:02:41Z`,
      `240 events in 2 traces · head ${"b".repeat(64)} · models claude-opus-5-5 · 71 model calls (tokens in 1,200, out 300)`,
      "events #212 to #213 (condensed)",
      "#212 tool_call   Bash 2026-11-25T10:02:03Z  Bash bun test packages/ts/search",
      "#213 tool_result Bash ok=0 2026-11-25T10:02:41Z  FAIL src/lance.test.ts > scrub [+18,422 chars]",
      "next: 214",
    ]);
    expect(calls.read[0]).toEqual([
      { owner: "alice", archiveId: A },
      { around: 213, context: 2, mode: "full" },
    ]);
    await tools(backend).call("read_session", { session: "claude-code/s1", from: 0 });
    expect(calls.read[1]?.[0]).toEqual({ format: "claude-code", sessionId: "s1" });
    await tools(backend).call("read_session", {
      session: `https://seshi.example.com/v1/owners/alice/sessions/${A}/events`,
    });
    expect(calls.read[2]?.[0]).toEqual({ owner: "alice", archiveId: A });
  });

  it("search: a block per session, matches with their seq, and the total", async () => {
    const { backend, calls } = fake();
    const result = await tools(backend).call("search", {
      query: "scrub",
      since: "7d",
      sort: "recent",
    });
    expect(textOf(result).split("\n")).toEqual([
      "now 2026-11-25T12:00:00Z · as alice (member: own + org) · window 2026-11-18T12:00:00Z → now · index updated 40 s ago",
      `alice/${A} · claude-code/s1 · github.com/acme/app@main · 2026-11-25T09:00:00Z → 10:02:41Z · claude-opus-5-5 · team=core · score 4.2 · 2 matches`,
      "  #213 tool_result Bash: FAIL src/lance.test.ts > scrub",
      "1 session match",
    ]);
    expect(calls.search[0]).toEqual({
      q: "scrub",
      sort: "recent",
      limit: 10,
      since: "2026-11-18T12:00:00.000Z",
    });
  });

  it("answers bad arguments, the API's refusals and an unreachable backend as errors", async () => {
    const { backend } = fake({
      sessionEvents: async () => {
        throw new ServerError(410, "redacted", "session was redacted; no events");
      },
    });
    const t = tools(backend);
    for (const [name, args, message] of [
      ["read_session", {}, "session is required"],
      ["read_session", { session: "nope" }, "session must be"],
      ["read_session", { session: "a/b", from: -1 }, "from must be at least 0"],
      ["read_session", { session: "a/b", max_chars: 50_000 }, "max_chars must be at most 30000"],
      ["read_session", { session: "a/b", mode: "short" }, "mode must be one of condensed, full"],
      ["read_session", { session: "a/b", roles: ["tool"] }, "each of roles must be one of"],
      ["list_sessions", { since: "soon" }, "since must be an ISO date or a duration"],
      ["list_sessions", { bogus: 1 }, "unknown argument bogus"],
      ["search", { query: 3 }, "query must be a string"],
      ["sql", { sql: "SELECT 1" }, "sql is not available: this credential has no sql scope"],
      ["nope", {}, "no tool nope"],
    ] as const) {
      const result = await t.call(name, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(message);
    }
    const refused = await t.call("read_session", { session: "a/b" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("error redacted (HTTP 410): session was redacted");
    const down = await tools(async () => {
      throw new NotSignedIn("https://seshi.example.com");
    }).call("list_sessions", {});
    expect(down.isError).toBe(true);
    expect(textOf(down)).toMatch(/^now 2026-11-25T12:00:00Z\nerror not_signed_in: not signed in/);
  });

  it("says whose sessions an admin, a device token and a serverless machine see", async () => {
    const as = async (me: object, mode = "server") => {
      const { backend } = fake({ me: async () => me as never, mode: mode as never });
      return textOf(await tools(backend).call("list_sessions", {})).split("\n")[0];
    };
    expect(await as({ owner: "ops", role: "admin", scopes: ["search"] })).toContain(
      "as ops (admin: every session)",
    );
    expect(await as({ owner: "bob", role: "member", scopes: ["sessions:write"] })).toContain(
      "as bob (member: own sessions only)",
    );
    // Each backend is asked who it reads as, and a fallback credential's warning is in the header.
    let me = { owner: "alice", role: "member", scopes: ["search"] };
    const host = new Tools({
      backend: async () => ({
        backend: fake({ me: async () => me as never }).backend,
        ...(me.scopes.includes("search")
          ? {}
          : { notice: "reading with this machine's device token" }),
      }),
      now: () => NOW,
    });
    expect(textOf(await host.call("list_sessions", {}))).toContain("as alice (member: own + org)");
    me = { owner: "alice", role: "member", scopes: ["sessions:write"] };
    expect(textOf(await host.call("list_sessions", {})).split("\n")[0]).toContain(
      "as alice (member: own sessions only) · warning: reading with this machine's device token",
    );
    expect(await as({ owner: "carol" }, "serverless")).toContain(
      "as carol (this machine's bucket key: own + org)",
    );
  });

  it("stops a result at 30,000 characters on a line boundary, saying so", () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `${i} ${"x".repeat(60)}`);
    const out = capped(lines);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const kept = out.split("\n");
    expect(kept.at(-1)).toMatch(/^… cut at 30,000 characters/);
    expect(kept.slice(0, -1).every((l, i) => l === lines[i])).toBe(true);
    // One line longer than the cap is cut, not dropped.
    const huge = capped(["header", "y".repeat(50_000)]);
    expect(huge.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(huge.split("\n")[1]?.startsWith("yyyy")).toBe(true);
    expect(capped(["a", "b"])).toBe("a\nb");
  });
});

const SCHEMA: SqlSchema = {
  dialect: "sqlite",
  hint: SQL_DIALECT_HINT.sqlite,
  ddl: sqlSchema("sqlite"),
  examples: [...SQL_EXAMPLES.sqlite],
  scope: { as: "ops", role: "admin", since: "2026-10-26T12:00:00Z", until: "2026-11-25T12:00:00Z" },
  index: { backend: "sqlite", dialect: "sqlite", updated_at: "2026-11-25T11:59:20Z" },
  limits: { max_rows: 1000, max_bytes: 1_048_576, timeout_ms: 15_000, max_sql_bytes: 16_384 },
};

const ANSWER: SqlResult = {
  now: "2026-11-25T12:00:00Z",
  scope: SCHEMA.scope,
  index: SCHEMA.index,
  columns: [
    { name: "owner", type: "TEXT" },
    { name: "tokens", type: "INTEGER" },
  ],
  rows: [
    ["alice", 1500],
    ["bob", null],
  ],
  truncated: false,
  elapsed_ms: 231,
};

function sqlHost(
  overrides: Partial<Backend> = {},
  host: Partial<ToolHost> = {},
): { tools: Tools; requests: SqlRequest[] } {
  const requests: SqlRequest[] = [];
  const { backend } = fake({
    me: async () => ({ owner: "ops", role: "admin", scopes: ["search", "sql"] }) as never,
    sqlSchema: async () => SCHEMA,
    sql: async (request: SqlRequest) => {
      requests.push(request);
      return ANSWER;
    },
    ...overrides,
  });
  return {
    tools: new Tools({ backend: async () => ({ backend }), now: () => NOW, ...host }),
    requests,
  };
}

describe("seshi mcp's sql tool", () => {
  it("is listed with the description written from the schema", async () => {
    const listed = await sqlHost().tools.list();
    expect(listed.map((t) => t.name)).toEqual(["list_sessions", "read_session", "search", "sql"]);
    const sql = listed.find((t) => t.name === "sql");
    expect(sql?.description.startsWith(`Write ${SQL_DIALECT_HINT.sqlite}`)).toBe(true);
    expect(sql?.description).toContain(sqlSchema("sqlite"));
    expect(sql?.inputSchema.required).toEqual(["sql"]);
    expect(sql?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });

  it("answers a pipe table under a header, the rows also as structured content", async () => {
    const { tools, requests } = sqlHost();
    const result = await tools.call("sql", { sql: "SELECT 1", since: "7d" });
    expect(result.isError).toBeUndefined();
    expect(textOf(result).split("\n")).toEqual([
      "now 2026-11-25T12:00:00Z · as ops (admin: every session) · sqlite index, sqlite · window 2026-10-26T12:00:00Z → 2026-11-25T12:00:00Z · index updated 40 s ago",
      "| owner | tokens |",
      "| --- | --- |",
      "| alice | 1500 |",
      "| bob | NULL |",
      "2 rows · 231 ms",
    ]);
    expect(result.structuredContent).toEqual({
      columns: ANSWER.columns,
      rows: ANSWER.rows,
      truncated: false,
    });
    expect(requests).toEqual([
      { sql: "SELECT 1", max_rows: 200, since: "2026-11-18T12:00:00.000Z" },
    ]);
    await tools.call("sql", { sql: "SELECT 1", max_rows: 5 });
    expect(requests[1]).toEqual({ sql: "SELECT 1", max_rows: 5 });
  });

  it("gives structured content only the rows that fit in the text", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => [`${i}`, "x".repeat(200)]);
    const { tools } = sqlHost({ sql: async () => ({ ...ANSWER, rows }) });
    const result = await tools.call("sql", { sql: "SELECT 1" });
    const out = textOf(result);
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out).toMatch(/… cut at 30,000 characters/);
    const structured = result.structuredContent as { rows: unknown[][]; truncated: boolean };
    expect(structured.truncated).toBe(true);
    expect(structured.rows.length).toBeGreaterThan(100);
    expect(structured.rows.length).toBeLessThan(1000);
    expect(out).toContain(`| ${structured.rows.length - 1} | `);
    expect(out).not.toContain(`| ${structured.rows.length} | `);
  });

  it("is not listed for a caller without the scope, and says why when called", async () => {
    const { tools } = sqlHost({
      sqlSchema: async () => {
        throw new Forbidden("this credential cannot do that: it needs the sql scope");
      },
    });
    expect((await tools.list()).map((t) => t.name)).not.toContain("sql");
    const result = await tools.call("sql", { sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "error sql_unavailable: sql is not available: this credential has no sql scope",
    );
    for (const [status, code] of [
      [501, "sql_unavailable"],
      [404, "search_disabled"],
    ] as const) {
      const other = sqlHost({
        sqlSchema: async () => {
          throw new ServerError(status, code, `the server says ${code}`);
        },
      });
      expect((await other.tools.list()).map((t) => t.name)).not.toContain("sql");
      expect(textOf(await other.tools.call("sql", { sql: "SELECT 1" }))).toContain(
        `sql is not available: the server says ${code}`,
      );
    }
  });

  it("asks again after a failure that may pass, and lists sql when it does", async () => {
    let down = true;
    const { tools } = sqlHost({
      sqlSchema: async () => {
        if (down) throw new ServerError(503, "index_unavailable", "the index is being built");
        return SCHEMA;
      },
    });
    expect((await tools.list()).map((t) => t.name)).not.toContain("sql");
    const failed = await tools.call("sql", { sql: "SELECT 1" });
    expect(textOf(failed)).toContain(
      "error index_unavailable (HTTP 503): the index is being built",
    );
    down = false;
    expect((await tools.list()).map((t) => t.name)).toContain("sql");
  });

  it("lists sql later, and says the list changed, when the schema is slow", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let changed = 0;
    const { tools } = sqlHost(
      {
        sqlSchema: async () => {
          await slow;
          return SCHEMA;
        },
      },
      { sqlListWaitMs: 10, onListChanged: () => changed++ },
    );
    expect((await tools.list()).map((t) => t.name)).not.toContain("sql");
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toBe(1);
    expect((await tools.list()).map((t) => t.name)).toContain("sql");
  });

  it("answers a refused statement with where it went wrong, from the server or the laptop", async () => {
    const statement = "SELECT *\nFROM read_csv('/etc/passwd')";
    const at = statement.indexOf("read_csv");
    for (const err of [
      new ServerError(400, "sql_refused", "table function read_csv is not allowed", at),
      new SqlFailed("refused", "table function read_csv is not allowed", at),
    ]) {
      const { tools } = sqlHost({
        sql: async () => {
          throw err;
        },
      });
      const result = await tools.call("sql", { sql: statement });
      expect(result.isError).toBe(true);
      expect(textOf(result).split("\n").slice(1)).toEqual([
        err instanceof ServerError
          ? "error sql_refused (HTTP 400): table function read_csv is not allowed"
          : "error sql_refused: table function read_csv is not allowed",
        `at character ${at} (from 0) of the statement:`,
        "  FROM read_csv('/etc/passwd')",
        "       ^",
      ]);
    }
    const { tools } = sqlHost({
      sql: async () => {
        throw new SqlFailed("timeout", "the statement ran past 15 s");
      },
    });
    expect(textOf(await tools.call("sql", { sql: "SELECT 1" }))).toContain(
      "error sql_timeout: the statement ran past 15 s",
    );
  });

  it("refuses bad arguments before calling", async () => {
    const { tools, requests } = sqlHost();
    for (const [args, message] of [
      [{}, "sql is required"],
      [{ sql: "x".repeat(16_385) }, "sql must be at most 16,384 characters"],
      [{ sql: "SELECT 1", max_rows: 0 }, "max_rows must be at least 1"],
      [{ sql: "SELECT 1", max_rows: 1001 }, "max_rows must be at most 1000"],
      [{ sql: "SELECT 1", since: "later" }, "since must be an ISO date or a duration"],
    ] as const) {
      const result = await tools.call("sql", args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(message);
    }
    expect(requests).toEqual([]);
  });

  it("is left out with --tools, even when the caller could use it", async () => {
    const { backend } = fake({ sqlSchema: async () => SCHEMA });
    const tools = new Tools({ backend: async () => ({ backend }), now: () => NOW }, ["search"]);
    expect((await tools.list()).map((t) => t.name)).toEqual(["search"]);
    expect(textOf(await tools.call("sql", { sql: "SELECT 1" }))).toContain("no tool sql");
  });
});
