import type { SessionMetadata } from "./generated/metadata";
import type { Trace } from "./generated/trace";

/** Metadata and traces written before seshi 0.16 name the session's format `agent`. Readers
 * take `format ?? agent`; writers write only `format`. These turn an object as stored into one
 * as it is written now, and leave one that already has `format`, or that is not an object at
 * all (for the caller's own shape check to refuse), as it is. */
function formatNamed<T extends { format: string }>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  const stored = value as T & { agent?: unknown };
  if (stored.agent === undefined) return value;
  const { agent, ...rest } = stored;
  if (typeof rest.format === "string") return rest as unknown as T;
  return { ...rest, format: agent } as unknown as T;
}

/** A `metadata.json` as decoded, with the format under `format` whichever name it was written
 * with. */
export function upgradeMetadata(metadata: SessionMetadata): SessionMetadata {
  return formatNamed(metadata);
}

/** A trace as decoded, with the format under `format` whichever name it was written with. The
 * content hash does not cover it, so the trace's hash and key are unchanged. */
export function upgradeTrace(trace: Trace): Trace {
  return formatNamed(trace);
}
