import type {
  AssistantMessageRecord,
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ObservationRecord,
  ReasoningRecord,
  SystemRecord,
  ToolCall,
  ToolResultRecord,
  UserRecord,
} from "@letta-ai/trajectory";
import type { TraceRecord } from "../generated/trace";

export type {
  AssistantMessageRecord,
  AssistantToolCallRecord,
  MetaRecord,
  NormalizedRecord,
  ObservationRecord,
  ReasoningRecord,
  SystemRecord,
  ToolCall,
  ToolResultRecord,
  UserRecord,
};

/** Thrown when a value is not a trajectory-v1 record set the store accepts. */
export class TrajectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrajectoryError";
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point
const SCOPE_COORDINATE = /^[^\x00-\x1f\x7f\u0085\u2028\u2029]*$/;

export function isScopeCoordinate(value: unknown): value is string {
  return typeof value === "string" && SCOPE_COORDINATE.test(value);
}

const TEXT_ROLES = new Set(["user", "system", "observation", "reasoning"]);

function fail(index: number, message: string): never {
  throw new TrajectoryError(`record ${index}: ${message}`);
}

function requireString(index: number, record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") fail(index, `${key} must be a string`);
  return value;
}

function optionalString(
  index: number,
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(index, `${key} must be a string`);
  return value;
}

function validateToolCall(index: number, value: unknown, at: number): ToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(index, `tool_calls[${at}] must be an object`);
  }
  const call = value as Record<string, unknown>;
  const id = requireString(index, call, "id");
  const name = requireString(index, call, "name");
  const args = requireString(index, call, "args");
  if (id === "") fail(index, `tool_calls[${at}].id must not be empty`);
  if (name === "") fail(index, `tool_calls[${at}].name must not be empty`);
  return { id, name, args };
}

function nonEmptyOptional(
  index: number,
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = optionalString(index, record, key);
  if (value === "") fail(index, `${key} must not be empty`);
  return value;
}

const WITHHELD = new Set(["sensitive-file", "secret-output", "review"]);

/** A user record's labels for content the agent or a plugin added to the turn: `synthetic`, and
 * `omitted`, the items left out there at their integrator's request. */
function injected(index: number, record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const synthetic = record.synthetic;
  if (synthetic !== undefined && synthetic !== null) {
    if (synthetic !== true) fail(index, "synthetic must be true");
    out.synthetic = true;
  }
  const omitted = record.omitted;
  if (omitted !== undefined && omitted !== null) {
    if (!Number.isInteger(omitted) || (omitted as number) < 1) {
      fail(index, "omitted must be an integer ≥ 1");
    }
    out.omitted = omitted;
  }
  return out;
}

function extensions(
  index: number,
  record: Record<string, unknown>,
  role: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (role === "meta") {
    const version = optionalString(index, record, "agent_version");
    if (version !== undefined) out.agent_version = version;
    return out;
  }
  const id = nonEmptyOptional(index, record, "id");
  if (id !== undefined) out.id = id;
  if (role !== "tool") {
    const call = nonEmptyOptional(index, record, "llm_call");
    if (call !== undefined) out.llm_call = call;
    if (role === "user") Object.assign(out, injected(index, record));
    return out;
  }
  const withheld = record.withheld;
  if (withheld !== undefined && withheld !== null) {
    if (typeof withheld !== "string" || !WITHHELD.has(withheld)) {
      fail(index, "withheld must be sensitive-file, secret-output or review");
    }
    out.withheld = withheld;
  }
  const duration = record.duration_ms;
  if (duration !== undefined && duration !== null) {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
      fail(index, "duration_ms must be a number ≥ 0");
    }
    out.duration_ms = duration;
  }
  return out;
}

function validateRecord(index: number, value: unknown, extended: boolean): NormalizedRecord {
  const record = validateCore(index, value);
  if (!extended) return record;
  return { ...record, ...extensions(index, value as Record<string, unknown>, record.role) };
}

function validateCore(index: number, value: unknown): NormalizedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(index, "must be an object");
  }
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role === "meta") {
    const source = requireString(index, record, "source");
    if (source === "" || !isScopeCoordinate(source))
      fail(index, "source must be a scope coordinate");
    const git_branch = optionalString(index, record, "git_branch");
    if (git_branch !== undefined && !isScopeCoordinate(git_branch)) {
      fail(index, "git_branch must be a scope coordinate");
    }
    const meta: MetaRecord = { role, source };
    const cwd = optionalString(index, record, "cwd");
    const model = optionalString(index, record, "model");
    if (cwd !== undefined) meta.cwd = cwd;
    if (git_branch !== undefined) meta.git_branch = git_branch;
    if (model !== undefined) meta.model = model;
    return meta;
  }
  if (typeof role === "string" && TEXT_ROLES.has(role)) {
    return {
      role: role as "user" | "system" | "observation" | "reasoning",
      content: requireString(index, record, "content"),
      timestamp: requireString(index, record, "timestamp"),
    };
  }
  if (role === "assistant") {
    const timestamp = requireString(index, record, "timestamp");
    const calls = record.tool_calls;
    if (calls !== undefined && calls !== null) {
      if (!Array.isArray(calls)) fail(index, "tool_calls must be an array");
      const content = record.content;
      if (content !== null && content !== undefined && typeof content !== "string") {
        fail(index, "content must be a string or null");
      }
      return {
        role,
        content: content ?? null,
        tool_calls: calls.map((call, at) => validateToolCall(index, call, at)),
        timestamp,
      } as AssistantToolCallRecord;
    }
    const content = record.content;
    if (content === null || content === undefined) {
      return { role, content: null, timestamp } as unknown as AssistantMessageRecord;
    }
    if (typeof content !== "string") fail(index, "content must be a string or null");
    return { role, content, timestamp };
  }
  if (role === "tool") {
    const tool_call_id = requireString(index, record, "tool_call_id");
    if (tool_call_id === "") fail(index, "tool_call_id must not be empty");
    const result: ToolResultRecord = {
      role,
      tool_call_id,
      content: requireString(index, record, "content"),
      timestamp: requireString(index, record, "timestamp"),
    };
    const ok = record.ok;
    if (ok !== undefined && ok !== null) {
      if (typeof ok !== "boolean") fail(index, "ok must be a boolean");
      result.ok = ok;
    }
    return result;
  }
  fail(index, `unknown role ${JSON.stringify(role)}`);
}

/** The records as trajectory-v1, or a `TrajectoryError` naming the first bad one. Does not check
 * the conversation-level rules (meta first, has a user record, …): `parseTrajectory` does. */
export function validateRecords(records: unknown): NormalizedRecord[] {
  if (!Array.isArray(records)) throw new TrajectoryError("records must be an array");
  return records.map((record, index) => validateRecord(index, record, false));
}

/** The records as the canonical trace's records: trajectory-v1, plus the optional fields
 * `seshi/trace/1` adds, kept and checked. Unknown fields are dropped, as `validateRecords`
 * drops them. */
export function validateTraceRecords(records: unknown): TraceRecord[] {
  if (!Array.isArray(records)) throw new TrajectoryError("records must be an array");
  return records.map((record, index) => validateRecord(index, record, true) as TraceRecord);
}
