/** `seshi mcp`'s tools, apart from the protocol: their schemas, and each call turned into a
 * backend call and its answer into text for a model. docs/seshi/session-tools.md ("seshi mcp"). */
import { ServerError } from "@seshi/client";
import {
  DEFAULT_READ_CONTEXT,
  EVENT_ROLES,
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
} from "@seshi/model";
import type { Backend } from "../backend";
import { parseSessionRef } from "../backend";
import { classify } from "../cli/failures";
import { eventsLines, listLines, searchLines, timeOrAge, utc } from "../session-text";

/** A result's text stops here, at a line boundary. */
export const MAX_RESULT_CHARS = 30_000;

export const TOOL_NAMES = ["list_sessions", "read_session", "search"] as const;
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
      since: { type: "string", default: "7d", description: "ISO date or duration (7d, 24h)" },
      until: str("ISO date or duration (7d, 24h)"),
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      after: str("the cursor from the last page"),
    },
  ),
  tool(
    "read_session",
    "Read a session",
    "Read part of one session's events, as lines `#seq role tool ok time text`. `seq` numbers the session's events from 0. Read a range (from/to), the events around one (around, with context), or one long event in pieces (event, offset). Condensed mode (the default) cuts tool results to 200 characters; full gives them whole. A search match `#7@1a2b3c4d` is trace 1a2b3c4d, event 7: pass trace and around to read around it. Answers stop at max_chars and say `next: <seq>` to read on from.",
    {
      session: str("owner/archive_id, format/session_id, or a seshi URL"),
      from: { type: "integer", minimum: 0 },
      to: { type: "integer", minimum: 0 },
      around: {
        type: "integer",
        minimum: 0,
        description:
          "a seq, or with trace a search match's event; reads context events either side",
      },
      context: {
        type: "integer",
        minimum: 0,
        maximum: MAX_READ_CONTEXT,
        default: DEFAULT_READ_CONTEXT,
      },
      trace: str(
        "a search match's trace (8 or more characters of its hash): count from, to, around and event from its start",
      ),
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
    "Full-text search over the sessions you may read: prompts, answers and tool calls. Each result is a session line, then its best matches as `#event@trace role tool: excerpt` (read them with read_session's trace and around).",
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
];

/** What the tools run against. */
export interface ToolHost {
  /** The backend to call; it may throw (not signed in, the server down), and every tool then
   * answers that error. */
  backend(): Promise<Backend>;
  now(): Date;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

class BadArguments extends Error {}

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
    case "string":
      return typeof value === "string" ? undefined : `${name} must be a string`;
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
  index?: SearchIndexState,
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

/** An error as a tool result: the API's code and message. */
export function errorResult(err: unknown, header: string): ToolResult {
  if (err instanceof BadArguments)
    return text(`${header}\nerror bad_arguments: ${err.message}`, true);
  if (err instanceof ServerError) {
    return text(`${header}\nerror ${err.code} (HTTP ${err.status}): ${err.message}`, true);
  }
  const known = classify(err);
  if (known) return text(`${header}\nerror ${known.code}: ${known.message}`, true);
  const message = err instanceof Error ? err.message : String(err);
  return text(`${header}\nerror internal: ${message}`, true);
}

export class Tools {
  private me: Identity | undefined;

  constructor(
    private readonly host: ToolHost,
    readonly enabled: readonly ToolName[] = TOOL_NAMES,
  ) {}

  list(): ToolDefinition[] {
    return TOOLS.filter((t) => this.enabled.includes(t.name));
  }

  private async scope(backend: Backend): Promise<string> {
    this.me ??= await backend.me();
    return scopeOf(this.me, backend.mode);
  }

  async call(name: string, args: Args = {}): Promise<ToolResult> {
    const now = this.host.now();
    let header = `now ${utc(now.toISOString())}`;
    try {
      const definition = this.list().find((t) => t.name === name);
      if (definition === undefined) throw new BadArguments(`no tool ${name}`);
      check(definition, args);
      const backend = await this.host.backend();
      const scope = await this.scope(backend);
      header = headerLine(now, scope);
      switch (definition.name) {
        case "list_sessions":
          return text(await this.listSessions(backend, args, now, scope));
        case "read_session":
          return text(await this.readSession(backend, args, header));
        case "search":
          return text(await this.search(backend, args, now, scope));
      }
    } catch (err) {
      return errorResult(err, header);
    }
  }

  private async listSessions(backend: Backend, args: Args, now: Date, scope: string) {
    const since = when(args.since ?? "7d", "since", now);
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
      "trace",
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
