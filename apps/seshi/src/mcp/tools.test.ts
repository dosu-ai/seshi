import { ServerError } from "@seshi/client";
import type {
  SearchRequest,
  SearchResults,
  SessionEvents,
  SessionEventsRequest,
  SessionList,
  SessionListRequest,
} from "@seshi/model";
import { describe, expect, it } from "vitest";
import { NotSignedIn } from "../account/credential";
import type { Backend, SessionRef } from "../backend";
import { capped, MAX_RESULT_CHARS, TOOLS, Tools } from "./tools";

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
  it("lists three read-only tools with the design's schemas", () => {
    expect(
      new Tools({ backend: async () => ({ backend: fake().backend }), now: () => NOW })
        .list()
        .map((t) => t.name),
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
      new Tools({ backend: async () => ({ backend: fake().backend }), now: () => NOW }, [
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
      trace: "cccccccc",
      around: 7,
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
      { trace: "cccccccc", around: 7, context: 2, mode: "full" },
    ]);
    await tools(backend).call("read_session", { session: "claude-code/s1", from: 0 });
    expect(calls.read[1]?.[0]).toEqual({ format: "claude-code", sessionId: "s1" });
    await tools(backend).call("read_session", {
      session: `https://seshi.example.com/v1/owners/alice/sessions/${A}/events`,
    });
    expect(calls.read[2]?.[0]).toEqual({ owner: "alice", archiveId: A });
  });

  it("search: a block per session, matches with their trace and event, and the total", async () => {
    const { backend, calls } = fake();
    const result = await tools(backend).call("search", {
      query: "scrub",
      since: "7d",
      sort: "recent",
    });
    expect(textOf(result).split("\n")).toEqual([
      "now 2026-11-25T12:00:00Z · as alice (member: own + org) · window 2026-11-18T12:00:00Z → now · index updated 40 s ago",
      `alice/${A} · claude-code/s1 · github.com/acme/app@main · 2026-11-25T09:00:00Z → 10:02:41Z · claude-opus-5-5 · team=core · score 4.2 · 2 matches`,
      "  #7@cccccccc tool_result Bash: FAIL src/lance.test.ts > scrub",
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
      ["sql", { sql: "SELECT 1" }, "no tool sql"],
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
