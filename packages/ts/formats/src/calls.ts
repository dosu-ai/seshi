import type { LlmCall, NormalizedRecord, NormalizedTranscript } from "@seshi/model";

export interface CallSite {
  timestamp: unknown;
  call: string;
}

export interface SourceCalls {
  calls: LlmCall[];
  sites: CallSite[];
}

const CALL_ROLES = new Set(["assistant", "reasoning"]);

export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

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

export function asTranscript(
  result: NormalizedRecord[] | NormalizedTranscript,
): NormalizedTranscript {
  return Array.isArray(result) ? { records: result } : result;
}
