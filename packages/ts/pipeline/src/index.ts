/** `@seshi/pipeline`: one session into the store (redact the transcript, store it as a raw part,
 * normalize it through the deployment's format registry, decide what is new, write the
 * canonical trace), and the reads over a store. Layer 2 (X3.2). The write path is today's; branch 04 reworks it
 * into the envelope pipeline (X4). */

export { IngestRejected, OffsetMismatch, SessionRejected } from "@seshi/model";
export {
  canonicalJson,
  copiedPrefix,
  planShipment,
  prefixSha256,
  type ShipPlan,
  type ShippedPrefix,
} from "./continuation";
export {
  getSession,
  getTrace,
  type IngestInput,
  type IngestMetadata,
  type IngestResult,
  ingest,
  listSessions,
  type PutRawInput,
  type PutRawResult,
  putRaw,
  recordNormalized,
  type StoredTrace,
  type TombstoneInput,
  tombstone,
  type WriteContext,
} from "./ingest";
export { DEFAULT_LIMITS, type Limits } from "./limits";
export { type ConnectOptions, connect, type StoreClientOptions, StoreSessionDB } from "./local";
export { normalizeTranscript } from "./normalize";
export {
  type SessionOptions,
  type SessionUpload,
  type StoreSessionResult,
  storeSession,
} from "./session";
export { DEFAULT_FILTER, type FilterRules, isTrivialTrajectory } from "./worthiness";
