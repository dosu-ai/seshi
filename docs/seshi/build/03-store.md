# 03 · Store (X6.1, X6.2, X6.4, X6.5, X1.4)

Branch `seshi-03-store`, on `seshi-02-config`. The store gains conditional writes, the X6.4
objects as typed keys and accessors, the seshi layout marker with the deployment/org check, and
one canonical stored trace (`seshi/trace/1`) with Letta, OTLP and ATIF rendered on read. The
stored objects other languages read are JSON Schemas in `spec/schemas/`; ts/model's types are
generated from them. The per-bucket `letta`/`otlp` choice (`store.format`) is gone.

## What was built

- **Conditional writes (X6.5)**, `packages/ts/store/src/store.ts`. `Store.get` returns
  `{ body, etag } | null` (`getBytes(store, key)` for the bytes alone); `put` takes `ifMatch` /
  `ifNoneMatch: "*"` and returns `{ etag }`; `delete` takes `ifMatch`. A failed condition throws
  `PreconditionFailed` (a `StoreError`). `updateObject(store, key, step, { retries })` is the
  read-modify-write loop with jittered backoff; `json.ts` adds `readJson` (value + etag),
  `createJson`, `replaceJson`, `putJson`, `updateJson`.
  - **S3/R2** (`s3.ts`, `s3-fetch.ts`): `If-Match` (quoted) / `If-None-Match` on PUT, `If-Match`
    on DELETE; 412, S3's 409 `ConditionalRequestConflict`, and S3's 404 `NoSuchKey` on an
    If-Match PUT (the version read is gone) map to `PreconditionFailed`. ETags come from GET
    and PUT responses, unquoted.
  - **Folder** (`fs.ts`): a lock file per key (`<path>.~lock`, created with `open(…, "wx")`,
    holding a random token) around every put and delete; the condition is checked under the
    lock. A lock older than 10 s is taken over by renaming it aside (atomic, so only one writer
    takes it; a lock that turns out fresh is put back), and a writer releases only a lock that
    still holds its token. ETag = MD5 of the bytes, like S3's single-part ETag, so `stat` now
    reads the file. Lock and temp files are never listed and are refused as keys. Tested with
    four processes incrementing one object.
- **Layout additions (X6.4)**, `layout.ts` `keys`: `marker`, `token(id)`, `checkpoint(src)`,
  `records(kind, src)` / `record(kind, src, at, idempotencyKey)`, `heartbeat`, `pending(archive)`,
  `spans` / `span(owner, archive, traceId, spanId)`, `reviews` / `review(owner, archive, n)`
  (zero-padded to 8 digits), `change(owner, at, kind, hash)`. Every caller-supplied segment is
  validated (owner, source id as config's regex, token id, 64-hex archive ids and hashes, hex
  span ids). `stampTime` reads a key's stamp back.
  - `objects.ts`: token records (`createToken` If-None-Match, `readToken`, `updateToken`,
    `listTokens`), checkpoints (`readCheckpoint`, `writeCheckpoint(store, src, cursor, etag |
    null)`), heartbeat (`readHeartbeat`, `writeHeartbeat`, last writer wins), pending markers
    (`touchPending`, `readPending`, `listPending`, `clearPending` with If-Match; each touch
    carries a random `touch` id so it always changes the ETag), review
    decisions (`writeReview` If-None-Match, `listReviews`). Code-first types, as X3.10 allows
    for binary-only objects.
  - `records.ts`: drop and failure records with the shared base (`at`, `source`,
    `source_kind`, `owner`, `session_key`, `idempotency_key`, `provenance`) plus their own
    fields; `writeDropped`, `writeFailed`, `listRecords` (cursor or `since`), `countRecords`,
    `pruneRecords(store, kind, src, { retentionMs, now })` (default
    `DEFAULT_RECORD_RETENTION_MS` = 30 d = config's `[records]` default, cross-checked in
    `tests/store/retention.test.ts`), `sourcesWithRecords`.
- **Layout marker (X1.4)**, `marker.ts`: `seshi.json`, `seshi/layout/1`, with `trace_schema`,
  `deployment_id`, `org`, `created_at`, `created_by`. `ensureLayout(store, { createdBy,
  deploymentId, org })` creates it with If-None-Match (a generated UUID when no deployment id
  is configured), refuses another deployment or org (`LayoutError`), records the org the first
  time a config names one (If-Match), and refuses an unknown marker schema or trace format.
  `readLayout` is the reader's check. `seshi serve` runs it at boot with `store.deployment_id` /
  `store.org`, so a mismatch exits 1 (`seshi: cannot use <url>: …`); the banner names the
  deployment.
- **Legacy prefixes**: a prefix holding `sessionstorage.json` (`sessionstorage/layout/1`) is
  refused with a message pointing at a new prefix (X1.5: no migration). Ingest refuses it too,
  before writing anything.
- **Canonical trace (X6.2)** `seshi/trace/1`: trajectory-v1 records plus optional `id`,
  `llm_call` (non-meta), `withheld`, `duration_ms` (tool results), `agent_version` (meta); the
  trace adds `llm_calls` (`id`, `model`, `provider`, times, `duration_ms`, `usage` with
  input/output/cache/reasoning/total tokens, `stop_reason`, `request_id`, `parameters`,
  `error`) and `provenance` (`source`, `source_id`, `format`, `location {object_key, etag,
  cursor}`). `parseTrace` (was `parseTrajectory`) validates with `validateTraceRecords`, checks
  each LLM call field by field (unknown fields dropped, as from records; wrong types refused),
  unique call ids and `llm_call` refs; events and `content_hash` derive from role/text/tool fields
  only, so every golden hash is unchanged (`bun run goldens` leaves the tree clean).
- **Renderers** (`packages/ts/formats/src/render/`): `toLetta` (the `sessionstorage/trace/1`
  object, plain records, same keys and order sessiondb wrote), `toOtlp` (now over the canonical
  trace: LLM call model/provider/response id/`gen_ai.usage.*` on the call's first chat span,
  call times when known, error status; attributes and resource now `seshi.*`, schema
  `seshi/trace-otlp/1`, lossless incl. `llm_calls` and `provenance`; `fromOtlp` returns the
  canonical trace), `toAtif` (ATIF-v1.7; usage as step `metrics` and `final_metrics`; reads
  back through `ATIF_FORMAT` to the same content hash), `renderTrace(trace, format)`.
- **Metadata (`seshi/metadata/1`)** adds `writer` (original writer), `owner_basis`,
  `visibility`, `claims` (fixed allowlist, merged), `redaction` (rule-set hash + counts, summed),
  `provenance` (latest write), `origin_agent`, `native_session_id`, `normalizer`, and reserved
  `retract_hash`. **Change entries (`seshi/change/1`)** add `writer` (required), `reason`
  (`deleted` / `retracted` / `redacted` on tombstones), `visibility`, and the kind
  `visibility_changed` (key suffix `visibility`).
- **Pipeline** writes through all of this: `ingest`, `putRaw`, `recordNormalized` and
  `tombstone` update `metadata.json` with `updateMetadata` (If-Match + retry; tested with
  concurrent ingests on one session). Trace objects are created with If-None-Match
  (`publishObject` immutable mode), so of two writers racing on one content hash the first
  object wins. `tombstone` marks the session redacted before deleting its objects, and an
  ingest or raw part that lands in between deletes the object it just created; `WriteContext { writer, owner_basis, visibility,
  claims, provenance }` on `IngestInput`, `PutRawInput` and `SessionOptions.context`;
  `IngestInput` also takes `llm_calls`, `redaction`, `origin_agent`, `native_session_id`;
  `tombstone` takes `reason` and `writer`. `getTrace(store, owner, archive, hash)` returns the
  canonical trace. Defaults: writer `localWriter(owner)` (`local`, source `upload`),
  `verified`, `org`.
- **API/client**: `GET …/trace?format=seshi|letta|otlp|atif` (default `seshi`, 400 otherwise);
  `SessionDB.getTrace(agent, id, hash?, format?)` on both backends; `/v1/me` drops `format` and
  no longer touches the store. The server records writers as `static` (config tokens) or
  `legacy` (HS256 tokens). Marker client is `seshi/<version>`.
- **Contract (X3.10)**: `spec/schemas/{common,trace,metadata,change,envelope,layout}.schema.json`
  (2020-12; `$id` = file name; cross-file `$ref`s into `common`). The envelope schema is X4.1's
  fields (payload as a `log` or `spans` union) for 04 to fill. `scripts/model-types.ts`
  generates `packages/ts/model/src/generated/*.ts` (interfaces, unions, doc comments,
  `SCHEMA_ID` per object; Biome-formatted); `bun run types` writes, `bun run check:types`
  (part of `bun run check`) fails on a stale or leftover file. `spec/openapi.yaml` now
  `$ref`s the schemas for `SessionMetadata`, `Trace` and `ChangeEntry` and documents the render
  formats. `spec/testdata/objects/` holds conformance objects; `tests/spec/schemas.test.ts`
  validates them and live pipeline output with ajv, and re-derives the example trace's hash.
- **Docs**: `spec/layout.md` rewritten for the seshi layout; README trace-format section,
  docs/server.md, docs/config.md (`deployment_id`, `org`), `.env.example` updated.

## Extension points for later branches

- **Mutable objects**: never `put` one plainly. Use `updateJson` / `updateMetadata` (pure
  `step`, may run more than once; return null for no change), or `createJson` / `replaceJson`
  with an ETag from `readJson`. Catch `PreconditionFailed` (`isPreconditionFailed`) where a
  lost race should abandon the work (checkpoints, X7.3).
- **04 (pipeline)**: `Envelope` / `LogPayload` / `SpanPayload` / `Caller` are generated in
  `@seshi/model` (`ENVELOPE_SCHEMA`); extend `spec/schemas/envelope.schema.json` and run `bun
  run types` rather than hand-writing a type. Pass the caller as `WriteContext` (writer,
  owner_basis, visibility, claims, provenance). Write drop and failure records with
  `writeDropped` / `writeFailed`; prune with `pruneRecords` and `config.records.*`. Dropping
  raw means removing `putRaw`, `raw`/`raw_format` from the metadata schema and the raw key.
  Adapters can now return what raw used to keep: put `llm_call`/`id`/`duration_ms` on records
  and pass `llm_calls` to `ingest` (the `FormatAdapter` contract still returns records only;
  extend it, not the trace).
- **05 (auth)**: token records are `TokenRecord` in `@seshi/store` (`[key: string]: unknown`
  for extra fields); refine the shape there. Writer kinds are `CallerKind` in
  `spec/schemas/common.schema.json`; owner ids with `@`/`+`/`svc:` (X5.8) need `assertOwner`
  in `layout.ts` (and the schema description) widened.
- **06 (instance)**: call `ensureLayout(store, { createdBy, deploymentId, org })` once when an
  Instance is built (serve does it today); heartbeat via `writeHeartbeat`.
- **08 (review)**: `writeReview` / `listReviews`, `ReviewRecord`; drops via `writeDropped`.
- **09 (OTLP)**: span records at `keys.span(...)`; pending markers via `touchPending` /
  `listPending` / `clearPending(etag)`; the assembled trace is a canonical trace with
  `llm_calls` and `provenance`.
- **10/11 (pollers)**: `readCheckpoint` / `writeCheckpoint(…, etag)`.
- **12 (search)**: read canonical traces; `metadata.visibility`, `origin_agent`,
  `native_session_id` are in place; `visibility_changed` entries are in the change kind enum.
- **A new stored object others read**: add `spec/schemas/<name>.schema.json` (`$id` = file
  name), `bun run types`, re-export from `@seshi/model`, add an example to
  `spec/testdata/objects/` (named `<name>.<case>.json`; the conformance test picks it up).

## Deviations and why

- **`Bun.S3Client` is no longer used.** It cannot send `If-Match` / `If-None-Match`. `S3Store`
  always uses the signed-`fetch` client (already used on Node and tested), on every runtime.
  Credentials resolve from an explicit `env` (openStore passes it) or `process.env`, as before;
  a missing key now fails when the store is opened rather than on the first request.
- **Raw is still written.** X6.3 is 04's; `raw`, `raw_format` stay required in the metadata
  schema and are marked transitional.
- **Legacy prefixes are refused**, not read: no migration (X1.5). The message says to use a new
  prefix.
- **The org is recorded on first sight.** A marker without an org takes the first configured
  one (If-Match); a deployment id is generated when none is configured, and any id is accepted
  when the config names none. Kept small, as X1.4 asks.
- **`GET …/trace` defaults to `seshi`**, the stored format, not `letta`. A reader that expects
  `sessionstorage/trace/1` must pass `?format=letta`.
- **OTLP rendering attributes renamed** `sessiondb.*` → `seshi.*`, `service.name`/scope
  `seshi`, schema `seshi/trace-otlp/1`, since it is now an on-read export of a different
  object (records carry seshi fields). The normalizer name stays `@dosu/sessiondb`.
- **Review files are zero-padded** (`review/00000003.json`) so listings are in order.
- **Drop/failure record keys** are `<stamp>-<sha256(idempotency_key)[:24]>.json`: time order
  for listing and retention, no raw keys or ids in object names. The same envelope recorded at
  another millisecond is a second record.
- **`metadata.writer` is the original writer** (X4.6 needs it); each write's own writer is on
  its change entry.
- **Static and legacy tokens count as `verified`** owner basis: the operator bound the owner.
- **Generated types come from a small in-repo generator** (`scripts/model-types.ts`) rather than
  a dependency: it covers exactly the JSON Schema subset the contract uses and fails loudly on
  anything else.

## Still to check

- **Conditional DELETE support**: which S3-compatible backends honour `If-Match` on DELETE
  (used by `clearPending`) is unverified; one that ignores it deletes unconditionally. Also
  still to check from X6.5: MinIO, Backblaze, Wasabi on conditional PUT. Trace objects are
  now created with If-None-Match too; a backend that ignores it falls back to the old
  last-writer-wins on a content-hash race. Whether AWS answers a conditional DELETE of a
  missing key with 404 (treated as done) or 412 is also unverified.
- The live S3 test (`tests/store/s3-live.test.ts`) gained a conditional-write case but was not
  run (no endpoint here); CI runs it.
- No adapter fills `llm_calls`, record ids or durations yet; the format and pipeline carry them
  (tests feed them directly). Claude Code's usage, Codex token counts and OTLP spans are the
  first candidates.
- Dosu's backend reads the bucket directly: it must accept `seshi/trace/1` objects (a superset
  of the letta object with a new schema id) or read through the API with `?format=letta`.
- `metadata.redaction` is filled only when a caller passes counts; 07 computes rule-set hashes
  and counts.
- The `assembly/pending`, `tokens/`, `sources/` and `worker/` folders are written only by
  tests until their branches use them.
