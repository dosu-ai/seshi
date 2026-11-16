import { createHash, randomUUID } from "node:crypto";
import {
  type Caller,
  type Claims,
  ENVELOPE_SCHEMA,
  type Envelope,
  type LogPayload,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type OwnerBasis,
  SessionRejected,
  type SessionUpload,
  type SourceKind,
  type SpanPayload,
  UPLOAD_SOURCE,
  type Writer,
} from "@seshi/model";
import { assertOwner } from "@seshi/store";

export type LogEnvelope = Envelope & { payload: LogPayload };
export type SpanEnvelope = Envelope & { payload: SpanPayload };

const SOURCE_KINDS: ReadonlySet<string> = new Set<SourceKind>([
  "upload",
  "hook",
  "otlp",
  "datadog",
  "s3",
  "cursor-cloud",
]);
const CALLER_KINDS: ReadonlySet<string> = new Set([
  "person",
  "device",
  "service",
  "admin",
  "static",
  "local",
]);
const OWNER_BASES: ReadonlySet<string> = new Set(["verified", "claimed", "service"]);
const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ANSWERED: ReadonlySet<SourceKind> = new Set<SourceKind>(["upload", "hook"]);

export function hasCaller(envelope: Pick<Envelope, "source">): boolean {
  return ANSWERED.has(envelope.source);
}

export function isLogEnvelope(envelope: Envelope): envelope is LogEnvelope {
  return envelope.payload.kind === "log";
}

export function writerOf(envelope: Pick<Envelope, "caller" | "source_id">): Writer {
  const { caller } = envelope;
  return {
    kind: caller.kind,
    principal: caller.principal,
    ...(caller.credential_id ? { credential_id: caller.credential_id } : {}),
    source_id: envelope.source_id,
  };
}

function refuse(message: string): never {
  throw new SessionRejected("bad_envelope", message);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") refuse(`${field} must be a non-empty string`);
  return value;
}

/** Check what the schema requires of an envelope that matters to the pipeline, so an
 * integration's malformed envelope is refused (`bad_envelope`, permanent) rather than written. */
export function checkEnvelope(envelope: Envelope): void {
  if (typeof envelope !== "object" || envelope === null) refuse("an envelope is an object");
  if (envelope.schema !== ENVELOPE_SCHEMA) refuse(`schema must be ${ENVELOPE_SCHEMA}`);
  if (!SOURCE_KINDS.has(envelope.source)) refuse(`unknown source ${String(envelope.source)}`);
  if (!SOURCE_ID.test(nonEmpty(envelope.source_id, "source_id"))) {
    refuse("source_id must be words of a-z and 0-9 joined by -");
  }
  nonEmpty(envelope.format, "format");
  nonEmpty(envelope.session_key, "session_key");
  if (nonEmpty(envelope.idempotency_key, "idempotency_key").length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    refuse(`idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  nonEmpty(envelope.received_at, "received_at");
  const owner = nonEmpty(envelope.owner, "owner");
  try {
    assertOwner(owner);
  } catch {
    refuse(`invalid owner ${JSON.stringify(owner)}`);
  }
  if (!OWNER_BASES.has(envelope.owner_basis))
    refuse("owner_basis must be verified, claimed or service");
  const caller = envelope.caller as Caller | undefined;
  if (typeof caller !== "object" || caller === null || !CALLER_KINDS.has(caller.kind)) {
    refuse("caller needs a kind");
  }
  nonEmpty(caller.principal, "caller.principal");
  if (
    envelope.retract_hash !== undefined &&
    !/^[0-9a-f]{64}$/.test(String(envelope.retract_hash))
  ) {
    refuse("retract_hash must be a sha256 in lowercase hex");
  }
  const payload = envelope.payload as LogPayload | SpanPayload | undefined;
  if (payload?.kind === "log") {
    if (typeof payload.text !== "string") refuse("payload.text must be a string");
    if (!Number.isInteger(payload.offset) || payload.offset < 0) {
      refuse("payload.offset must be a byte offset ≥ 0");
    }
    if (payload.encoding !== "jsonl" && payload.encoding !== "json") {
      refuse("payload.encoding must be jsonl or json");
    }
  } else if (payload?.kind === "spans") {
    if (!Array.isArray(payload.spans)) refuse("payload.spans must be an array");
  } else {
    refuse("payload.kind must be log or spans");
  }
}

export function uploadIdempotencyKey(sessionKey: string, offset: number, text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
  return `${sessionKey}@${offset}#${digest}`;
}

function freshRebuildKeySuffix(): string {
  return `#rebuild-${randomUUID()}`;
}

export interface UploadEnvelopeOptions {
  caller: Caller;
  owner_basis: OwnerBasis;
  /** `upload` (the CLI) or `hook` (capture); `upload` by default. */
  source?: "upload" | "hook";
  /** The source id the upload is filed under: `upload` (X6.4) by default. */
  source_id?: string;
  claims?: Claims;
  now?: () => Date;
}

export function uploadEnvelope(upload: SessionUpload, options: UploadEnvelopeOptions): LogEnvelope {
  const offset = upload.offset ?? 0;
  const envelope: LogEnvelope = {
    schema: ENVELOPE_SCHEMA,
    source: options.source ?? "upload",
    source_id: options.source_id ?? UPLOAD_SOURCE,
    format: upload.agent,
    session_key: upload.session_id,
    payload: { kind: "log", encoding: upload.format, text: upload.transcript, offset },
    caller: options.caller,
    owner: upload.owner,
    owner_basis: options.owner_basis,
    idempotency_key:
      upload.idempotency_key ??
      `${uploadIdempotencyKey(upload.session_id, offset, upload.transcript)}${upload.rebuild ? freshRebuildKeySuffix() : ""}`,
    received_at: (options.now ?? (() => new Date()))().toISOString(),
  };
  if (options.claims && Object.keys(options.claims).length > 0) envelope.claims = options.claims;
  if (upload.visibility) envelope.visibility = upload.visibility;
  if (upload.replace) envelope.replace = true;
  if (upload.rebuild) envelope.rebuild = true;
  if (upload.shipped) envelope.shipped = upload.shipped;
  if (upload.project !== undefined) envelope.project = upload.project;
  if (upload.branch !== undefined) envelope.branch = upload.branch;
  if (upload.parent_session_id !== undefined) envelope.parent_session_id = upload.parent_session_id;
  if (upload.fork_of !== undefined) envelope.fork_of = upload.fork_of;
  if (upload.retract_hash !== undefined) envelope.retract_hash = upload.retract_hash;
  return envelope;
}
