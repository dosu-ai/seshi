/** `read_session`: part of one session's events, read from the store (not the index, which cuts
 * text by role). Events are numbered by `seq`, their place in the session's current trace
 * chain (`currentTraces`), counting from 0 across its traces. docs/seshi/session-tools.md. */
import {
  CONDENSED_TOOL_CHARS,
  DEFAULT_READ_CONTEXT,
  EVENT_ROLES,
  type EventRole,
  type LlmCall,
  MAX_READ_CHARS,
  MAX_READ_CONTEXT,
  MIN_READ_CHARS,
  SESSION_READ_MODES,
  type SessionEvent,
  type SessionEvents,
  type SessionEventsRequest,
  type SessionHeader,
  type SessionMetadata,
  type SessionReadMode,
  type SessionTokens,
  type TraceEvent,
} from "@seshi/model";
import { decodeTrace, getBytes, keys, type Store } from "@seshi/store";
import { currentTraces } from "./indexer";

/** Why a read was refused, with the HTTP status the API answers. */
export class SessionReadError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionReadError";
  }
}

/** What a read keeps of a trace: its events and its model calls' totals, not its records (which
 * hold the same text again). */
export interface ReadTrace {
  events: readonly TraceEvent[];
  started_at: string | null;
  ended_at: string | null;
  /** Each call's model, in order, and the usage summed. */
  models: string[];
  calls: number;
  tokens: SessionTokens;
}

const NO_TOKENS: SessionTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_tokens: 0,
  total_tokens: 0,
};

function tokensOf(calls: readonly LlmCall[]): SessionTokens {
  const sum = { ...NO_TOKENS };
  for (const call of calls) {
    const usage = call.usage ?? {};
    for (const key of Object.keys(sum) as (keyof SessionTokens)[]) {
      const n = usage[key];
      if (typeof n === "number" && Number.isFinite(n)) sum[key] += n;
    }
  }
  return sum;
}

/** Decoded traces, kept a while: traces are immutable under their hash, so a long session read
 * a range at a time costs one read per trace it crosses. A redaction backfill may rewrite a
 * trace in place under the same hash, so the key also names the rule set the trace was last
 * redacted under. */
export class TraceCache {
  private readonly held = new Map<string, Promise<ReadTrace | null>>();

  constructor(private readonly max = 32) {}

  get(key: string, load: () => Promise<ReadTrace | null>): Promise<ReadTrace | null> {
    const held = this.held.get(key);
    if (held !== undefined) {
      // Most recently used last.
      this.held.delete(key);
      this.held.set(key, held);
      return held;
    }
    const loading = load();
    this.held.set(key, loading);
    // A failed or missing read is not kept.
    loading.then(
      (trace) => {
        if (trace === null) this.held.delete(key);
      },
      () => this.held.delete(key),
    );
    while (this.held.size > this.max) {
      const oldest = this.held.keys().next().value as string;
      this.held.delete(oldest);
    }
    return loading;
  }

  get size(): number {
    return this.held.size;
  }
}

async function loadTrace(
  store: Store,
  folder: string,
  archive: string,
  hash: string,
): Promise<ReadTrace | null> {
  const bytes = await getBytes(store, keys.trace(folder, archive, hash));
  if (bytes === null) return null;
  const trace = decodeTrace(bytes);
  const calls = trace.llm_calls ?? [];
  return {
    events: trace.events,
    started_at: trace.started_at,
    ended_at: trace.ended_at,
    models: calls.map((c) => c.model).filter((m): m is string => typeof m === "string"),
    calls: calls.length,
    tokens: tokensOf(calls),
  };
}

function whole(value: unknown, name: string, min = 0): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new SessionReadError(
      400,
      "bad_query",
      `${name} must be a whole number of at least ${min}`,
    );
  }
  return value;
}

interface Checked {
  range: { from: number; to?: number } | { around: number; context: number } | null;
  piece: { event: number; offset: number } | null;
  mode: SessionReadMode;
  roles: ReadonlySet<EventRole> | null;
  maxChars: number;
  head?: string;
  trace?: string;
}

export function checkEventsRequest(request: SessionEventsRequest): Checked {
  const from = whole(request.from, "from");
  const to = whole(request.to, "to");
  const around = whole(request.around, "around");
  const context = whole(request.context, "context");
  const event = whole(request.event, "event");
  const offset = whole(request.offset, "offset");
  const maxChars = whole(request.max_chars, "max_chars", MIN_READ_CHARS);
  const mode = request.mode ?? "condensed";
  if (!SESSION_READ_MODES.includes(mode)) {
    throw new SessionReadError(400, "bad_query", `mode must be ${SESSION_READ_MODES.join(" or ")}`);
  }
  const ranged = from !== undefined || to !== undefined;
  if (around !== undefined && ranged) {
    throw new SessionReadError(400, "bad_query", "around and from/to are separate reads");
  }
  if (event !== undefined && (ranged || around !== undefined)) {
    throw new SessionReadError(400, "bad_query", "event reads one event: no from, to or around");
  }
  if (offset !== undefined && event === undefined) {
    throw new SessionReadError(400, "bad_query", "offset goes with event");
  }
  if (context !== undefined && around === undefined) {
    throw new SessionReadError(400, "bad_query", "context goes with around");
  }
  if (from !== undefined && to !== undefined && to < from) {
    throw new SessionReadError(400, "bad_query", "to is before from");
  }
  let roles: Set<EventRole> | null = null;
  if (request.roles !== undefined && request.roles.length > 0) {
    for (const role of request.roles) {
      if (!EVENT_ROLES.includes(role)) {
        throw new SessionReadError(
          400,
          "bad_query",
          `roles must be among ${EVENT_ROLES.join(", ")}`,
        );
      }
    }
    roles = new Set(request.roles);
  }
  if (request.trace !== undefined && !/^[0-9a-f]{8,64}$/.test(request.trace)) {
    throw new SessionReadError(
      400,
      "bad_query",
      "trace is a content hash, or its first 8 or more characters",
    );
  }
  if (request.head !== undefined && !/^[0-9a-f]{64}$/.test(request.head)) {
    throw new SessionReadError(400, "bad_query", "head is a trace's 64-character content hash");
  }
  return {
    range:
      around !== undefined
        ? {
            around,
            context: Math.min(context ?? DEFAULT_READ_CONTEXT, MAX_READ_CONTEXT),
          }
        : event !== undefined
          ? null
          : { from: from ?? 0, ...(to !== undefined ? { to } : {}) },
    piece: event !== undefined ? { event, offset: offset ?? 0 } : null,
    mode,
    roles,
    maxChars: Math.min(maxChars ?? MAX_READ_CHARS, MAX_READ_CHARS),
    ...(request.trace !== undefined ? { trace: request.trace } : {}),
    ...(request.head !== undefined ? { head: request.head } : {}),
  };
}

export interface ReadSessionOptions {
  store: Store;
  /** The folder the session is in (its owner, or an alias of it). */
  folder: string;
  metadata: SessionMetadata;
  request: SessionEventsRequest;
  cache?: TraceCache;
}

function iso(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function headerOf(metadata: SessionMetadata, traces: readonly ReadTrace[]): SessionHeader {
  const starts = traces.map((t) => iso(t.started_at)).filter((t) => t !== undefined);
  const ends = traces.map((t) => iso(t.ended_at)).filter((t) => t !== undefined);
  const models: string[] = [];
  for (const t of traces) for (const m of t.models) if (!models.includes(m)) models.push(m);
  if (models.length === 0) models.push(...(metadata.models ?? []));
  const tokens = { ...NO_TOKENS };
  for (const t of traces) {
    for (const key of Object.keys(tokens) as (keyof SessionTokens)[]) tokens[key] += t.tokens[key];
  }
  starts.sort();
  ends.sort();
  const started = starts[0];
  const ended = ends.at(-1);
  return {
    owner: metadata.owner,
    archive_id: metadata.archive_id,
    format: metadata.format,
    session_id: metadata.session_id,
    ...(metadata.origin_agent ? { origin_agent: metadata.origin_agent } : {}),
    ...(metadata.source ? { harness: metadata.source } : {}),
    ...(metadata.project ? { project: metadata.project } : {}),
    ...(metadata.repo ? { repo: metadata.repo } : {}),
    ...(metadata.branch ? { branch: metadata.branch } : {}),
    ...(metadata.labels && Object.keys(metadata.labels).length > 0
      ? { labels: metadata.labels }
      : {}),
    visibility: metadata.visibility,
    ...(started !== undefined ? { started_at: started } : {}),
    ...(ended !== undefined ? { ended_at: ended } : {}),
    updated_at: metadata.updated_at,
    head: metadata.head as string,
    traces: traces.length,
    events: traces.reduce((n, t) => n + t.events.length, 0),
    models,
    llm_calls: traces.reduce((n, t) => n + t.calls, 0),
    tokens,
  };
}

function eventOf(e: TraceEvent, seq: number, hash: string, text: string): SessionEvent {
  const timestamp = iso(e.timestamp);
  return {
    seq,
    role: e.role,
    content_hash: hash,
    event_index: e.index,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(e.tool_name !== undefined ? { tool_name: e.tool_name } : {}),
    ...(e.tool_call_id !== undefined ? { tool_call_id: e.tool_call_id } : {}),
    ...(e.ok !== undefined ? { ok: e.ok } : {}),
    text,
    chars: e.text.length,
  };
}

/** Count `checked`'s positions from the start of the trace it names, as `seq`s. */
function shift(
  checked: Checked,
  chain: readonly string[],
  starts: readonly number[],
  traces: readonly ReadTrace[],
): void {
  const prefix = checked.trace as string;
  const found = chain.flatMap((hash, i) => (hash.startsWith(prefix) ? [i] : []));
  if (found.length !== 1) {
    throw new SessionReadError(
      found.length === 0 ? 404 : 400,
      found.length === 0 ? "not_in_chain" : "bad_query",
      found.length === 0
        ? `trace ${prefix} is not in the session's current traces: it was replaced since; search again`
        : `trace ${prefix} names more than one of the session's traces: give more of its hash`,
    );
  }
  const i = found[0] as number;
  const base = starts[i] as number;
  const length = (traces[i] as ReadTrace).events.length;
  const inTrace = (n: number, name: string) => {
    if (n >= length) {
      throw new SessionReadError(
        400,
        "bad_query",
        `${name} ${n} is past trace ${prefix}'s ${length} events`,
      );
    }
    return base + n;
  };
  if (checked.piece !== null) {
    checked.piece = { ...checked.piece, event: inTrace(checked.piece.event, "event") };
  } else if (checked.range !== null && "around" in checked.range) {
    checked.range = { ...checked.range, around: inTrace(checked.range.around, "around") };
  } else if (checked.range !== null) {
    checked.range = {
      from: base + Math.min(checked.range.from, length),
      ...(checked.range.to !== undefined ? { to: base + Math.min(checked.range.to, length) } : {}),
    };
  }
}

/** A part of the session's events. Throws `SessionReadError` for a request that cannot be
 * answered: a bad range (400), no trace (404), a changed head (409) or a redacted session
 * (410). The caller has already checked that the session may be read. */
export async function readSessionEvents(options: ReadSessionOptions): Promise<SessionEvents> {
  const { store, folder, metadata } = options;
  const checked = checkEventsRequest(options.request);
  if (metadata.status === "redacted") {
    throw new SessionReadError(410, "redacted", "session was redacted; no events");
  }
  if (metadata.head === undefined)
    throw new SessionReadError(404, "no_trace", "session has no trace");
  if (checked.head !== undefined && checked.head !== metadata.head) {
    throw new SessionReadError(
      409,
      "head_changed",
      `the session changed since head ${checked.head.slice(0, 12)}: its head is now ${metadata.head}, and its events may be numbered again; read it afresh`,
    );
  }
  const cache = options.cache ?? new TraceCache();
  const ruleSet = (hash: string) =>
    metadata.traces.find((t) => t.content_hash === hash)?.rule_set ??
    metadata.redaction?.rule_set ??
    "";
  const chain = currentTraces(metadata);
  const traces = await Promise.all(
    chain.map(async (hash) => {
      const trace = await cache.get(
        `${folder}/${metadata.archive_id}/${hash}#${ruleSet(hash)}`,
        () => loadTrace(store, folder, metadata.archive_id, hash),
      );
      if (trace === null) {
        throw new SessionReadError(404, "no_trace", `trace ${hash.slice(0, 12)} is missing`);
      }
      return trace;
    }),
  );
  const session = headerOf(metadata, traces);
  const total = session.events;
  /** The event at `seq`, and the trace it is in. */
  const starts: number[] = [];
  let n = 0;
  for (const t of traces) {
    starts.push(n);
    n += t.events.length;
  }
  if (checked.trace !== undefined) shift(checked, chain, starts, traces);
  const at = (seq: number): { event: TraceEvent; hash: string } => {
    let i = starts.length - 1;
    while (i > 0 && (starts[i] as number) > seq) i--;
    const trace = traces[i] as ReadTrace;
    return {
      event: trace.events[seq - (starts[i] as number)] as TraceEvent,
      hash: chain[i] as string,
    };
  };

  if (checked.piece !== null) {
    const { event: seq, offset } = checked.piece;
    if (seq >= total) {
      throw new SessionReadError(
        400,
        "bad_query",
        `event ${seq} is past the session's ${total} events`,
      );
    }
    const { event, hash } = at(seq);
    const text = event.text.slice(offset, offset + checked.maxChars);
    const end = offset + text.length;
    return {
      session,
      mode: "full",
      from: seq,
      to: seq + 1,
      events: [
        {
          ...eventOf(event, seq, hash, text),
          offset,
          ...(end < event.text.length ? { cut: event.text.length - end } : {}),
        },
      ],
      ...(end < event.text.length ? { next_offset: end } : {}),
      ...(seq + 1 < total ? { next: seq + 1 } : {}),
    };
  }

  const range = checked.range as NonNullable<Checked["range"]>;
  if ("around" in range && range.around >= total) {
    throw new SessionReadError(
      400,
      "bad_query",
      `around ${range.around} is past the session's ${total} events`,
    );
  }
  const from =
    "around" in range ? Math.max(0, range.around - range.context) : Math.min(range.from, total);
  const to =
    "around" in range
      ? Math.min(total, range.around + range.context + 1)
      : Math.min(range.to ?? total, total);
  const events: SessionEvent[] = [];
  let left = checked.maxChars;
  let next: number | undefined = to < total ? to : undefined;
  for (let seq = from; seq < to; seq++) {
    const { event, hash } = at(seq);
    if (checked.roles !== null && !checked.roles.has(event.role)) continue;
    const length = event.text.length;
    const keep =
      checked.mode === "condensed" && event.role === "tool_result"
        ? Math.min(length, CONDENSED_TOOL_CHARS)
        : length;
    if (keep <= left) {
      events.push({
        ...eventOf(event, seq, hash, event.text.slice(0, keep)),
        ...(keep < length ? { cut: length - keep } : {}),
      });
      left -= keep;
      continue;
    }
    // It does not fit. Stop at its start, unless nothing is given yet or enough is left to be
    // worth a piece: then cut it, and the caller reads on with event and offset.
    if (events.length > 0 && left < MIN_READ_CHARS) {
      next = seq;
      break;
    }
    events.push({ ...eventOf(event, seq, hash, event.text.slice(0, left)), cut: length - left });
    left = 0;
    next = seq + 1 < total ? seq + 1 : undefined;
    break;
  }
  return {
    session,
    mode: checked.mode,
    from,
    to,
    events,
    ...(next !== undefined ? { next } : {}),
  };
}
