import { parseDuration } from "@seshi/config";
import {
  type EventRole,
  labelPairs,
  type SearchRequest,
  type SearchSort,
  type SessionEventsRequest,
  type SessionListRequest,
} from "@seshi/model";
import { SearchQueryError, SessionReadError } from "@seshi/search";

const STRINGS = [
  "q",
  "owner",
  "agent",
  "repo",
  "branch",
  "harness",
  "agent_version",
  "model",
  "source",
  "since",
  "until",
  "cursor",
];
const NUMBERS = ["limit", "matches"];
const KNOWN = new Set([...STRINGS, ...NUMBERS, "sort", "label", "role"]);

export function searchRequestOf(url: URL): SearchRequest {
  const params = url.searchParams;
  for (const name of new Set(params.keys())) {
    if (!KNOWN.has(name)) throw new SearchQueryError(`unknown parameter ${name}`);
    if (name !== "label" && params.getAll(name).length > 1) {
      throw new SearchQueryError(`${name} is given twice`);
    }
  }
  const request: Record<string, unknown> = { q: params.get("q") ?? "" };
  for (const name of STRINGS) {
    const value = params.get(name);
    if (name !== "q" && value !== null && value !== "") request[name] = value;
  }
  for (const name of NUMBERS) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    if (!/^\d+$/.test(value)) throw new SearchQueryError(`${name} must be a whole number`);
    request[name] = Number.parseInt(value, 10);
  }
  const labels = labelsOf(params.getAll("label"));
  if (labels) request.labels = labels;
  const role = params.get("role");
  if (role !== null && role !== "") {
    // Checked against the roles in `checkRequest`.
    request.role = role.split(",").map((r) => r.trim() as EventRole);
  }
  const sort = params.get("sort");
  if (sort !== null && sort !== "") request.sort = sort as SearchSort;
  return request as unknown as SearchRequest;
}

/** `label=key=value`, repeatable: a session must carry every one. */
export function labelsOf(given: readonly string[]): Record<string, string> | undefined {
  if (given.length === 0) return undefined;
  const parsed = labelPairs(given);
  if ("problem" in parsed) throw new SearchQueryError(`label: ${parsed.problem}`);
  return parsed.labels;
}

const LIST_STRINGS = [
  "owner",
  "agent",
  "repo",
  "branch",
  "harness",
  "agent_version",
  "model",
  "source",
  "since",
  "until",
  "after",
];
const LIST_KNOWN = new Set([...LIST_STRINGS, "limit", "label"]);

function single(params: URLSearchParams, known: ReadonlySet<string>, repeatable: string): void {
  for (const name of new Set(params.keys())) {
    if (!known.has(name)) throw new SearchQueryError(`unknown parameter ${name}`);
    if (name !== repeatable && params.getAll(name).length > 1) {
      throw new SearchQueryError(`${name} is given twice`);
    }
  }
}

function wholeParam(params: URLSearchParams, name: string): number | undefined {
  const value = params.get(name);
  if (value === null || value === "") return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new SearchQueryError(`${name} must be a whole number`);
  return Number.parseInt(value, 10);
}

/** `GET /v1/search/sessions`'s query. `since` and `until` take a time or an age (`7d`). */
export function sessionListRequestOf(url: URL, now: Date): SessionListRequest {
  const params = url.searchParams;
  single(params, LIST_KNOWN, "label");
  const request: Record<string, unknown> = {};
  for (const name of LIST_STRINGS) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    request[name] = name === "since" || name === "until" ? timeOrAge(value, name, now) : value;
  }
  const limit = wholeParam(params, "limit");
  if (limit !== undefined) request.limit = limit;
  const labels = labelsOf(params.getAll("label"));
  if (labels) request.labels = labels;
  return request as SessionListRequest;
}

/** A time as a date or an RFC 3339 time: four-digit year first, so a bare number (`7`) is not
 * read as a year. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}/;

/** A time (RFC 3339, or a date) or an age back from `now` (`7d`, `24h`), as RFC 3339. */
export function timeOrAge(value: string, name: string, now: Date): string {
  const ago = parseDuration(value);
  if (ago !== undefined) return new Date(now.getTime() - ago).toISOString();
  const ms = ISO_TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new SearchQueryError(`${name} must be a time (RFC 3339) or an age (7d, 24h)`);
  }
  return new Date(ms).toISOString();
}

const EVENT_NUMBERS = ["from", "to", "around", "context", "max_chars", "event", "offset"];
const EVENT_KNOWN = new Set([...EVENT_NUMBERS, "mode", "roles", "head", "owner"]);

/** `GET …/events`' query: `roles` is comma-separated, or repeated. */
export function eventsRequestOf(url: URL): SessionEventsRequest {
  const params = url.searchParams;
  for (const name of new Set(params.keys())) {
    if (!EVENT_KNOWN.has(name)) {
      throw new SessionReadError(400, "bad_query", `unknown parameter ${name}`);
    }
    if (name !== "roles" && params.getAll(name).length > 1) {
      throw new SessionReadError(400, "bad_query", `${name} is given twice`);
    }
  }
  const request: Record<string, unknown> = {};
  for (const name of EVENT_NUMBERS) {
    const value = params.get(name);
    if (value === null || value === "") continue;
    if (!/^\d{1,15}$/.test(value)) {
      throw new SessionReadError(400, "bad_query", `${name} must be a whole number`);
    }
    request[name] = Number.parseInt(value, 10);
  }
  const mode = params.get("mode");
  if (mode !== null && mode !== "") request.mode = mode;
  const roles = params
    .getAll("roles")
    .flatMap((r) => r.split(","))
    .map((r) => r.trim())
    .filter((r) => r !== "");
  if (roles.length > 0) request.roles = roles;
  const head = params.get("head");
  if (head !== null && head !== "") request.head = head;
  return request as SessionEventsRequest;
}
