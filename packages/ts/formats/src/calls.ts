/** LLM calls read from a native log, for an adapter whose library drops them (X6.2: the
 * canonical format carries token usage and the model per turn, since raw is not stored).
 *
 * An integration reads its own log for what each model call cost (`SourceCalls`): the calls,
 * and for each line the model wrote, when it was written and which call wrote it. `attachCalls`
 * then names the call on each assistant and reasoning record written at that moment. Records
 * are matched by timestamp because the normalizing library does not say which line a record
 * came from; a moment at which lines of two different calls were written is ambiguous, and its
 * records name no call rather than a guessed one. */

import type { LlmCall, NormalizedRecord, NormalizedTranscript } from "@seshi/model";

/** A line of the log the model wrote: when, as written, and the id of the call it came from. */
export interface CallSite {
  timestamp: unknown;
  call: string;
}

/** What a log says about its model calls. */
export interface SourceCalls {
  calls: LlmCall[];
  sites: CallSite[];
}

/** The roles a model call writes. */
const CALL_ROLES = new Set(["assistant", "reasoning"]);

/** A timestamp as the normalizing library writes it (ISO 8601 in UTC, milliseconds), or `null`
 * for one that is not a time. */
export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The records with `llm_call` set where the log says which call wrote them, and the calls they
 * name (in the order the records first name them). Records the log does not place keep no
 * `llm_call`; a call no record names is left out. */
export function attachCalls(
  records: readonly NormalizedRecord[],
  source: SourceCalls,
): NormalizedTranscript {
  const byId = new Map(source.calls.map((call) => [call.id, call]));
  const at = new Map<string, Set<string>>();
  for (const site of source.sites) {
    const when = isoTimestamp(site.timestamp);
    if (when === null || !byId.has(site.call)) continue;
    const ids = at.get(when) ?? new Set<string>();
    ids.add(site.call);
    at.set(when, ids);
  }
  const named = new Map<string, LlmCall>();
  const out = records.map((record) => {
    if (!CALL_ROLES.has(record.role)) return record;
    const when = isoTimestamp((record as { timestamp?: unknown }).timestamp);
    const ids = when === null ? undefined : at.get(when);
    if (ids?.size !== 1) return record;
    const [id] = ids;
    named.set(id as string, byId.get(id as string) as LlmCall);
    return { ...record, llm_call: id } as unknown as NormalizedRecord;
  });
  return named.size > 0 ? { records: out, llm_calls: [...named.values()] } : { records: out };
}

/** An adapter's result as records and calls. */
export function asTranscript(
  result: NormalizedRecord[] | NormalizedTranscript,
): NormalizedTranscript {
  return Array.isArray(result) ? { records: result } : result;
}
