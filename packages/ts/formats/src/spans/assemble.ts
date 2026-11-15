/** A session's span parts → its records and LLM calls (F4.4). Spans arrive in any order and
 * repeat, and the conventions report one conversation several times over, so the assembler
 * orders the parts and keeps each thing said once:
 *
 * 1. One part per span (trace and span id), and one per response: the same response reported
 *    by two spans (an SDK's `CLIENT` span and the API's `SERVER` span under it) is kept from the
 *    server span.
 * 2. Parts in start order. Each part's input is written at its start and its output at its end.
 * 3. A chat request repeats the conversation so far in its input, so within one thread
 *    (`gen_ai.conversation.id`) only what is new is kept: the longest start of the input that
 *    the thread already ends with is dropped. That also covers an input whose earliest messages
 *    were cut to fit a content limit. Reasoning is left out of the comparison, since clients
 *    often drop it from history. System instructions are kept when they change.
 * 4. A tool span's call is written only when no message holds it (a client-side tool, say);
 *    otherwise it adds its duration and failure to the matching result.
 * 5. Each LLM call is named by the records it produced: a chat span's own output, or for a turn
 *    (`invoke_agent`) its assistant records in order over the model requests under it. A
 *    request nested under another that reports usage (a model request inside an API request) is
 *    not counted twice.
 *
 * The result starts with a meta record naming the format and the session's model. */

import type { AssembledSpans, LlmCall, NormalizedRecord, SpanPart, TokenUsage } from "@seshi/model";
import { compareNanos } from "./attributes";

/** Prefer the server's report of a response, then an internal span's, then a client's. */
function kindRank(kind: number | undefined): number {
  return kind === 2 ? 0 : kind === 1 || kind === undefined || kind === 0 ? 1 : 2;
}

const nanosOf = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "0" : (BigInt(ms) * 1_000_000n).toString();
};
const startOf = (part: SpanPart) => part.start_unix_nano ?? nanosOf(part.started_at);
const endOf = (part: SpanPart) =>
  part.end_unix_nano ?? (part.ended_at ? nanosOf(part.ended_at) : startOf(part));

function byStart(a: SpanPart, b: SpanPart): number {
  return (
    compareNanos(startOf(a), startOf(b)) ||
    compareNanos(endOf(b), endOf(a)) ||
    (a.trace_id < b.trace_id ? -1 : a.trace_id > b.trace_id ? 1 : 0) ||
    (a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0)
  );
}

/** What a record says, for matching history: role, text and tool fields, never the time. */
function keyOf(record: NormalizedRecord): string {
  const r = record as unknown as Record<string, unknown>;
  return JSON.stringify([r.role, r.content ?? null, r.tool_calls ?? null, r.tool_call_id ?? null]);
}

const compared = (record: NormalizedRecord) =>
  record.role !== "reasoning" && record.role !== "meta";

/** The records of `input` that `history` does not already end with: the longest start of the
 * input (reasoning aside) that is also the end of the history is dropped. */
export function newInput(
  history: readonly NormalizedRecord[],
  input: readonly NormalizedRecord[],
): NormalizedRecord[] {
  return freshInput(history.filter(compared).map(keyOf), input);
}

/** `newInput` over the history's keys (`keyOf` of its compared records, in order), which the
 * assembler keeps as it goes so no record's key is computed twice. The usual input repeats the
 * whole history, so the longest candidate is tried first and matches at once. */
function freshInput(h: readonly string[], input: readonly NormalizedRecord[]): NormalizedRecord[] {
  const positions: number[] = [];
  input.forEach((record, i) => {
    if (compared(record)) positions.push(i);
  });
  const keys = positions.map((i) => keyOf(input[i] as NormalizedRecord));
  for (let j = Math.min(keys.length, h.length); j > 0; j--) {
    let match = true;
    for (let k = 0; k < j; k++) {
      if (keys[k] !== h[h.length - j + k]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Keep from just after the last matched record; reasoning before the next new one stays.
      const from = (positions[j - 1] as number) + 1;
      return input.slice(from);
    }
  }
  return [...input];
}

/** A thread's history as keys of its compared records. */
function remember(history: string[], records: readonly NormalizedRecord[]): void {
  for (const record of records) if (compared(record)) history.push(keyOf(record));
}

/** The parts that count: one per span, one per response. */
function distinct(parts: readonly SpanPart[]): SpanPart[] {
  const bySpan = new Map<string, SpanPart>();
  for (const part of parts) bySpan.set(`${part.trace_id}-${part.span_id}`, part);
  const byResponse = new Map<string, SpanPart>();
  const dropped = new Set<SpanPart>();
  for (const part of bySpan.values()) {
    if (!part.response_id || !(part.input || part.output || part.llm_call)) continue;
    const seen = byResponse.get(part.response_id);
    if (!seen) {
      byResponse.set(part.response_id, part);
      continue;
    }
    const keep = kindRank(part.kind) < kindRank(seen.kind) ? part : seen;
    dropped.add(keep === part ? seen : part);
    byResponse.set(part.response_id, keep);
  }
  return [...bySpan.values()].filter((part) => !dropped.has(part)).sort(byStart);
}

interface Segment {
  at: string;
  phase: number;
  seq: number;
  records: NormalizedRecord[];
}

function addUsage(into: TokenUsage, from: TokenUsage | undefined): TokenUsage {
  const out: TokenUsage = { ...into };
  for (const [key, value] of Object.entries(from ?? {}) as [keyof TokenUsage, number][]) {
    out[key] = (out[key] ?? 0) + value;
  }
  return out;
}

/** The assembled session (see the module comment). */
export function assembleSpanParts(
  input: readonly SpanPart[],
  session: { source: string },
): AssembledSpans {
  const parts = distinct(input);
  const byId = new Map(parts.map((p) => [`${p.trace_id}-${p.span_id}`, p]));
  const parentOf = (part: SpanPart) =>
    part.parent_span_id ? byId.get(`${part.trace_id}-${part.parent_span_id}`) : undefined;
  /** A part's ancestors, nearest first. Spans come from senders, so a parent chain that loops
   * stops where it would repeat. */
  const ancestors = (part: SpanPart): SpanPart[] => {
    const out: SpanPart[] = [];
    const seen = new Set<SpanPart>([part]);
    for (let p = parentOf(part); p && !seen.has(p); p = parentOf(p)) {
      seen.add(p);
      out.push(p);
    }
    return out;
  };

  // Tool calls some message already holds: a tool span for one adds no records.
  const covered = new Set<string>();
  for (const part of parts) {
    for (const record of [...(part.input ?? []), ...(part.output ?? [])]) {
      if (record.role === "assistant" && "tool_calls" in record) {
        for (const call of record.tool_calls ?? []) covered.add(call.id);
      }
      if (record.role === "tool") covered.add(record.tool_call_id);
    }
  }

  // Calls: a part's own, unless a part above it already reports usage for the same request.
  const calls = new Map<SpanPart, LlmCall>();
  for (const part of parts) {
    if (!part.llm_call) continue;
    const nested = ancestors(part).some((above) => above.llm_call?.usage !== undefined);
    if (!nested) calls.set(part, part.llm_call);
  }

  const histories = new Map<string, string[]>();
  const systems = new Map<string, string>();
  const segments: Segment[] = [];
  let seq = 0;
  const outputs = new Map<SpanPart, NormalizedRecord[]>();
  const toolInfo = new Map<string, { duration_ms?: number; ok?: boolean }>();

  for (const part of parts) {
    const thread = part.thread ?? "";
    const history = histories.get(thread) ?? [];
    histories.set(thread, history);
    if (part.input) {
      const kept: NormalizedRecord[] = [];
      const messages: NormalizedRecord[] = [];
      for (const record of part.input) {
        if (record.role === "system" && messages.length === 0) {
          if (systems.get(thread) !== record.content) {
            systems.set(thread, record.content);
            kept.push(record);
          }
        } else {
          messages.push(record);
        }
      }
      const fresh = freshInput(history, messages);
      remember(history, fresh);
      kept.push(...fresh);
      if (kept.length > 0)
        segments.push({ at: startOf(part), phase: 0, seq: seq++, records: kept });
    }
    if (part.output) {
      const records = part.output.map((r) => ({ ...r }));
      remember(history, records);
      outputs.set(part, records);
      segments.push({ at: endOf(part), phase: 1, seq: seq++, records });
    }
    const tool = part.tool;
    if (tool) {
      const duration =
        part.ended_at !== undefined
          ? Math.max(0, Date.parse(part.ended_at) - Date.parse(part.started_at))
          : undefined;
      const failed = tool.ok === false || part.status === "error";
      if (tool.call_id && covered.has(tool.call_id)) {
        toolInfo.set(tool.call_id, {
          ...(duration !== undefined ? { duration_ms: duration } : {}),
          ...(failed ? { ok: false } : {}),
        });
      } else if (part.content && (tool.args !== undefined || tool.result !== undefined)) {
        const id = tool.call_id ?? `span:${part.span_id}`;
        covered.add(id);
        segments.push({
          at: startOf(part),
          phase: 0,
          seq: seq++,
          records: [
            {
              role: "assistant",
              content: null,
              tool_calls: [{ id, name: tool.name, args: tool.args ?? "{}" }],
              timestamp: part.started_at,
            },
          ],
        });
        segments.push({
          at: endOf(part),
          phase: 1,
          seq: seq++,
          records: [
            {
              role: "tool",
              tool_call_id: id,
              content: tool.result ?? "",
              ...(failed ? { ok: false } : {}),
              ...(duration !== undefined ? { duration_ms: duration } : {}),
              timestamp: part.ended_at ?? part.started_at,
            } as NormalizedRecord,
          ],
        });
      }
    }
  }

  // Name each LLM call by the records it produced.
  const used = new Map<string, LlmCall>();
  const callIds = new Set<string>();
  const unique = (call: LlmCall, part: SpanPart): LlmCall => {
    let id = call.id;
    if (callIds.has(id)) id = `${part.trace_id}-${call.id}`;
    for (let n = 2; callIds.has(id); n++) id = `${part.trace_id}-${call.id}-${n}`;
    callIds.add(id);
    return id === call.id ? call : { ...call, id };
  };
  const label = (records: NormalizedRecord[], call: LlmCall) => {
    for (const record of records) {
      if (record.role === "assistant" || record.role === "reasoning") {
        (record as { llm_call?: string }).llm_call = call.id;
        used.set(call.id, call);
      }
    }
  };
  const fixed = new Map<SpanPart, LlmCall>();
  for (const [part, call] of calls) fixed.set(part, unique(call, part));
  for (const [part, records] of outputs) {
    const own = fixed.get(part);
    if (own) {
      label(records, own);
      continue;
    }
    // A turn: its assistant records over the model requests it owns (those whose nearest
    // ancestor with output is this turn, not a turn nested in it), in order.
    const under = parts.filter((p) => fixed.has(p) && !outputs.has(p) && ownerOf(p) === part);
    if (under.length === 0) continue;
    const turnCalls = under.map((p) => fixed.get(p) as LlmCall);
    const assistant = records.filter((r) => r.role === "assistant");
    if (assistant.length === 0) continue;
    const shares = turnCalls.slice(0, assistant.length);
    // More requests than assistant records: the rest are counted into the last one, so their
    // tokens are not lost.
    const extra = turnCalls.slice(assistant.length);
    if (extra.length > 0) {
      const last = shares[shares.length - 1] as LlmCall;
      let merged: LlmCall = { ...last };
      for (const call of extra) {
        merged = {
          ...merged,
          ...(call.usage || merged.usage
            ? { usage: addUsage(merged.usage ?? {}, call.usage) }
            : {}),
          ...(call.ended_at && (!merged.ended_at || call.ended_at > merged.ended_at)
            ? { ended_at: call.ended_at }
            : {}),
        };
      }
      shares[shares.length - 1] = merged;
    }
    let at = 0;
    for (const record of records) {
      if (record.role !== "assistant" && record.role !== "reasoning") continue;
      const call = shares[Math.min(at, shares.length - 1)] as LlmCall;
      (record as { llm_call?: string }).llm_call = call.id;
      used.set(call.id, call);
      if (record.role === "assistant") at++;
    }
  }

  /** The nearest ancestor of `child` that has output: the turn a model request belongs to. */
  function ownerOf(child: SpanPart): SpanPart | undefined {
    return ancestors(child).find((p) => outputs.has(p));
  }

  segments.sort((a, b) => compareNanos(a.at, b.at) || a.phase - b.phase || a.seq - b.seq);
  const records = segments.flatMap((s) => s.records);
  for (const record of records) {
    if (record.role !== "tool") continue;
    const info = toolInfo.get(record.tool_call_id);
    if (!info) continue;
    const r = record as NormalizedRecord & { duration_ms?: number; ok?: boolean };
    if (info.duration_ms !== undefined && r.duration_ms === undefined)
      r.duration_ms = info.duration_ms;
    if (info.ok === false && r.ok === undefined) r.ok = false;
    toolInfo.delete(record.tool_call_id);
  }

  const meta: NormalizedRecord & { model?: string; cwd?: string; agent_version?: string } = {
    role: "meta",
    source: session.source,
  };
  const model = parts.find((p) => p.meta?.model)?.meta?.model;
  if (model) meta.model = model;
  const cwd = parts.find((p) => p.meta?.cwd)?.meta?.cwd;
  if (cwd) meta.cwd = cwd;
  const version = parts.find((p) => p.meta?.agent_version)?.meta?.agent_version;
  if (version) meta.agent_version = version;
  // Calls in the order the records first name them.
  const llm_calls: LlmCall[] = [];
  const listed = new Set<string>();
  for (const record of records) {
    const ref = (record as { llm_call?: string }).llm_call;
    if (ref === undefined || listed.has(ref)) continue;
    listed.add(ref);
    llm_calls.push(used.get(ref) as LlmCall);
  }
  return { records: [meta, ...records], llm_calls };
}
