/** `storeSession`: one upload through the pipeline, as the session API takes it. The upload is
 * turned into the envelope it stands for (`uploadEnvelope`, source id `upload`) and submitted to
 * a `Pipeline` built from the options; nothing here knows about HTTP. The HTTP route and local
 * mode go through `StoreSessionDB`, which does the same with one pipeline it keeps. */

import type { FormatRegistry } from "@seshi/formats";
import {
  localWriter,
  OffsetMismatch,
  SessionRejected,
  type SessionUpload,
  type StoreSessionResult,
} from "@seshi/model";
import type { RedactionRules, Redactor } from "@seshi/redact";
import type { Store } from "@seshi/store";
import { uploadEnvelope } from "./envelope";
import type { FilterSetting } from "./filter";
import type { WriteContext } from "./ingest";
import type { Limits } from "./limits";
import { Pipeline } from "./pipeline";
import type { Authorizer, HealthCounters, Reviewer } from "./stages";

export { OffsetMismatch, SessionRejected, type SessionUpload, type StoreSessionResult };

export interface SessionOptions {
  store: Store;
  /** The transcript formats this deployment reads: `apps/seshi` builds it from its integration
   * registry. */
  formats: FormatRegistry;
  /** Identifies the writer in the layout marker. */
  client?: string;
  now?: () => Date;
  /** The operator's own redaction (`redactionRules`); the built-in rules when omitted. Either
   * way the built-ins apply. */
  redaction?: RedactionRules;
  /** The redaction stage itself, in place of `redaction`. */
  redactor?: Redactor;
  /** Who writes and on what basis; the owner through the upload route when omitted. */
  context?: Pick<WriteContext, "writer" | "owner_basis">;
  /** The session filter (X4.10), config's `[filter]` or the rules per source; `DEFAULT_FILTER`
   * when omitted. It judges a session's first trace only. */
  filter?: FilterSetting;
  /** Size caps, config's `[limits]`; `DEFAULT_LIMITS` when omitted. */
  limits?: Readonly<Limits>;
  authorizer?: Authorizer;
  reviewer?: Reviewer;
  health?: HealthCounters;
}

/** Store one upload, whole or a chunk from `offset`. Throws `SessionRejected` (422),
 * `OffsetMismatch` (409 with `expected`), `SessionConflict` (409) or `Forbidden` (403); nothing
 * is stored when it does. */
export async function storeSession(
  upload: SessionUpload,
  options: SessionOptions,
): Promise<StoreSessionResult> {
  const writer = options.context?.writer ?? localWriter(upload.owner);
  const envelope = uploadEnvelope(upload, {
    caller: {
      kind: writer.kind,
      principal: writer.principal,
      ...(writer.credential_id ? { credential_id: writer.credential_id } : {}),
    },
    owner_basis: options.context?.owner_basis ?? "verified",
    now: options.now,
  });
  const pipeline = new Pipeline(options);
  return (await pipeline.submit(envelope, { onFailure: "throw" })) as StoreSessionResult;
}
